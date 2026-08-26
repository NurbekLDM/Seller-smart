/* Client-side auth guard. Creates the shared Supabase client, keeps the
   middleware cookie in sync with the Supabase session, redirects
   unauthenticated visitors to the login page, and boots the app for the
   signed-in user WITHOUT extra page reloads:

   - The stored Supabase session is read synchronously (before the app's
     own scripts parse), so workspace-ownership checks and the legacy
     in-app session seeding happen up front instead of via reloads.
   - Workspaces are fully isolated per user. Local data (localStorage +
     the analytics IndexedDB) is wiped whenever it does not verifiably
     belong to the signed-in user, and on logout.
   - Logout shows an overlay, gives a pending sync flush up to 2.5s, then
     clears everything locally and leaves — no waiting on slow networks. */
(function smartRetailAuthGuard() {
  'use strict';

  var config = window.SMART_RETAIL_CONFIG || {};
  var configured = config.supabaseUrl && config.supabaseAnonKey
    && String(config.supabaseUrl).indexOf('YOUR-') === -1
    && String(config.supabaseAnonKey).indexOf('YOUR-') === -1;

  // Opened as a plain file (file://) — keep the original offline behaviour.
  if (!/^https?:$/.test(window.location.protocol)) return;

  if (!configured) {
    console.warn('Smart Retail: Supabase is not configured (assets/app-config.js). Running without login or sync.');
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error('Smart Retail: supabase-js failed to load; authentication is unavailable.');
    return;
  }

  var client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  window.smartRetailSupabase = client;

  var COOKIE_MAX_AGE = 7 * 24 * 3600;
  var MERGED_SESSION_KEY = 'uzum-analytics-merged-session-v3';
  var ACTIVE_USER_KEY = 'sr-active-user-id';
  var USERNAME_CACHE_KEY = 'sr-username';
  var onLoginPage = /login/.test(window.location.pathname);
  var signingOut = false;

  function setAuthCookie(token, maxAgeSeconds) {
    var parts = [
      'sr-access-token=' + encodeURIComponent(token || ''),
      'Path=/',
      'Max-Age=' + (token ? maxAgeSeconds : 0),
      'SameSite=Lax'
    ];
    if (window.location.protocol === 'https:') parts.push('Secure');
    document.cookie = parts.join('; ');
  }
  window.smartRetailSetAuthCookie = setAuthCookie;

  /* ------------------------------ storage helpers ------------------------ */

  // Reads the signed-in user's id and email straight from supabase-js's
  // stored session — synchronous, works before any network call.
  function storedSessionInfo() {
    try {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf('sb-') === 0 && key.slice(-11) === '-auth-token') {
          var raw = localStorage.getItem(key);
          if (!raw) continue;
          var value = JSON.parse(raw);
          var user = (value && value.user) || (value && value.currentSession && value.currentSession.user);
          if (user && user.id) return { id: user.id, email: user.email || '' };
        }
      }
    } catch (_) { /* unreadable storage — fall back to the async path */ }
    return null;
  }

  /* supabase-js keeps its session in localStorage under "sb-*" keys; purge
     them explicitly so a session cannot survive logout. */
  function purgeSupabaseStorage() {
    try {
      var doomed = [];
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf('sb-') === 0) doomed.push(key);
      }
      doomed.forEach(function (key) { localStorage.removeItem(key); });
    } catch (_) { /* ignore */ }
  }

  // Removes all app data (ERP + analytics) from this browser. Synchronous
  // for localStorage; the IndexedDB delete is queued before the app's own
  // open request, so the app always boots against a clean database.
  function wipeLocalStorageSync() {
    try {
      var doomed = [];
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && (key.indexOf('srerp_') === 0 || key.indexOf('uzum-analytics-') === 0)) doomed.push(key);
      }
      doomed.forEach(function (key) { localStorage.removeItem(key); });
      sessionStorage.removeItem('srerp_auth_session_v6');
    } catch (_) { /* ignore */ }
  }

  function deleteAnalyticsDatabase() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function () { if (!settled) { settled = true; resolve(); } };
      try {
        var request = indexedDB.deleteDatabase('uzum-analytics-pro');
        request.onsuccess = finish;
        request.onerror = finish;
        request.onblocked = finish;
      } catch (_) { finish(); }
      window.setTimeout(finish, 1500);
    });
  }

  /* --------------------- legacy in-app session seeding -------------------- */

  function randomSecret() {
    var bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16); }).join('');
  }

  /* The embedded ERP keeps its own local user list (srerp_auth_users_v6)
     and unlocks when srerp_auth_session_v6 holds the id of an active entry.
     Every workspace owner gets full ERP access under the root admin entry. */
  function seedErpSession(username) {
    var users;
    try { users = JSON.parse(localStorage.getItem('srerp_auth_users_v6') || '[]'); } catch (_) { users = []; }
    if (!Array.isArray(users)) users = [];
    var existing = users.find(function (u) { return u && u.id === 'AUTH-ROOT-ADMIN'; });
    if (existing) {
      existing.active = true;
      if (username) existing.fullName = username; // keep the real name current
    } else {
      users.push({
        id: 'AUTH-ROOT-ADMIN',
        username: 'Admin',
        password: randomSecret(),
        fullName: username || 'Admin',
        role: 'ADMIN',
        active: true,
        protected: true,
        createdAt: new Date().toISOString()
      });
    }
    localStorage.setItem('srerp_auth_users_v6', JSON.stringify(users));
    sessionStorage.setItem('srerp_auth_session_v6', 'AUTH-ROOT-ADMIN');
    // The ERP's first-run initializers reset the store AND delete the
    // session key when these markers are missing (which they are right
    // after a workspace wipe). Seed them so first-run never fires against
    // an authenticated workspace.
    localStorage.setItem('srerp_v18_clean_store_initialized', new Date().toISOString());
    localStorage.setItem('srerp_v20_new_store_initialized', new Date().toISOString());
    localStorage.setItem('srerp_seeded_v1', '1');
    // If the ERP frame is already open: unlock it if locked, otherwise just
    // refresh its header/permissions so the shown name stays current.
    try {
      var frame = document.getElementById('smartRetailErpFrame');
      var erpWindow = frame && frame.contentWindow;
      if (erpWindow && typeof erpWindow.authResolveSession === 'function' && erpWindow.authResolveSession()) {
        var locked = false;
        try { locked = erpWindow.document.body.classList.contains('auth-locked'); } catch (_) { /* ignore */ }
        if (locked) erpWindow.authUnlock();
        else if (typeof erpWindow.authApplyPermissions === 'function') erpWindow.authApplyPermissions();
      }
    } catch (_) { /* frame not open yet */ }
  }

  /* The app ships with its own legacy logins ("Vision Pro AI" + the ERP's
     internal one). Supabase is the only real authentication, so every
     authenticated user gets both internal sessions seeded and never sees
     those screens. */
  function seedInternalSession(username) {
    try {
      localStorage.setItem(MERGED_SESSION_KEY, JSON.stringify({
        role: 'admin',
        username: username || 'User',
        at: new Date().toISOString(),
        serverAuthenticated: true
      }));
      seedErpSession(username);
    } catch (_) { /* Storage can be unavailable in private windows. */ }
  }
  window.smartRetailSeedInternalSession = function (profile) {
    seedInternalSession(profile && profile.username);
  };

  function clearInternalSession() {
    try {
      localStorage.removeItem(MERGED_SESSION_KEY);
      sessionStorage.removeItem('srerp_auth_session_v6');
    } catch (_) { /* ignore */ }
  }

  /* ------------------------- synchronous boot ---------------------------- */
  /* Runs before the app's scripts parse: enforce workspace ownership and
     seed the internal sessions, so the app starts in the right state on the
     FIRST load — no wipe-reloads, no seed-reloads. */

  var storedSession = onLoginPage ? null : storedSessionInfo();
  if (storedSession) {
    var localOwner = null;
    try { localOwner = localStorage.getItem(ACTIVE_USER_KEY); } catch (_) { /* ignore */ }
    if (localOwner !== storedSession.id) {
      wipeLocalStorageSync();
      try { indexedDB.deleteDatabase('uzum-analytics-pro'); } catch (_) { /* ignore */ }
      try { localStorage.removeItem(USERNAME_CACHE_KEY); } catch (_) { /* ignore */ }
      try { localStorage.setItem(ACTIVE_USER_KEY, storedSession.id); } catch (_) { /* ignore */ }
    }
    var cachedName = null;
    try { cachedName = localStorage.getItem(USERNAME_CACHE_KEY); } catch (_) { /* ignore */ }
    seedInternalSession(cachedName || storedSession.email || 'User');
  }

  /* --------------------------- auth lifecycle ---------------------------- */

  client.auth.onAuthStateChange(function (event, session) {
    if (session && session.access_token) setAuthCookie(session.access_token, COOKIE_MAX_AGE);
    if (event === 'SIGNED_OUT' && !signingOut) {
      setAuthCookie('', 0);
      clearInternalSession();
      if (!onLoginPage) window.location.replace('/login.html');
    }
  });

  function showLogoutOverlay() {
    try {
      if (document.getElementById('srLogoutOverlay')) return;
      var overlay = document.createElement('div');
      overlay.id = 'srLogoutOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#091120;color:#dbe6f7;font:600 15px -apple-system,"Segoe UI",sans-serif';
      overlay.innerHTML = '<style>@keyframes srSpin{to{transform:rotate(360deg)}}</style>' +
        '<div style="text-align:center">' +
        '<div style="width:44px;height:44px;margin:0 auto 14px;border-radius:50%;border:3px solid rgba(120,110,255,.25);border-top-color:#786eff;animation:srSpin 1s linear infinite"></div>' +
        'Chiqilmoqda...</div>';
      (document.body || document.documentElement).appendChild(overlay);
    } catch (_) { /* ignore */ }
  }

  function signOutAndRedirect() {
    if (signingOut) return;
    signingOut = true;
    showLogoutOverlay();
    // Give an unsent sync flush a short window so the last change is not
    // lost, but never block logout on a slow network.
    var pendingFlush = Promise.resolve();
    try {
      var sync = window.smartRetailAnalyticsServerSync;
      if (sync && sync.status && sync.status().active) {
        pendingFlush = Promise.resolve(sync.flush()).catch(function () {});
      }
    } catch (_) { /* ignore */ }
    var cap = new Promise(function (resolve) { window.setTimeout(resolve, 2500); });
    Promise.race([pendingFlush, cap]).then(function () {
      try { client.auth.signOut(); } catch (_) { /* fire-and-forget revocation */ }
      clearInternalSession();
      wipeLocalStorageSync();
      try { indexedDB.deleteDatabase('uzum-analytics-pro'); } catch (_) { /* ignore */ }
      try { localStorage.removeItem(ACTIVE_USER_KEY); } catch (_) { /* ignore */ }
      try { localStorage.removeItem(USERNAME_CACHE_KEY); } catch (_) { /* ignore */ }
      purgeSupabaseStorage();
      setAuthCookie('', 0);
      window.location.replace('/login.html');
    });
  }
  window.smartRetailSignOut = signOutAndRedirect;

  /* ------------------------- ERP boot integration ------------------------ */
  /* The ERP page ships with <body class="auth-locked">, so its login
     overlay is visible from the first painted frame until authUnlock()
     runs at DOMContentLoaded. Inject a boot style that keeps the ERP
     invisible while locked (the session is seeded, so it unlocks moments
     later); a 5s fallback reveals the login if unlocking ever fails. */

  var erpWrappedSource = null;
  var erpWrappedOutput = null;
  function withBootAuthHide(html) {
    if (typeof html !== 'string' || !html) return html;
    if (html === erpWrappedSource) return erpWrappedOutput;
    var block = '<style id="srBootAuthHide">body.auth-locked{visibility:hidden!important}</style>' +
      '<style>@keyframes srSpin{to{transform:rotate(360deg)}}</style>' +
      '<script>(function(){' +
      // Spinner splash attached to <html>, so it stays visible while the
      // locked body is hidden; removed as soon as the ERP unlocks.
      'var splash=document.createElement("div");splash.id="srErpBootSplash";' +
      'splash.setAttribute("style","position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#07111f;visibility:visible");' +
      'splash.innerHTML=\'<div style="text-align:center;color:#8ea0bd;font:600 13px -apple-system,\\\'Segoe UI\\\',sans-serif">' +
      '<div style="width:42px;height:42px;margin:0 auto 12px;border-radius:50%;border:3px solid rgba(120,110,255,.25);border-top-color:#786eff;animation:srSpin 1s linear infinite"></div>' +
      'ERP yuklanmoqda...</div>\';' +
      'document.documentElement.appendChild(splash);' +
      'function gone(){if(splash&&splash.parentNode)splash.parentNode.removeChild(splash);splash=null;}' +
      'function unlocked(){return document.body&&!document.body.classList.contains("auth-locked");}' +
      'var poll=setInterval(function(){if(unlocked()){gone();clearInterval(poll);}},120);' +
      'setTimeout(function(){clearInterval(poll);gone();' +
      'var hide=document.getElementById("srBootAuthHide");' +
      'if(hide&&document.body&&document.body.classList.contains("auth-locked"))hide.parentNode.removeChild(hide);},5000);' +
      '})();<\/script>';
    var output = html.replace(/<head([^>]*)>/i, '<head$1>' + block);
    if (output === html) output = block + html;
    erpWrappedSource = html;
    erpWrappedOutput = output;
    return output;
  }

  var erpWindowBlobUrl = null;
  function installErpIntegration() {
    var originalGet = window.getSmartRetailErpHtml;
    if (typeof originalGet === 'function' && !originalGet.srWrapped) {
      var wrappedGet = function () { return withBootAuthHide(originalGet()); };
      wrappedGet.srWrapped = true;
      window.getSmartRetailErpHtml = wrappedGet;
    }
    /* "Open in a new window" gives the ERP a tab with an EMPTY per-tab
       sessionStorage, so it boots locked. Replace the opener with one that
       authenticates the new tab right away; sessionStorage then survives
       refreshes of that tab, so it stays unlocked. */
    var originalOpen = window.openSmartRetailERPWindow;
    if (typeof originalOpen === 'function' && !originalOpen.srWrapped) {
      var wrappedOpen = function () {
        try {
          var url = URL.createObjectURL(new Blob([window.getSmartRetailErpHtml()], { type: 'text/html;charset=utf-8' }));
          var opened = window.open(url, '_blank');
          if (opened) {
            try { opened.sessionStorage.setItem('srerp_auth_session_v6', 'AUTH-ROOT-ADMIN'); } catch (_) { /* ignore */ }
            // Keep the previous blob alive until a new window is opened, so
            // refreshing the ERP window keeps working.
            if (erpWindowBlobUrl) { try { URL.revokeObjectURL(erpWindowBlobUrl); } catch (_) { /* ignore */ } }
            erpWindowBlobUrl = url;
          } else {
            try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
            if (typeof toast === 'function') toast('Yangi oyna ochilmadi — brauzer bloklagan bo‘lishi mumkin');
          }
        } catch (error) {
          if (typeof toast === 'function') toast('ERP oynasini ochib bo‘lmadi');
        }
      };
      wrappedOpen.srWrapped = true;
      window.openSmartRetailERPWindow = wrappedOpen;
    }
  }

  if (!onLoginPage) {
    document.addEventListener('DOMContentLoaded', installErpIntegration);
    window.addEventListener('load', installErpIntegration);

    /* Intercept the app's logout button in the capture phase: the legacy
       handler (which flashes the internal login screen) never runs; the
       overlay + real sign-out take over immediately. */
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('#logoutBtn')) {
        event.preventDefault();
        event.stopPropagation();
        signOutAndRedirect();
      }
    }, true);
    window.addEventListener('load', function () {
      var original = window.mergedLogout;
      if (typeof original === 'function' && !original.srSupabaseWrapped) {
        var wrapped = function () { signOutAndRedirect(); };
        wrapped.srSupabaseWrapped = true;
        window.mergedLogout = wrapped;
      }
      // Whenever the ERP frame (re)loads, re-assert its session and unlock
      // it — covers any internal code path that clears the session key.
      var frame = document.getElementById('smartRetailErpFrame');
      if (frame) {
        frame.addEventListener('load', function () {
          window.setTimeout(function () {
            try {
              sessionStorage.setItem('srerp_auth_session_v6', 'AUTH-ROOT-ADMIN');
              var erpWindow = frame.contentWindow;
              if (erpWindow && typeof erpWindow.authResolveSession === 'function' && erpWindow.authResolveSession()) {
                erpWindow.authUnlock();
              }
            } catch (_) { /* ignore */ }
          }, 50);
        });
      }
    });
  }

  /* --------------------------- session readiness ------------------------- */

  // Resolves with the session, or redirects to login. supabase-sync.js and
  // the login page both wait on this promise.
  window.smartRetailAuthReady = client.auth.getSession().then(function (result) {
    var session = result && result.data ? result.data.session : null;
    if (!session) {
      if (!onLoginPage) {
        clearInternalSession();
        window.location.replace('/login.html');
        return new Promise(function () {}); // page is navigating away
      }
      return null;
    }
    setAuthCookie(session.access_token, COOKIE_MAX_AGE);
    if (onLoginPage) return session;

    // Fallback for the rare case the synchronous check could not read the
    // stored session: enforce workspace ownership with one clean reload.
    var owner = null;
    try { owner = localStorage.getItem(ACTIVE_USER_KEY); } catch (_) { /* ignore */ }
    if (owner !== session.user.id) {
      wipeLocalStorageSync();
      return deleteAnalyticsDatabase().then(function () {
        try { localStorage.setItem(ACTIVE_USER_KEY, session.user.id); } catch (_) { /* ignore */ }
        window.location.reload();
        return new Promise(function () {}); // page is reloading
      });
    }

    return client.from('profiles').select('active, username').eq('id', session.user.id).single()
      .then(function (profileResult) {
        var profile = profileResult.data;
        if (!profile || !profile.active) {
          clearInternalSession();
          return client.auth.signOut().then(function () { return session; });
        }
        var displayName = profile.username || session.user.email || '';
        try { localStorage.setItem(USERNAME_CACHE_KEY, displayName); } catch (_) { /* ignore */ }
        seedInternalSession(displayName); // refresh with the real name
        return session;
      })
      .catch(function () { return session; });
  });
})();
