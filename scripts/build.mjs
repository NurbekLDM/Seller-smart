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
  // assets/analytics-windows.js is deliberately NOT injected: opening
  // "Uzum Market Akademiyasi" / "PRO AI tahlil" in their own tab boots a
  // SECOND full instance of this 6.8 MB page (~7.5s cold boot on a fast
  // desktop), which froze the app on the customer's laptop. The file is
  // kept, unchanged, to be re-enabled once the base64 payloads move out of
  // the HTML and a new tab costs kilobytes instead of megabytes.
  // assets/proai-i18n.js is deliberately NOT injected either: it loads the
  // app's i18n module into the PRO AI iframe, and that module installs a
  // MutationObserver in a document where Tailwind's Play CDN is already
  // running its own — switching language with that panel open froze the
  // browser. Re-enable only with a translator that does a single pass and
  // observes nothing.

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
/* ---------------- i18n unification (fixes the RU-switch freeze) ---------
   The ERP document ships TWO complete translators: the base i18n v23
   (inside SMART_RETAIL_ERP_B64, ~900 phrases) and the "supplement 53"
   module (SMART_RETAIL_ERP_I18N_53_B64, 2,500 phrases) — EACH with its own
   whole-document MutationObserver watching characterData. On a language
   switch each engine rewrites ~12,000 text nodes; every write wakes the
   other engine, whose observer path passes refreshOriginal=true — i.e. it
   REPLACES its stored original with the other engine's output and
   re-translates that. Where the dictionaries overlap with different
   wording (~1,600 shared keys) the two engines rewrite each other's text
   forever: measured in headless Chrome, one click on the ERP's RU button
   wedges the renderer for >180s (never recovers); without the click the
   same document settles in 8s. The parent page — SAME base engine, but
   with its supplement merged into one dictionary — switches in ~0ms.

   Fix: converge the ERP on the parent's architecture.
   (1) The base engine gets window.smartRetailI18nExtend(pairs): merge
       extra pairs into its closure dictionary and rebuild the pattern.
   (2) The supplement, when that API exists, merges its PAIRS and goes
       DORMANT — no second observer, no second walk; its public API
       delegates to the base engine. Without the API (a vendor drop that
       changes the base beyond recognition) it falls back to its original
       behaviour, so the build never produces an untranslated ERP.
   (3) notifyRelatives defers cross-document translation by one task, so
       switching inside the ERP no longer runs the parent's full walk in
       the same click task (and vice versa) — each document paints its own
       switch first. Loop-safe: the locale-equality guard re-runs inside
       the timeout, and source tags prevent echo.
   Anchors are exact vendor text; a mismatch fails the build loudly. */

const I18N_PATTERN_ANCHOR = `  } catch (_) {
    translationPattern = new RegExp(
      '(?:' + replacementKeys.map(escapePattern).join('|') + ')',
      'gi'
    );
  }`;

const I18N_EXTEND_CODE = `${I18N_PATTERN_ANCHOR}

  /* SR_I18N_EXTEND_BEGIN (build-time patch — scripts/build.mjs) */
  function srRebuildTranslationPattern() {
    const keys = [...dictionary.keys()].sort((left, right) => right.length - left.length);
    try {
      translationPattern = new RegExp(
        '(?<![\\\\p{L}\\\\p{N}])(?:' + keys.map(escapePattern).join('|') + ')(?![\\\\p{L}\\\\p{N}])',
        'giu'
      );
    } catch (_) {
      translationPattern = new RegExp('(?:' + keys.map(escapePattern).join('|') + ')', 'gi');
    }
  }
  window.smartRetailI18nExtend = function (pairs) {
    if (!Array.isArray(pairs)) return 0;
    let added = 0;
    for (const pair of pairs) {
      if (!pair || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
      const key = canonical(pair[0]);
      // Existing entries win: the base table is what production already
      // renders; the merge only fills gaps.
      if (!key || dictionary.has(key)) continue;
      dictionary.set(key, pair[1]);
      added += 1;
    }
    if (added) srRebuildTranslationPattern();
    return added;
  };
  /* SR_I18N_EXTEND_END */`;

const I18N_NOTIFY_ANCHOR = `  function notifyRelatives(locale, source) {
    if (syncing) return;
    syncing = true;
    try {
      const frame = document.getElementById('smartRetailErpFrame');
      if (frame && frame.contentWindow && frame.contentWindow.smartRetailI18n
          && frame.contentWindow.smartRetailI18n.locale() !== locale) {
        frame.contentWindow.smartRetailI18n.setLocale(locale, 'parent');
      }
      if (source !== 'parent' && window.parent && window.parent !== window
          && window.parent.smartRetailI18n
          && window.parent.smartRetailI18n.locale() !== locale) {
        window.parent.smartRetailI18n.setLocale(locale, 'child');
      }
    } catch (_) {
      /* Sandboxed or cross-origin frames can still pick up shared storage. */
    } finally {
      syncing = false;
    }
  }`;

