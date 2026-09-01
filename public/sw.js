/* Service worker for the PWA install path.

   The ERP's install feature calls navigator.serviceWorker.register('./sw.js')
   (see the v13 PWA block in the ERP document). There was no such file, so
   every page load logged:

     PWA service worker TypeError: Failed to register a ServiceWorker ...
     A bad HTTP response code (404) was received when fetching the script.

   This file exists to make that registration succeed.

   It deliberately caches NOTHING and installs no fetch handler. A worker
   with no fetch listener is skipped entirely for navigations and
   subresources, so it cannot serve anything stale.

   That restraint is on purpose. Caching the 2.2 MB ERP document would be a
   real speed win on a slow connection, and it is tempting — but this
   application talks to a database whose shape it must agree with, and
   assets/version-check.js exists precisely because a tab running yesterday's
   code against today's backend is a problem. Adding an offline cache is a
   deliberate decision to make on its own, with a cache-busting story to go
   with it, not a side effect of silencing a console warning. */

self.addEventListener('install', function () {
  // Take over immediately rather than waiting for existing tabs to close;
  // there is nothing to migrate, since nothing is cached.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  /* Clear anything a previous worker on this origin may have cached, so an
     earlier experiment cannot keep serving old files through this one. */
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) { return caches.delete(name); }));
      })
      .then(function () { return self.clients.claim(); })
      .catch(function () { /* the Cache API may be unavailable; nothing to do */ })
  );
});
