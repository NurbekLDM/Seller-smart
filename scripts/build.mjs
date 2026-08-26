/* Builds public/index.html from src/app.html:
   1. removes the legacy VPS-server sync block (talked to /api/v1 on Node),
   2. injects the Supabase auth guard into <head> so unauthenticated visitors
      are redirected before the app initializes,
   3. injects the Supabase sync engine before </body>.
   Injection uses markers, so the build is idempotent. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFile = resolve(root, 'src/app.html');
const outputFile = resolve(root, 'public/index.html');

if (!existsSync(sourceFile)) throw new Error(`Build source is missing: ${sourceFile}`);

const HEAD_BEGIN = '<!-- SR_SUPABASE_AUTH_BEGIN -->';
const HEAD_END = '<!-- SR_SUPABASE_AUTH_END -->';
const BODY_BEGIN = '<!-- SR_SUPABASE_SYNC_BEGIN -->';
const BODY_END = '<!-- SR_SUPABASE_SYNC_END -->';
const SPLASH_BEGIN = '<!-- SR_BOOT_SPLASH_BEGIN -->';
const SPLASH_END = '<!-- SR_BOOT_SPLASH_END -->';

function removeBlock(source, start, finish) {
  const beginning = source.indexOf(start);
  if (beginning < 0) return source;
  const ending = source.indexOf(finish, beginning);
  if (ending < 0) throw new Error(`Block ${start} is missing its closing marker.`);
  return source.slice(0, beginning).replace(/\n+$/, '\n') + source.slice(ending + finish.length).replace(/^\n+/, '');
}

let html = readFileSync(sourceFile, 'utf8');

// Drop the legacy Node-server sync (it targets /api/v1, which no longer exists).
html = removeBlock(html, '<!-- SMART_RETAIL_PARENT_SYNC_21_BEGIN -->', '<!-- SMART_RETAIL_PARENT_SYNC_21_END -->');

// Idempotency: strip previous injections before re-injecting.
html = removeBlock(html, HEAD_BEGIN, HEAD_END);
html = removeBlock(html, BODY_BEGIN, BODY_END);
html = removeBlock(html, SPLASH_BEGIN, SPLASH_END);

const headMatch = html.match(/<head[^>]*>/i);
if (!headMatch) throw new Error('HTML source is missing a <head> tag.');
const headBlock = `\n${HEAD_BEGIN}\n` +
  '<script src="assets/app-config.js"></script>\n' +
  '<script src="assets/vendor/supabase.js"></script>\n' +
  '<script src="assets/auth-guard.js"></script>\n' +
  `${HEAD_END}\n`;
const headIndex = headMatch.index + headMatch[0].length;
html = html.slice(0, headIndex) + headBlock + html.slice(headIndex);

// Boot splash: painted as the first body element, so the user sees a
// spinner while the multi-megabyte app parses instead of a dark screen.
// Hidden (with a fade) once the app has initialized at DOMContentLoaded.
const bodyMatch = html.match(/<body[^>]*>/i);
if (!bodyMatch) throw new Error('HTML source is missing a <body> tag.');
const splashBlock = `\n${SPLASH_BEGIN}\n` +
  '<div id="srBootSplash" style="position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#091120;transition:opacity .35s ease">' +
  '<div style="text-align:center;color:#8ea0bd;font:600 14px -apple-system,\'Segoe UI\',sans-serif">' +
  '<div style="width:46px;height:46px;margin:0 auto 14px;border-radius:50%;border:3px solid rgba(120,110,255,.25);border-top-color:#786eff;animation:srSpin 1s linear infinite"></div>' +
  'Yuklanmoqda...</div></div>\n' +
  '<style>@keyframes srSpin{to{transform:rotate(360deg)}}</style>\n' +
  '<script>(function(){var hidden=false;function hide(){if(hidden)return;hidden=true;var s=document.getElementById("srBootSplash");if(!s)return;s.style.opacity="0";window.setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s);},400);}\n' +
  'if(document.readyState!=="loading"){window.setTimeout(hide,50);}else{document.addEventListener("DOMContentLoaded",function(){window.setTimeout(hide,50);});}\n' +
  'window.setTimeout(hide,20000);})();</script>\n' +
  `${SPLASH_END}\n`;
const bodyIndex = bodyMatch.index + bodyMatch[0].length;
html = html.slice(0, bodyIndex) + splashBlock + html.slice(bodyIndex);

const closingBody = html.toLowerCase().lastIndexOf('</body>');
if (closingBody < 0) throw new Error('HTML source is missing its closing </body> tag.');
const bodyBlock = `\n${BODY_BEGIN}\n<script src="assets/supabase-sync.js"></script>\n${BODY_END}\n`;
html = html.slice(0, closingBody).replace(/\n+$/, '\n') + bodyBlock + html.slice(closingBody);

writeFileSync(outputFile, html);
console.log(JSON.stringify({
  event: 'build_complete',
  output: 'public/index.html',
  bytes: Buffer.byteLength(html),
  legacySyncRemoved: !html.includes('SMART_RETAIL_PARENT_SYNC_21_BEGIN'),
  authInjected: html.includes(HEAD_BEGIN),
  syncInjected: html.includes(BODY_BEGIN)
}));