const I18N_NOTIFY_DEFERRED = `  function notifyRelatives(locale, source) {
    if (syncing) return;
    syncing = true;
    /* SR_I18N_DEFER: the relative document translates in its own task, so
       one click no longer pays for two full-document walks + two layout
       storms synchronously. The locale guard re-runs inside the timeout. */
    try {
      const frame = document.getElementById('smartRetailErpFrame');
      if (frame && frame.contentWindow && frame.contentWindow.smartRetailI18n
          && frame.contentWindow.smartRetailI18n.locale() !== locale) {
        window.setTimeout(function () {
          try {
            const target = document.getElementById('smartRetailErpFrame');
            if (target && target.contentWindow && target.contentWindow.smartRetailI18n
                && target.contentWindow.smartRetailI18n.locale() !== locale) {
              target.contentWindow.smartRetailI18n.setLocale(locale, 'parent');
            }
          } catch (_) { /* frame gone or reloading */ }
        }, 0);
      }
      if (source !== 'parent' && window.parent && window.parent !== window
          && window.parent.smartRetailI18n
          && window.parent.smartRetailI18n.locale() !== locale) {
        window.setTimeout(function () {
          try {
            if (window.parent && window.parent !== window && window.parent.smartRetailI18n
                && window.parent.smartRetailI18n.locale() !== locale) {
              window.parent.smartRetailI18n.setLocale(locale, 'child');
            }
          } catch (_) { /* parent gone */ }
        }, 0);
      }
    } catch (_) {
      /* Sandboxed or cross-origin frames can still pick up shared storage. */
    } finally {
      syncing = false;
    }
  }`;

const I18N_SUPPLEMENT_TAIL = `  if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});`;

const I18N_SUPPLEMENT_COOPERATIVE = `  /* SR_I18N_MERGE (build-time patch — scripts/build.mjs): one engine only.
     When the base i18n exposes the extend API, hand it our 2,500 pairs and
     go dormant — no second observer, no second walk, no livelock. The
     original install() remains as the fallback for a vendor drop whose
     base engine we no longer recognise. */
  function srCooperativeInstall(){
    var base=window.smartRetailI18n;
    if(base&&typeof window.smartRetailI18nExtend==='function'
        &&typeof base.refresh==='function'&&typeof base.locale==='function'){
      var added=-1;
      try{added=window.smartRetailI18nExtend(PAIRS);}catch(_){added=-1;}
      if(added>=0){
        var mirror=function(){try{document.documentElement.setAttribute('data-erp-language',base.locale());}catch(_){/* detached */}};
        window.smartRetailErpI18nSupplement={version:53,mode:'merged',added:added,
          groups:function(){return Object.fromEntries(Object.entries(GROUPS).map(function(entry){return [entry[0],entry[1].length];}));},
          refresh:function(){return base.refresh();},
          translate:function(value,target){return base.translate(value,target||base.locale());}};
        window.addEventListener('smart-retail-language-change',mirror);
        mirror();
        if(base.locale()==='ru')base.refresh();
        return;
      }
    }
    install();
  }
  if(document.body)srCooperativeInstall();else document.addEventListener('DOMContentLoaded',srCooperativeInstall,{once:true});`;

// Replace exactly-once helper: a changed vendor file must fail the build,
// never ship half-patched.
function mustReplaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`i18n patch anchor "${label}" matched ${count} times (expected 1); the vendor i18n changed — re-verify before shipping.`);
  }
  return source.replace(needle, replacement);
}

function patchB64Const(appHtml, constName, transform) {
  const pattern = new RegExp(`const ${constName} = "([^"]*)"`);
  const match = appHtml.match(pattern);
  if (!match) throw new Error(`${constName} was not found in the app HTML.`);
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const patched = transform(decoded);
  const encoded = Buffer.from(patched, 'utf8').toString('base64');
  return appHtml.replace(pattern, `const ${constName} = "${encoded}"`);
}

function patchI18n(appHtml) {
  // Outer copy (plain text in the app HTML): extend API + deferred notify.
  let output = mustReplaceOnce(appHtml, I18N_PATTERN_ANCHOR, I18N_EXTEND_CODE, 'outer pattern-build');
  output = mustReplaceOnce(output, I18N_NOTIFY_ANCHOR, I18N_NOTIFY_DEFERRED, 'outer notifyRelatives');
  // ERP base payload: the same two patches on its own copy of the engine.
  output = patchB64Const(output, 'SMART_RETAIL_ERP_B64', (erp) => {
    let body = mustReplaceOnce(erp, I18N_PATTERN_ANCHOR, I18N_EXTEND_CODE, 'erp pattern-build');
    body = mustReplaceOnce(body, I18N_NOTIFY_ANCHOR, I18N_NOTIFY_DEFERRED, 'erp notifyRelatives');
    return body;
  });
  // Supplement payload: merge-and-go-dormant bootstrap.
  output = patchB64Const(output, 'SMART_RETAIL_ERP_I18N_53_B64', (supplement) =>
    mustReplaceOnce(supplement, I18N_SUPPLEMENT_TAIL, I18N_SUPPLEMENT_COOPERATIVE, 'supplement bootstrap'));
  return output;
}

html = patchI18n(html);

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

