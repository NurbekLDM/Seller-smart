/* Self-hosted replacement for Vercel: one dependency-free Node process that
   serves exactly what the Vercel project served.

     - public/ as static files, with the headers and redirects declared in
       vercel.json (read from that file, so the two cannot drift apart);
     - middleware.js as the server-side login gate, imported as-is: it is
       written against the Web Request/Response API, which Node has natively;
     - api/staff.js and api/admin/users.js, imported as-is, behind a small
       shim for the req/res helpers Vercel adds (req.body, res.status().json());
     - /assets/app-config.js generated from the environment, so the same
       checkout can point at any Supabase instance without editing a file.

   The Supabase API itself is NOT proxied here: Caddy sends /auth/v1,
   /rest/v1 and /realtime/v1 straight to the Supabase gateway (see
   deploy/Caddyfile). This process only ever talks to Supabase server-side.

   Environment:
     PORT                       listen port (default 3000)
     SUPABASE_URL               Supabase URL as THIS server reaches it, e.g.
                                http://api-gw:8000 inside docker compose
     SUPABASE_ANON_KEY          anon key (validates callers' sessions)
     SUPABASE_SERVICE_ROLE_KEY  service-role key (admin + staff APIs)
     PUBLIC_SUPABASE_URL        Supabase URL as the BROWSER reaches it, e.g.
                                https://sellersmart.uz (same origin as the app)
     SUPABASE_PUBLIC_KEY        key the browser uses (default SUPABASE_ANON_KEY)
     STAFF_EMAIL_DOMAIN         optional, default staff.sellersmart.uz
     ERP119_HOST                optional, e.g. erp.sellersmart.uz: serve
                                ERP 119.3 with server storage on that host
                                (server/erp119.mjs) */

import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1024 * 1024; // the APIs take small JSON commands, nothing more

const env = (name) => String(process.env[name] || '').trim();

/* The handlers read process.env when their module is first evaluated, so
   they are imported only after the environment is final (below), and
   middleware.js reads it per request. Trimmed here once for all of them:
   a value pasted with a stray newline is invisible but breaks every call. */
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'STAFF_EMAIL_DOMAIN']) {
  if (process.env[name] !== undefined) process.env[name] = env(name);
}

const PUBLIC_SUPABASE_URL = env('PUBLIC_SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_PUBLIC_KEY = env('SUPABASE_PUBLIC_KEY') || env('SUPABASE_ANON_KEY');
const STAFF_EMAIL_DOMAIN = env('STAFF_EMAIL_DOMAIN') || 'staff.sellersmart.uz';

const { default: middleware, config: middlewareConfig } = await import(pathToFileURL(join(ROOT, 'middleware.js')).href);
const API_ROUTES = new Map([
  ['/api/staff', (await import(pathToFileURL(join(ROOT, 'api/staff.js')).href)).default],
  ['/api/admin/users', (await import(pathToFileURL(join(ROOT, 'api/admin/users.js')).href)).default]
]);
const GATED_PATHS = new Set(middlewareConfig.matcher);
const { createErp119 } = await import(pathToFileURL(join(ROOT, 'server/erp119.mjs')).href);

/* ----------------------------------------------------------- vercel.json */

const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

// The sources in vercel.json are plain regex groups ("/(.*)",
// "/assets/(.*)", "/(index.html|...|)"), so they compile directly.
const compile = (source) => new RegExp(`^${source}$`);

const REDIRECTS = (vercel.redirects || []).map((rule) => ({
  test: compile(rule.source),
  destination: rule.destination,
  status: rule.permanent ? 308 : 307
}));

/* The CSP names the Supabase project host in connect-src. Swap whatever
   *.supabase.co host vercel.json carries for the instance this server is
   configured with, in both the https and wss forms Realtime needs. */
function rewriteCsp(value) {
  if (!PUBLIC_SUPABASE_URL) return value;
  const origin = new URL(PUBLIC_SUPABASE_URL);
  const httpOrigin = origin.origin;
  const wsOrigin = `${origin.protocol === 'http:' ? 'ws' : 'wss'}://${origin.host}`;
  let replaced = false;
  const next = value
    .replace(/https:\/\/[a-z0-9-]+\.supabase\.co\b/g, () => { replaced = true; return httpOrigin; })
    .replace(/wss:\/\/[a-z0-9-]+\.supabase\.co\b/g, () => wsOrigin);
  if (replaced) return next;
  return value.replace(/connect-src ([^;]*)/, (_, list) => `connect-src ${list} ${httpOrigin} ${wsOrigin}`);
}

const HEADER_RULES = (vercel.headers || []).map((rule) => ({
  test: compile(rule.source),
  headers: rule.headers.map(({ key, value }) => [
    key,
    key.toLowerCase() === 'content-security-policy' ? rewriteCsp(value) : value
  ])
}));

function headersFor(pathname, secure) {
  const out = {};
  for (const rule of HEADER_RULES) {
    if (!rule.test.test(pathname)) continue;
    for (const [key, value] of rule.headers) out[key.toLowerCase()] = value;
  }
  // HSTS over plain http (local testing) would pin the host to https.
  if (!secure) delete out['strict-transport-security'];
  return out;
}

/* ---------------------------------------------------------------- static */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
};

