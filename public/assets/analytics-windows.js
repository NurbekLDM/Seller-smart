/* "Uzum Market Akademiyasi" and "PRO AI tahlil" open in their own browser
   tab instead of taking over the main page, so the analytics workspace
   stays open behind them.

   Nothing about either screen changes. The new tab loads the SAME
   application at the same URL with that view's hash, and the app's own
   boot already routes a `#<view>` hash through its normal setView() — so
   the markup, the calculations and the content are exactly the ones the
   in-page view renders. This file only intercepts the click that would
   otherwise have switched the view in place; it touches no view logic.

   Only real user clicks are intercepted, never setView() itself: the
   app calls setView() internally (boot hash routing, the protected-access
   module, the ERP session bridge), and wrapping it would make the new tab
   open another tab for the very view it was opened for. */
(function smartRetailAnalyticsWindows() {
  'use strict';

  // Opened as a plain file (file://): window.open on a file URL is
  // unreliable across browsers, so keep the original in-page behaviour.
  if (!/^https?:$/.test(window.location.protocol)) return;

  var STANDALONE_VIEWS = {
    academy: 'srUzumAcademyWindow',
    proai: 'srProAiAnalysisWindow'
  };

  // One reused tab per view: clicking the entry again focuses the tab that
  // is already open instead of spawning another copy of the app.
  var opened = {};

  function targetUrl(view) {
    return window.location.pathname + window.location.search + '#' + view;
  }

  // The view the CURRENT tab is showing, read the same way setView() marks
  // it (".view.active" / id "view-<name>").
  function activeView() {
    var active = document.querySelector('.view.active');
    return active && active.id.indexOf('view-') === 0 ? active.id.slice(5) : '';
  }

  /* The new tab boots its own copy of the app and pulls the workspace
     snapshot from the database. Push whatever this tab has not sent yet
     first, so the new tab can never restore a snapshot older than what
     the user is currently looking at. Fired AFTER window.open — that call
     has to stay inside the click gesture or the browser blocks it — and
     the new tab needs seconds to boot, so the push lands long before it
     reads. */
  function flushPendingWork() {
    try {
      var sync = window.smartRetailAnalyticsServerSync;
      if (sync && sync.status && sync.status().active) {
        Promise.resolve(sync.flush()).catch(function () { /* retried by the sync engine */ });
      }
    } catch (_) { /* sync not running: nothing to push */ }
  }

  function openStandalone(view) {
    try {
      var existing = opened[view];
      if (existing && !existing.closed) { existing.focus(); return true; }
    } catch (_) { /* handle belongs to a closed tab — open a new one */ }
    var handle = null;
    try { handle = window.open(targetUrl(view), STANDALONE_VIEWS[view]); } catch (_) { handle = null; }
    if (!handle) return false; // blocked by the browser: fall back to in-page
    opened[view] = handle;
    try { handle.focus(); } catch (_) { /* focus is best-effort */ }
    flushPendingWork();
    return true;
  }

  /* Capture phase, so this runs before the app's own handlers: the sidebar
     uses a delegated listener on #nav and the dashboard shortcuts use an
     onclick on the element itself — stopping propagation here prevents
     both, leaving the current tab exactly where it was. */
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var trigger = target.closest('[data-view], [data-go]');
    if (!trigger) return;
    var view = trigger.getAttribute('data-view') || trigger.getAttribute('data-go');
    if (!Object.prototype.hasOwnProperty.call(STANDALONE_VIEWS, view)) return;
    // Inside the tab opened FOR this view, its sidebar entry keeps working
    // normally rather than spawning another tab.
    if (activeView() === view) return;
    if (!openStandalone(view)) return; // blocked: let the in-page view open
    event.preventDefault();
    event.stopPropagation();
  }, true);
})();