/* -------- backup / reset menu trim (owner request, 2026-08-31) ----------
   The owner does not use the ERP's backup features and asked for their five
   sidebar entries to go:
     "To‘liq Excel backup (.xlsx)"   (base markup, relabelled by v20)
     "Excel backupni tiklash"        (base markup, relabelled by v20)
     "Parol bilan tizimni tozalash"  (base markup, relabelled by v19)
     "To‘liq HTML backup"            (injected at runtime by v20.1)
     "HTML backupni tiklash"         (injected at runtime by v20.1)
   Both hidden <input type="file"> elements are deliberately KEPT: the base
   ERP binds handleImportFile to #importFile with no null guard (it would
   throw at boot without it), and the Sozlamalar screen's own Excel/HTML
   cards still open both. Only the visible menu goes here — the cards and
   the export/import/reset functions behind them are untouched.
   Patched in the payload, so the embedded frame, the "open in a new
   window" popup and public/erp.html all get it from one place. The v19/v20
   relabellers that used to rename these links are all `if (found)` guarded,
   so they simply no-op now. */

const BACKUP_MENU_ANCHOR = `  <div class="nav-group" style="margin-top:10px; border-top:1px solid var(--border); padding-top:14px;">
    <div class="nav-link-erp" onclick="exportAllData()"><i class="bi bi-file-earmark-excel"></i> Excel eksport (.xlsx)</div>
    <div class="nav-link-erp" onclick="document.getElementById('importFile').click()"><i class="bi bi-upload"></i> Excel import</div>
    <input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="display:none">
    <div class="nav-link-erp" onclick="v18ResetStoreData()"><i class="bi bi-eraser"></i> Yangi do‘kon holatiga tozalash</div>
  </div>`;

const BACKUP_MENU_TRIMMED = `  <!-- SR_BACKUP_MENU_TRIM (build-time patch — scripts/build.mjs): the
       backup / import / reset sidebar group is removed. The hidden input
       stays: the base ERP binds its change handler to it unguarded. -->
  <input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="display:none">`;

const HTML_BACKUP_MENU_ANCHOR = `  function v201InstallUi(){
    if(document.getElementById('v201HtmlExportAction'))return;
    const groups=[...document.querySelectorAll('#sidebar .nav-group')];
    const actionGroup=groups.find(g=>g.querySelector('[onclick="exportAllData()"]'))||groups[groups.length-1];
    if(actionGroup){
      const reset=[...actionGroup.querySelectorAll('.nav-link-erp')].find(el=>String(el.getAttribute('onclick')||'').includes('v18ResetStoreData'));
      const html=\`<div class="nav-link-erp" id="v201HtmlExportAction" onclick="v8ExportPortableHtml()"><i class="bi bi-filetype-html"></i> To‘liq HTML backup</div><div class="nav-link-erp" id="v201HtmlImportAction" onclick="document.getElementById('v201HtmlImportFile').click()"><i class="bi bi-file-earmark-arrow-up"></i> HTML backupni tiklash</div><input type="file" id="v201HtmlImportFile" accept=".html,.htm,.json,.srerp" style="display:none">\`;
      if(reset)reset.insertAdjacentHTML('beforebegin',html);else actionGroup.insertAdjacentHTML('beforeend',html);
      document.getElementById('v201HtmlImportFile')?.addEventListener('change',v8ImportPortableFile);
    }`;

const HTML_BACKUP_MENU_TRIMMED = `  function v201InstallUi(){
    /* SR_BACKUP_MENU_TRIM (build-time patch — scripts/build.mjs): the two
       sidebar entries are gone; only the hidden file input is installed, so
       the Sozlamalar card's restore button still has something to open. The
       install guard keys off that input instead of the removed link. */
    if(document.getElementById('v201HtmlImportFile'))return;
    const html='<input type="file" id="v201HtmlImportFile" accept=".html,.htm,.json,.srerp" style="display:none">';
    document.getElementById('sidebar')?.insertAdjacentHTML('beforeend',html);
    document.getElementById('v201HtmlImportFile')?.addEventListener('change',v8ImportPortableFile);`;

function patchBackupMenu(appHtml) {
  return patchB64Const(appHtml, 'SMART_RETAIL_ERP_B64', (erp) => {
    let body = mustReplaceOnce(erp, BACKUP_MENU_ANCHOR, BACKUP_MENU_TRIMMED, 'erp backup menu group');
    return mustReplaceOnce(body, HTML_BACKUP_MENU_ANCHOR, HTML_BACKUP_MENU_TRIMMED, 'erp html-backup menu');
  });
}

html = patchBackupMenu(html);

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
  // Must precede erp-page.js: that file installs the store's localStorage
  // shim during its own parse, before the ERP's scripts read any storage.
  '<script src="assets/workspace-store.js"></script>\n' +
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
  i18nUnified: true,
  buildVersion,
  legacySyncRemoved: !html.includes('SMART_RETAIL_PARENT_SYNC_21_BEGIN'),
  authInjected: html.includes(HEAD_BEGIN),
  syncInjected: html.includes(BODY_BEGIN)
}));