function appConfigScript() {
  return `/* Generated by server/index.mjs from the environment. */
window.SMART_RETAIL_CONFIG = ${JSON.stringify({
    supabaseUrl: PUBLIC_SUPABASE_URL,
    supabaseAnonKey: SUPABASE_PUBLIC_KEY,
    staffEmailDomain: STAFF_EMAIL_DOMAIN
  }, null, 2)};
`;
}

async function resolveFile(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = normalize(join(PUBLIC_DIR, relative));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return null;
  try {
    const info = await stat(full);
    return info.isFile() ? { full, info } : null;
  } catch (_) {
    return null;
  }
}

async function serveStatic(req, res, pathname, baseHeaders) {
  if (pathname === '/assets/app-config.js' && PUBLIC_SUPABASE_URL) {
    const body = appConfigScript();
    res.writeHead(200, { ...baseHeaders, 'content-type': TYPES['.js'], 'content-length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  const file = await resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  const etag = `W/"${file.info.size.toString(16)}-${Math.floor(file.info.mtimeMs).toString(16)}"`;
  const headers = {
    ...baseHeaders,
    'content-type': TYPES[extname(file.full).toLowerCase()] || 'application/octet-stream',
    etag,
    'last-modified': file.info.mtime.toUTCString()
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = file.info.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file.full).on('error', () => res.destroy()).pipe(res);
}

/* ------------------------------------------------------------ middleware */

function requestUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return new URL(req.url, `${proto}://${host}`);
}

async function runMiddleware(req, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return middleware(new Request(url, { method: req.method, headers }));
}

async function sendWebResponse(res, response, baseHeaders) {
  const headers = { ...baseHeaders };
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/* ------------------------------------------------------------------- api */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The subset of Vercel's helpers the two handlers use.
function vercelResponse(res, baseHeaders) {
  for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    const body = JSON.stringify(payload);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(body);
    return res;
  };
  res.send = (payload) => {
    if (payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) return res.json(payload);
    res.end(payload);
    return res;
  };
  return res;
}

async function serveApi(req, res, handler, url, baseHeaders) {
  const api = vercelResponse(res, { ...baseHeaders, 'cache-control': 'no-store' });
  let raw = '';
  try {
    raw = await readBody(req);
  } catch (error) {
    return api.status(error.status || 400).json({ error: error.message });
  }
  const type = String(req.headers['content-type'] || '');
  if (raw && type.includes('application/json')) {
    try { req.body = JSON.parse(raw); } catch (_) { return api.status(400).json({ error: 'Invalid JSON body.' }); }
  } else {
    req.body = raw || undefined;
  }
  req.query = Object.fromEntries(url.searchParams);
  await handler(req, api);
}

/* ---------------------------------------------------------------- erp119 */

// ERP 119.3 on its own host (see server/erp119.mjs); null when ERP119_HOST
// is not set.
const erp119 = createErp119({
  root: ROOT,
  publicDir: PUBLIC_DIR,
  env: process.env,
  async gate(req, res, url, headers) {
    const response = await runMiddleware(req, url);
    if (!response) return false;
    await sendWebResponse(res, response, headers);
    return true;
  }
});

/* ---------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  let url;
  try {
    url = requestUrl(req);
  } catch (_) {
    res.writeHead(400);
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end();
  }
  const secure = url.protocol === 'https:';

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('ok');
    }

    if (erp119 && erp119.matches(url)) return await erp119.handle(req, res, url, pathname);

    const baseHeaders = headersFor(pathname, secure);

    const redirect = REDIRECTS.find((rule) => rule.test.test(pathname));
    if (redirect) {
      res.writeHead(redirect.status, { ...baseHeaders, location: redirect.destination + url.search });
      return res.end();
    }

    const handler = API_ROUTES.get(pathname.replace(/\/+$/, ''));
    if (handler) return await serveApi(req, res, handler, url, baseHeaders);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...baseHeaders, allow: 'GET, HEAD' });
      return res.end();
    }

    if (GATED_PATHS.has(pathname)) {
      const gate = await runMiddleware(req, url);
      if (gate) return await sendWebResponse(res, gate, baseHeaders);
    }

    return await serveStatic(req, res, pathname, baseHeaders);
  } catch (error) {
    console.error('sr-server: request failed', JSON.stringify({
      method: req.method, path: pathname, error: String(error && error.stack || error)
    }));
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({
    event: 'sr-server: listening',
    port: PORT,
    supabaseUrl: env('SUPABASE_URL') || null,
    publicSupabaseUrl: PUBLIC_SUPABASE_URL || null,
    serviceKey: Boolean(env('SUPABASE_SERVICE_ROLE_KEY')),
    erp119Host: erp119 ? erp119.host : null
  }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
