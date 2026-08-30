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
  '<script src="assets/analytics-windows.js"></script>\n' +
  '<script src="assets/proai-i18n.js"></script>\n' +
  '<script src="assets/version-check.js"></script>\n' +
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

/* The ERP 26 file-upload guard installs a MutationObserver that calls its
   scan() once per added node, and scan() falls back to a WHOLE-DOCUMENT
   querySelectorAll whenever the node it is handed has no querySelectorAll
   of its own — which is every text node. The ERP's first render adds
   thousands of text nodes, so the guard sweeps the entire (3 MB) document
   thousands of times and the main thread never comes back: the ERP simply
   never finishes loading, in the embedded frame and on the staff page
   alike. Confining that fallback to the explicit scan(document) call keeps
   the guard's behaviour and takes the load from "never" back to ~8s.
   Patched in the payload itself, before the ERP document is assembled, so
   the frame, the "open in a new window" popup and public/erp.html all get
   the fix from one place. Measured with headless Chrome: unpatched >120s
   (timeout), patched 8s. */
const FILE_GUARD_PAYLOAD = 'SMART_RETAIL_ERP_FILE_UPLOAD_GUARD_B64';
const FILE_GUARD_SLOW_SCAN = 'function scan(node){if(typeof document===\'undefined\')return;'
  + 'if(node&&node.nodeType===1&&node.matches?.(\'input[type="file"]\'))bindInput(node);'
  + '(node&&node.querySelectorAll?node:document).querySelectorAll?.(\'input[type="file"]\').forEach(bindInput);}';
const FILE_GUARD_SCOPED_SCAN = 'function scan(node){if(typeof document===\'undefined\')return;'
  + 'if(node&&node.nodeType===1&&node.matches?.(\'input[type="file"]\'))bindInput(node);'
  + 'const scope=node?(node.querySelectorAll?node:null):document;'
  + 'if(scope)scope.querySelectorAll(\'input[type="file"]\').forEach(bindInput);}';

function patchFileUploadGuard(appHtml) {
  const pattern = new RegExp(`const ${FILE_GUARD_PAYLOAD} = "([^"]*)"`);
  const match = appHtml.match(pattern);
  if (!match) return { html: appHtml, state: 'absent' };

  const guard = Buffer.from(match[1], 'base64').toString('utf8');
  if (!guard.includes(FILE_GUARD_SLOW_SCAN)) {
    // Nothing to patch is only safe if the pathological fallback is gone.
    if (guard.includes(':document).querySelectorAll')) {
      throw new Error(`${FILE_GUARD_PAYLOAD} still sweeps the whole document per mutation but no longer matches the known shape; re-check its scan() before shipping.`);
    }
    return { html: appHtml, state: 'unchanged' };
  }

  const patched = guard.replace(FILE_GUARD_SLOW_SCAN, FILE_GUARD_SCOPED_SCAN);
  const encoded = Buffer.from(patched, 'utf8').toString('base64');
  return {
    html: appHtml.replace(pattern, `const ${FILE_GUARD_PAYLOAD} = "${encoded}"`),
    state: 'patched'
  };
}

const fileGuard = patchFileUploadGuard(html);
html = fileGuard.html;

writeFileSync(outputFile, html);

// ---- standalone ERP page (public/erp.html) for ERP staff accounts ------
// Decoded from the embedded payload; gets its own guard + workspace sync.
//
// The app does NOT ship the ERP as one payload: getSmartRetailErpHtml()
// assembles it at runtime from the base payload plus a list of separately
// Base64-encoded feature modules (Uzum waybill, import orders, supplier
// orders, POS/warehouse mobile, utilization, journal, ERP i18n, ...)
// appended before </body>. Decoding only the base payload would ship the
// staff page ~950 KB of features short of the embedded frame, so mirror
// the app's own assembly by reading that function's declarations instead
// of hard-coding the module list — a vendor upgrade that adds another
// module is then picked up automatically.
function buildErpDocument(appHtml) {
  const payloads = new Map();
  for (const match of appHtml.matchAll(/const (SMART_RETAIL_[A-Z0-9_]+_B64) = "([^"]*)"/g)) {
    payloads.set(match[1], match[2]);
  }
  const basePayload = payloads.get('SMART_RETAIL_ERP_B64');
  if (!basePayload) throw new Error('Embedded ERP payload was not found in the app HTML.');
  const baseHtml = Buffer.from(basePayload, 'base64').toString('utf8');

  const functionStart = appHtml.indexOf('function getSmartRetailErpHtml()');
  if (functionStart < 0) throw new Error('getSmartRetailErpHtml() was not found in the app HTML.');
  const scope = appHtml.slice(functionStart);
  const injected = scope.match(/const injectedModules = ([^;]+);/);
  // Older app bases (v23 and earlier) embed the ERP as a single payload.
  if (!injected) return { erpHtml: baseHtml, modules: [] };

  // `const <name>Binary = atob(<CONST>);` pairs each `<name>Html` local
  // with the payload it decodes.
  const sources = new Map();
  for (const match of scope.slice(0, injected.index).matchAll(/const (\w+)Binary = atob\((SMART_RETAIL_[A-Z0-9_]+_B64)\)/g)) {
    sources.set(`${match[1]}Html`, match[2]);
  }
  // Generated inline by the app rather than decoded: a bridge that
  // postMessages the parent frame when the ERP has finished loading.
  // The standalone page has no parent, so it is left out on purpose.
  const generatedInline = new Set(['readyBridgeHtml']);

  const modules = [];
  const parts = [];
  for (const match of injected[1].matchAll(/\b(\w+Html)\b/g)) {
    const local = match[1];
    if (generatedInline.has(local)) continue;
    const payloadName = sources.get(local);
    if (!payloadName) throw new Error(`ERP module "${local}" has no decodable payload; build.mjs needs updating.`);
    const payload = payloads.get(payloadName);
    if (!payload) throw new Error(`ERP module payload ${payloadName} is missing from the app HTML.`);
    modules.push(payloadName);
    parts.push(Buffer.from(payload, 'base64').toString('utf8'));
  }

  const block = parts.join('\n');
  const closing = baseHtml.toLowerCase().lastIndexOf('</body>');
  const assembled = closing >= 0
    ? baseHtml.slice(0, closing) + block + '\n' + baseHtml.slice(closing)
    : `${baseHtml}\n${block}`;
  return { erpHtml: assembled, modules };
}

