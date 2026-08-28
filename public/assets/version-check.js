/* Detects a new deploy while this tab stayed open. An already-open tab
   never re-fetches new JS on its own (no service worker here), so a page
   left open across a deploy can silently keep running stale code —
   clicks look like they work but never reach the current backend
   contract. Polls a tiny version marker and prompts a refresh on change. */
(function smartRetailVersionCheck() {
  'use strict';
  if (!/^https?:$/.test(window.location.protocol)) return;

  var baseline = null;
  var banner = null;

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483600;' +
      'display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;' +
      'padding:10px 16px;background:#3d3480;color:#fff;' +
      'font:600 13px -apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    banner.innerHTML = '<span>Yangi versiya chiqdi — bu sahifa eski nusxada ishlayapti.</span>' +
      '<button id="srVersionReload" style="border:0;border-radius:7px;padding:6px 14px;' +
      'background:#fff;color:#3d3480;font-weight:700;cursor:pointer">Sahifani yangilash</button>';
    (document.body || document.documentElement).appendChild(banner);
    var button = document.getElementById('srVersionReload');
    if (button) button.onclick = function () { window.location.reload(); };
  }

  function check() {
    fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data || !data.version) return;
        if (baseline === null) { baseline = data.version; return; }
        if (data.version !== baseline) showBanner();
      })
      .catch(function () { /* offline or blocked: never nag for that */ });
  }

  check();
  window.setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('focus', check);
})();
