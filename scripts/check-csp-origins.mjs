/* Verifies that every external origin the built pages actually load is
   allowed by the Content-Security-Policy in vercel.json.

   Grepping the HTML for "https://" is NOT enough, and trusting that is how
   the PRO AI module shipped broken once: several modules are embedded as
   Base64 constants (the PRO AI iframe in MERGED_PRO_HTML_B64, every ERP
   feature module), so their <script src> and <link href> targets are
   invisible to a text search over the built file. A blocked origin fails
   silently in production — the module renders unstyled or half-dead with
   nothing but a console line — so decode every payload (recursively, since
   payloads nest) and check the real list.

   Run by `npm run check`. Add a new CDN to vercel.json when this fails. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const PAGES = ['public/index.html', 'public/erp.html', 'public/login.html', 'public/admin.html'];

const decoded = new Set();
const findings = new Map(); // origin -> Set("directive @ location")

function note(origin, directive, where) {
  if (!findings.has(origin)) findings.set(origin, new Set());
  findings.get(origin).add(`${directive} @ ${where}`);
}

function scan(text, where, depth) {
  if (depth > 6) return; // payloads nest, but not that far

  const patterns = [
    [/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, 'script-src'],
    [/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, 'style-src'],
    [/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, 'frame-src'],
    [/\bfetch\s*\(\s*["'`](https?:\/\/[^"'`]+)/gi, 'connect-src'],
    [/\bnew\s+WebSocket\s*\(\s*["'`](wss?:\/\/[^"'`]+)/gi, 'connect-src'],
    [/\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["'](https?:\/\/[^"']+)/gi, 'connect-src'],
    [/@import\s+url\(\s*["']?(https?:\/\/[^"')]+)/gi, 'style-src']
  ];
  for (const [regex, directive] of patterns) {
    for (const match of text.matchAll(regex)) {
      if (!/^(https?:|wss?:)\/\//i.test(match[1])) continue;
      try { note(new URL(match[1]).origin, directive, where); } catch (_) { /* unparseable URL */ }
    }
  }

  for (const match of text.matchAll(/const\s+([A-Za-z0-9_]*B64[A-Za-z0-9_]*)\s*=\s*"([A-Za-z0-9+/=]{500,})"/g)) {
    const [, name, payload] = match;
    const fingerprint = `${name}:${payload.length}`;
    if (decoded.has(fingerprint)) continue;
    decoded.add(fingerprint);
    let content;
    try { content = Buffer.from(payload, 'base64').toString('utf8'); } catch (_) { continue; }
    if (!/<(!doctype|html|head|script|style|div)\b/i.test(content)) continue; // e.g. the demo .xlsx
    scan(content, `${where} > ${name}`, depth + 1);
  }
}

for (const page of PAGES) scan(readFileSync(resolve(root, page), 'utf8'), page, 0);

const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const policy = config.headers
  .flatMap((entry) => entry.headers)
  .find((header) => header.key === 'Content-Security-Policy');
if (!policy) throw new Error('vercel.json has no Content-Security-Policy header.');

const missing = [...findings.keys()].sort().filter((origin) => !policy.value.includes(origin));
if (missing.length) {
  for (const origin of missing) {
    console.error(`CSP does not allow ${origin}`);
    for (const use of findings.get(origin)) console.error(`    used as ${use}`);
  }
  throw new Error(`${missing.length} external origin(s) would be blocked in production; add them to the CSP in vercel.json.`);
}

console.log(JSON.stringify({
  event: 'csp_origins_ok',
  payloadsDecoded: decoded.size,
  originsChecked: findings.size,
  origins: [...findings.keys()].sort()
}));
