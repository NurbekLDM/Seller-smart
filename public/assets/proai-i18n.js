/* Teaches the PRO AI module's iframe the interface language.

   "PRO AI tahlil" is a separate HTML document embedded as a srcdoc iframe
   (#proAiFrame). Unlike the ERP payload, that document ships with NO
   translator of its own, and the app's own language bridge
   (notifyRelatives) only reaches #smartRetailErpFrame — so switching the
   UI to Russian left the whole PRO AI panel in Uzbek while everything
   around it changed.

   The fix is to run the app's OWN i18n module inside that iframe rather
   than to reimplement translation here. The module is already written for
   this: readLocale() falls back to window.parent.smartRetailI18n.locale(),
   and it listens for the `storage` event, which is exactly what a
   same-origin iframe receives when the parent writes the language key. So
   copying the module's source into the frame is enough — first paint and
   every later switch both follow the parent, with the app's own phrase
   table and its own MutationObserver keeping dynamically rendered results
   translated too.

   installControls() inside the frame is a no-op: the PRO AI document has
   neither a .top-actions bar nor a login card, so no second UZ/RU switch
   appears. */
(function smartRetailProAiI18n() {
  'use strict';

  var SOURCE_SCRIPT_ID = 'smartRetailI18n23';
  var FRAME_ID = 'proAiFrame';
  var MARKER = 'srProAiI18nInstalled';

  function moduleSource() {
    try {
      var node = document.getElementById(SOURCE_SCRIPT_ID);
      var text = node && node.textContent;
      return text && text.length > 1000 ? text : '';
    } catch (_) { return ''; }
  }

  /* Same-origin (srcdoc) — reachable. Anything else means the frame was
     repointed at a real URL, and we leave it alone. An iframe that has not
     been populated yet still exposes an about:blank document with an empty
     body; injecting there is pointless (the document is replaced the
     moment srcdoc is set), so require real content. */
  function frameDocument(frame) {
    try {
      var doc = frame.contentDocument;
      if (!doc || !doc.body || !doc.body.childElementCount) return null;
      return doc;
    } catch (_) { return null; }
  }

  function install(frame) {
    var doc = frameDocument(frame);
    if (!doc) return false;
    var view = frame.contentWindow;
    // Already translated (ours, or a future vendor build that ships i18n).
    if (view && (view[MARKER] || view.smartRetailI18n)) return true;
    var source = moduleSource();
    if (!source) return false;
    try {
      view[MARKER] = true;
      var script = doc.createElement('script');
      script.id = 'srProAiI18n';
      script.textContent = source;
      (doc.head || doc.documentElement).appendChild(script);
      return true;
    } catch (_) {
      try { view[MARKER] = false; } catch (_ignored) { /* frame gone */ }
      return false;
    }
  }

  /* The frame's content is set via srcdoc, so a "load" listener is the
     reliable signal; poll briefly as well, because the frame may already
     have finished loading before this file ran, and because the app
     re-points srcdoc when the ERP/PRO views are reopened. */
  function watch() {
    var frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    if (frame.dataset.srProAiI18nWatched === '1') return;
    frame.dataset.srProAiI18nWatched = '1';
    frame.addEventListener('load', function () { window.setTimeout(function () { install(frame); }, 0); });
    install(frame);
  }

  var attempts = 0;
  (function arm() {
    watch();
    attempts += 1;
    // The view (and its iframe) is only rendered once the user opens it.
    if (attempts < 120) window.setTimeout(arm, 500);
  })();

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-view="proai"], [data-go="proai"]')) window.setTimeout(watch, 50);
  }, true);
})();
