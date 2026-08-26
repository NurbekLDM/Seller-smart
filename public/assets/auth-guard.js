/* Client-side auth guard. Creates the shared Supabase client, redirects
   unauthenticated visitors to the login page and keeps the middleware
   cookie in sync with the Supabase session. Server-side gating is done by
   middleware.js; this guard is the in-page counterpart and session owner. */
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

  var COOKIE_MAX_AGE = 7 * 24 * 3600;
  var MERGED_SESSION_KEY = 'uzum-analytics-merged-session-v3';

  /* The app ships with its own legacy in-app login ("Vision Pro AI").
     Supabase is the only real authentication now, so every authenticated
     user gets the internal session seeded and never sees that screen.
     Actual permissions are enforced by the database (RLS), not by the
     legacy in-app role. */
  function seedInternalSession(profile) {
    try {
      localStorage.setItem(MERGED_SESSION_KEY, JSON.stringify({
        role: 'admin',
        username: (profile && profile.username) || 'User',
        at: new Date().toISOString(),
        serverAuthenticated: true,
        supabaseRole: profile ? profile.role : ''
      }));
      sessionStorage.setItem('srerp_auth_session_v6', 'AUTH-ROOT-ADMIN');
    } catch (_) { /* Storage can be unavailable in private windows. */ }
  }
  function clearInternalSession() {
    try {
      localStorage.removeItem(MERGED_SESSION_KEY);
      sessionStorage.removeItem('srerp_auth_session_v6');
    } catch (_) { /* ignore */ }
  }
  function hasValidInternalSession() {
    try {
      var value = JSON.parse(localStorage.getItem(MERGED_SESSION_KEY) || 'null');
      return !!(value && value.role);
    } catch (_) { return false; }
  }
  window.smartRetailSeedInternalSession = seedInternalSession;

  /* supabase-js keeps its session in localStorage under "sb-*" keys; purge
     them explicitly so the session cannot survive a failed network call to
     the sign-out endpoint. */
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

  var signingOut = false;
  function signOutAndRedirect() {
    if (signingOut) return;
    signingOut = true;
    clearInternalSession();
    client.auth.signOut().catch(function () {}).then(function () {
      purgeSupabaseStorage();
      setAuthCookie('', 0);
      window.location.replace('/login.html');
    });
  }
  window.smartRetailSignOut = signOutAndRedirect;

  /* The app's own logout button ("logoutBtn" -> mergedLogout) only clears
     the legacy in-app session, so the Supabase session would survive and
     the guard would sign the user right back in. Attach the real sign-out
     to the same button, and wrap the global as a fallback for any other
     caller. */
  function hookLogout() {
    var button = document.getElementById('logoutBtn');
    if (button && !button.dataset.srSupabaseLogout) {
      button.dataset.srSupabaseLogout = '1';
      button.addEventListener('click', signOutAndRedirect);
    }
    var original = window.mergedLogout;
    if (typeof original === 'function' && !original.srSupabaseWrapped) {
      var wrapped = function () {
        try { original.apply(this, arguments); } catch (_) { /* ignore */ }
        signOutAndRedirect();
      };
      wrapped.srSupabaseWrapped = true;
      window.mergedLogout = wrapped;
    }
  }
  if (!/login/.test(window.location.pathname)) {
    document.addEventListener('DOMContentLoaded', hookLogout);
    window.addEventListener('load', hookLogout);
    // Delegated capture-phase listener: works no matter when (or how often)
    // the app re-renders or rebinds its logout button.
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('#logoutBtn')) signOutAndRedirect();
    }, true);
  }

  client.auth.onAuthStateChange(function (event, session) {
    if (session && session.access_token) setAuthCookie(session.access_token, COOKIE_MAX_AGE);
    if (event === 'SIGNED_OUT') {
      setAuthCookie('', 0);
      clearInternalSession();
      if (!/login/.test(window.location.pathname)) window.location.replace('/login.html');
    }
  });

  // Resolves with the session, or redirects to login. supabase-sync.js and
  // the login page both wait on this promise.
  window.smartRetailAuthReady = client.auth.getSession().then(function (result) {
    var session = result && result.data ? result.data.session : null;
    var onLoginPage = /login/.test(window.location.pathname);
    if (!session) {
      if (!onLoginPage) {
        window.location.replace('/login.html');
        return new Promise(function () {}); // page is navigating away
      }
      return null;
    }
    setAuthCookie(session.access_token, COOKIE_MAX_AGE);
    if (onLoginPage) return session;

    // App page: make sure the legacy in-app login is bypassed. The app
    // checks its session key synchronously at startup, so if it was missing
    // we seed it and reload once (flag prevents loops).
    return client.from('profiles').select('role, active, username').eq('id', session.user.id).single()
      .then(function (profileResult) {
        var profile = profileResult.data;
        if (!profile || !profile.active) {
          clearInternalSession();
          return client.auth.signOut().then(function () { return session; });
        }
        var alreadySeeded = hasValidInternalSession();
        seedInternalSession(profile);
        if (!alreadySeeded && !sessionStorage.getItem('sr-auth-reloaded')) {
          sessionStorage.setItem('sr-auth-reloaded', '1');
          window.location.reload();
          return new Promise(function () {}); // page is reloading
        }
        sessionStorage.removeItem('sr-auth-reloaded');
        return session;
      })
      .catch(function () { return session; });
  });
})();