const erpOutputFile = resolve(root, 'public/erp.html');
const erpDocument = buildErpDocument(html);
let erpHtml = erpDocument.erpHtml;

const erpHeadMatch = erpHtml.match(/<head[^>]*>/i);
if (!erpHeadMatch) throw new Error('ERP HTML is missing a <head> tag.');
const erpBlock = '\n<!-- SR_ERP_PAGE_BEGIN -->\n' +
  '<script src="assets/app-config.js"></script>\n' +
  '<script src="assets/vendor/supabase.js"></script>\n' +
  '<script src="assets/staff-bridge.js"></script>\n' +
  '<script src="assets/erp-page.js"></script>\n' +
  '<script src="assets/version-check.js"></script>\n' +
  '<style id="srBootAuthHide">body.auth-locked{visibility:hidden!important}</style>\n' +
  '<style>@keyframes srSpin{to{transform:rotate(360deg)}}</style>\n' +
  '<script>(function(){var splash=document.createElement("div");splash.id="srErpBootSplash";' +
  'splash.setAttribute("style","position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#07111f;visibility:visible");' +
  'splash.innerHTML=\'<div style="text-align:center;color:#8ea0bd;font:600 13px -apple-system,\\\'Segoe UI\\\',sans-serif">' +
  '<div style="width:42px;height:42px;margin:0 auto 12px;border-radius:50%;border:3px solid rgba(120,110,255,.25);border-top-color:#786eff;animation:srSpin 1s linear infinite"></div>' +
  'ERP yuklanmoqda...</div>\';document.documentElement.appendChild(splash);' +
  'function gone(){if(splash&&splash.parentNode)splash.parentNode.removeChild(splash);splash=null;}' +
  'function unlocked(){return document.body&&!document.body.classList.contains("auth-locked");}' +
  'var poll=setInterval(function(){if(unlocked()){gone();clearInterval(poll);}},120);' +
  'setTimeout(function(){clearInterval(poll);gone();var hide=document.getElementById("srBootAuthHide");' +
  'if(hide&&document.body&&document.body.classList.contains("auth-locked"))hide.parentNode.removeChild(hide);},8000);' +
  '})();<\/script>\n' +
  '<!-- SR_ERP_PAGE_END -->\n';
const erpHeadIndex = erpHeadMatch.index + erpHeadMatch[0].length;
erpHtml = erpHtml.slice(0, erpHeadIndex) + erpBlock + erpHtml.slice(erpHeadIndex);
writeFileSync(erpOutputFile, erpHtml);

// version.json: a tiny marker version-check.js polls so a tab left open
// across a deploy gets prompted to refresh instead of silently running
// stale code against the current backend contract.
const buildVersion = Date.now().toString(36);
writeFileSync(resolve(root, 'public/version.json'), JSON.stringify({ version: buildVersion }));

console.log(JSON.stringify({
  event: 'build_complete',
  output: 'public/index.html',
  bytes: Buffer.byteLength(html),
  erpPageBytes: Buffer.byteLength(erpHtml),
  erpModules: erpDocument.modules.length,
  fileUploadGuard: fileGuard.state,
  buildVersion,
  legacySyncRemoved: !html.includes('SMART_RETAIL_PARENT_SYNC_21_BEGIN'),
  authInjected: html.includes(HEAD_BEGIN),
  syncInjected: html.includes(BODY_BEGIN)
}));
