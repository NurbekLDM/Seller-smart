/* Standalone ERP page (erp.html): authentication guard + workspace sync.
   Used by ERP staff accounts (POS + Inventarizatsiya only) and reachable
   by workspace owners too (full ERP). Staff work inside their OWNER's
   workspace: reads and writes go to the owner's snapshot via RLS-scoped
   Supabase calls. Runs in <head>, before the ERP's own scripts parse. */
(function smartRetailErpPage() {
  'use strict';

  var config = window.SMART_RETAIL_CONFIG || {};
  var configured = config.supabaseUrl && config.supabaseAnonKey
    && String(config.supabaseUrl).indexOf('YOUR-') === -1;
  if (!/^https?:$/.test(window.location.protocol)) return;
  if (!configured || !window.supabase || !window.supabase.createClient) {
    console.error('Smart Retail ERP page: Supabase is not configured.');
    return;
  }

  var client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  window.smartRetailSupabase = client;

  var ACTIVE_USER_KEY = 'sr-active-user-id';
  var ERP_PROFILE_KEY = 'sr-erp-profile';
  var ANALYTICS_KEY = 'srerp_analytics_parent_state';
  var signingOut = false;

  function setAuthCookie(token, maxAgeSeconds) {
    var parts = [
      'sr-access-token=' + encodeURIComponent(token || ''),
      'Path=/', 'Max-Age=' + (token ? maxAgeSeconds : 0), 'SameSite=Lax'
    ];
    if (window.location.protocol === 'https:') parts.push('Secure');
    document.cookie = parts.join('; ');
  }

  function storedSessionInfo() {
    try {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf('sb-') === 0 && key.slice(-11) === '-auth-token') {
          var value = JSON.parse(localStorage.getItem(key) || 'null');
          var user = (value && value.user) || (value && value.currentSession && value.currentSession.user);
          if (user && user.id) return { id: user.id, email: user.email || '' };
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

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

  function wipeLocalWorkspace() {
    try {
      var doomed = [];
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && (key.indexOf('srerp_') === 0 || key.indexOf('uzum-analytics-') === 0)) doomed.push(key);
      }
      doomed.forEach(function (key) { localStorage.removeItem(key); });
      var doomedSession = [];
      for (var position = 0; position < sessionStorage.length; position += 1) {
        var sessionKey = sessionStorage.key(position);
        if (sessionKey && sessionKey.indexOf('srerp_') === 0) doomedSession.push(sessionKey);
      }
      doomedSession.forEach(function (key) { sessionStorage.removeItem(key); });
      indexedDB.deleteDatabase('uzum-analytics-pro');
    } catch (_) { /* ignore */ }
  }

  function randomSecret() {
    var bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16); }).join('');
  }

  /* Seed the ERP's internal auth: first-run markers (so the store reset
     never fires), the v23 access token, a users-list entry matching the
     account's role/permissions, and the per-tab session id. The ERP's own
     v12 permission layer (see erp.html) grants access strictly from the
     seeded entry's `permissions` array, so a staff account only ever sees
     the sections the owner granted via the Employees screen. */
  function seedErpAuth(role, name, uid, modules) {
    try {
      var stamp = new Date().toISOString();
      localStorage.setItem('srerp_v18_clean_store_initialized', stamp);
      localStorage.setItem('srerp_v20_new_store_initialized', stamp);
      localStorage.setItem('srerp_seeded_v1', '1');
      var now = Date.now();
      sessionStorage.setItem('srerp_analytics_erp_access_v22', JSON.stringify({
        userId: 'AUTH-ROOT-ADMIN', username: name || 'User', role: 'ADMIN',
        mode: 'supabase', verifiedAt: now, expiresAt: now + 12 * 3600 * 1000
      }));
      var isStaff = role === 'STAFF';
      var entryId = isStaff ? 'AUTH-STAFF-' + String(uid || '').replace(/-/g, '').slice(0, 10) : 'AUTH-ROOT-ADMIN';
      var permissions = isStaff ? (Array.isArray(modules) && modules.length ? modules : ['pos']) : ['*'];
      var landing = isStaff ? permissions[0] : 'ceo';
      var users;
      try { users = JSON.parse(localStorage.getItem('srerp_auth_users_v6') || '[]'); } catch (_) { users = []; }
      if (!Array.isArray(users)) users = [];
      var entry = users.find(function (u) { return u && u.id === entryId; });
      if (entry) {
        entry.active = true;
        entry.role = isStaff ? 'CUSTOM' : 'ADMIN';
        entry.permissions = permissions;
        entry.landing = landing;
        if (name) { entry.fullName = name; entry.username = entry.username || name; }
      } else {
        users.push({
          id: entryId,
          username: name || (isStaff ? 'Xodim' : 'Admin'),
          password: randomSecret(),
          fullName: name || (isStaff ? 'Xodim' : 'Admin'),
          role: isStaff ? 'CUSTOM' : 'ADMIN',
          permissions: permissions,
          landing: landing,
          active: true,
          protected: !isStaff,
          createdAt: new Date().toISOString()
        });
      }
      localStorage.setItem('srerp_auth_users_v6', JSON.stringify(users));
      sessionStorage.setItem('srerp_auth_session_v6', entryId);
    } catch (_) { /* storage unavailable */ }
  }

  /* Owner-only: the employee-management bridge itself lives in the
     shared assets/staff-bridge.js (the same ERP HTML also runs inside
     the platform's iframe and popup, which load the bridge there). This
     page passes its own client and drives the install/reconcile timing:
     the first reconcile must not run concurrently with the initial
     app_state restore, or restore() can overwrite a just-applied prune
     with the still-stale server snapshot. */
  function hookEmployeeManagement() {
    if (typeof window.smartRetailInstallStaffBridge !== 'function') {
      // Fail CLOSED. Leaving the vendor's handlers in place would let the
      // Employees screen report success while writing a browser-only
      // account that can never log in — the exact bug this bridge fixes.
      console.warn('Staff bridge script is missing.');
      var unavailable = function () {
        var message = 'Xodimlar moduli yuklanmadi — sahifani yangilang.';
        try { showToast(message, 'bi-x-circle text-danger'); } catch (_) { window.alert(message); }
      };
      window.authSaveUser = unavailable;
      window.authDeleteUser = unavailable;
      return null;
    }
    return window.smartRetailInstallStaffBridge(function () {
      return { client: client, origin: window.location.origin, syncReady: syncActive };
    });
  }

  function tryUnlock() {
    try {
      if (typeof authResolveSession === 'function' && authResolveSession()) {
        if (document.body && document.body.classList.contains('auth-locked')) authUnlock();
        else if (typeof authApplyPermissions === 'function') authApplyPermissions();
      }
    } catch (_) { /* ERP not booted yet */ }
  }

  /* ------------------------------ boot ---------------------------------- */

  var stored = storedSessionInfo();
  if (!stored) {
    window.location.replace('/login.html');
    return;
  }
  var localOwner = null;
  try { localOwner = localStorage.getItem(ACTIVE_USER_KEY); } catch (_) { /* ignore */ }
  if (localOwner !== stored.id) {
    wipeLocalWorkspace();
    try {
      localStorage.removeItem(ERP_PROFILE_KEY);
      localStorage.removeItem('sr-username');
      localStorage.removeItem('sr-ws-revision');
      localStorage.removeItem('sr-conflict-backup');
      localStorage.setItem(ACTIVE_USER_KEY, stored.id);
    } catch (_) { /* ignore */ }
  }

  var cachedProfile = null;
  try {
    cachedProfile = JSON.parse(localStorage.getItem(ERP_PROFILE_KEY) || 'null');
    if (cachedProfile && cachedProfile.id !== stored.id) cachedProfile = null;
  } catch (_) { cachedProfile = null; }
  if (cachedProfile) seedErpAuth(cachedProfile.role, cachedProfile.name, stored.id, cachedProfile.modules);

  var domReady = new Promise(function (resolve) {
    if (document.readyState !== 'loading') resolve();
    else document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
  });

  document.addEventListener('DOMContentLoaded', function () {
    hookLogout();
    hookSync();
    if (cachedProfile && cachedProfile.role === 'OWNER') {
      window.setTimeout(function () {
        try { hookEmployeeManagement(); } catch (error) { console.warn('Employee management unavailable:', error.message); }
      }, 0);
    }
  });

  /* ---------------------------- sign out -------------------------------- */

  function signOutAndRedirect() {
    if (signingOut) return;
    signingOut = true;
    try {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#091120;color:#dbe6f7;font:600 15px -apple-system,"Segoe UI",sans-serif';
      overlay.innerHTML = '<style>@keyframes srSpin{to{transform:rotate(360deg)}}</style><div style="text-align:center"><div style="width:44px;height:44px;margin:0 auto 14px;border-radius:50%;border:3px solid rgba(120,110,255,.25);border-top-color:#786eff;animation:srSpin 1s linear infinite"></div>Chiqilmoqda...</div>';
      (document.body || document.documentElement).appendChild(overlay);
    } catch (_) { /* ignore */ }
    // Kill auth material FIRST (synchronously): closing the tab mid-logout
    // must never leave a usable session on a shared machine. The final
    // flush still works — supabase-js keeps the session in memory.
    setAuthCookie('', 0);
    purgeSupabaseStorage();
    try {
      sessionStorage.removeItem('srerp_auth_session_v6');
      sessionStorage.removeItem('srerp_analytics_erp_access_v22');
    } catch (_) { /* ignore */ }
    var pendingFlush = Promise.resolve();
    try { if (syncActive) pendingFlush = flush().catch(function () {}); } catch (_) { /* ignore */ }
    var cap = new Promise(function (resolve) { window.setTimeout(resolve, 2500); });
    Promise.race([pendingFlush, cap]).then(function () {
      try { client.auth.signOut(); } catch (_) { /* fire and forget */ }
      wipeLocalWorkspace();
      try {
        localStorage.removeItem(ACTIVE_USER_KEY);
        localStorage.removeItem(ERP_PROFILE_KEY);
        localStorage.removeItem('sr-username');
        localStorage.removeItem('sr-ws-revision');
        localStorage.removeItem('sr-conflict-backup');
      } catch (_) { /* ignore */ }
      window.location.replace('/login.html');
    });
  }

  function hookLogout() {
    var original = window.authLogout;
    if (typeof original === 'function' && !original.srWrapped) {
      var wrapped = function () { signOutAndRedirect(); };
      wrapped.srWrapped = true;
      window.authLogout = wrapped;
    }
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var trigger = target.closest('[onclick*="authLogout"], [data-action="logout"], #authHeaderLogout');
      if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        signOutAndRedirect();
      }
    }, true);
  }

  /* --------------------------- workspace sync --------------------------- */

  var revision = 0;
  var syncActive = false;
  var applying = false;
  var busy = false;
  var delayed = false;
  var timer = null;
  var carried = {};   // snapshot entries this page cannot regenerate (analytics)
  var statusChip = null;
  var WS_REVISION_KEY = 'sr-ws-revision';

  // The workspace version is shared across tabs so a second tab never
  // pushes with a stale expected_version (guaranteed conflict otherwise).
  function adoptSharedRevision() {
    try {
      var shared = Number(localStorage.getItem(WS_REVISION_KEY)) || 0;
      if (shared > revision) revision = shared;
    } catch (_) { /* ignore */ }
  }
  function publishRevision() {
    try { localStorage.setItem(WS_REVISION_KEY, String(revision)); } catch (_) { /* ignore */ }
  }

  function announce(state, label) {
    try {
      if (!statusChip) {
        statusChip = document.createElement('div');
        statusChip.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99990;padding:4px 10px;border-radius:14px;background:rgba(13,22,40,.85);color:#8ea0bd;font:600 10.5px -apple-system,"Segoe UI",sans-serif;pointer-events:none';
        (document.body || document.documentElement).appendChild(statusChip);
      }
      statusChip.textContent = label;
      statusChip.style.color = state === 'error' || state === 'conflict' ? '#ff8c8c' : (state === 'syncing' ? '#c8d5ea' : '#5fd98c');
    } catch (_) { /* ignore */ }
  }

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !/password|secret|credential|session|token|pin|auth_users|initialized|seeded/i.test(key);
  }

  function collect() {
    var result = {};
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (permitted(key)) result[key] = localStorage.getItem(key);
    }
    // Preserve workspace entries this page does not manage (the owner's
    // analytics state) so a staff save never erases them.
    for (var carriedKey in carried) {
      if (Object.prototype.hasOwnProperty.call(carried, carriedKey) && !(carriedKey in result)) {
        result[carriedKey] = carried[carriedKey];
      }
    }
    return result;
  }

  function restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    applying = true;
    try {
      carried = {};
      if (typeof snapshot[ANALYTICS_KEY] === 'string') carried[ANALYTICS_KEY] = snapshot[ANALYTICS_KEY];
      var existing = [];
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (permitted(key)) existing.push(key);
      }
      existing.filter(function (key) {
        return key !== ANALYTICS_KEY && !Object.prototype.hasOwnProperty.call(snapshot, key);
      }).forEach(function (key) { localStorage.removeItem(key); });
      for (var entry in snapshot) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, entry)) continue;
        if (entry === ANALYTICS_KEY) continue;
        if (permitted(entry) && typeof snapshot[entry] === 'string') localStorage.setItem(entry, snapshot[entry]);
      }
      try { if (typeof renderAll === 'function') renderAll(); } catch (_) { /* view refresh best-effort */ }
      try { if (typeof crm21Refresh === 'function') crm21Refresh(); } catch (_) { /* ignore */ }
    } finally { applying = false; }
  }

  /* Conflict recovery: the other device saved first. Keep sync ALIVE —
     back up the divergent local state (never silently destroy work), adopt
     the newer server snapshot, and continue from its version. */
  async function recoverFromConflict() {
    try {
      try {
        localStorage.setItem('sr-conflict-backup', JSON.stringify({ at: new Date().toISOString(), snapshot: collect() }));
      } catch (_) { /* backup is best-effort */ }
      var result = await client.from('app_state').select('version, snapshot').maybeSingle();
      if (result.error) throw new Error(result.error.message || 'read failed');
      var data = result.data || { version: 0, snapshot: {} };
      revision = Number(data.version) || 0;
      publishRevision();
      restore(data.snapshot || {});
      announce('online', 'Boshqa qurilmadagi o‘zgarishlar yuklandi · v' + revision);
    } catch (_) {
      delayed = true;
      announce('error', 'Yangilashda xatolik — qayta uriniladi');
    }
  }

  async function flush() {
    if (!syncActive || applying) return;
    if (busy) { delayed = true; return; }
    busy = true;
    announce('syncing', 'Saqlanmoqda...');
    try {
      adoptSharedRevision();
      var result = await client.rpc('save_app_state', { expected_version: revision, new_snapshot: collect() });
      if (result.error) {
        var error = new Error(result.error.message || 'save failed');
        error.code = result.error.code;
        throw error;
      }
      revision = Number(result.data) || revision + 1;
      publishRevision();
      announce('online', 'Saqlandi · v' + revision);
    } catch (error) {
      var message = String(error.message || '');
      if (message.indexOf('version_conflict') !== -1) {
        await recoverFromConflict();
      } else if (error.code === '42501' || message.indexOf('forbidden') !== -1) {
        syncActive = false;
        announce('error', 'Saqlash uchun ruxsat yo‘q');
      } else {
        delayed = true;
        announce('error', 'Ulanish vaqtincha uzildi');
      }
    } finally {
      busy = false;
      if (delayed && syncActive) { delayed = false; timer = window.setTimeout(flush, 2200); }
    }
  }

  function notify() {
    if (!syncActive || applying) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(flush, 900);
  }

  function hookSync() {
    var original = window.db_set;
    if (typeof original === 'function' && !original.srWrapped) {
      var wrapped = function (key, value) {
        var output = original.apply(this, arguments);
        if (permitted(key)) notify();
        return output;
      };
      wrapped.srWrapped = true;
      window.db_set = wrapped;
    }
    window.addEventListener('storage', function (event) {
      if (event.key === WS_REVISION_KEY) { adoptSharedRevision(); return; }
      if (permitted(event.key)) notify();
    });
    window.addEventListener('online', notify);
  }

  /* ------------------------- session readiness -------------------------- */

  window.smartRetailAuthReady = client.auth.getSession().then(function (result) {
    var session = result && result.data ? result.data.session : null;
    if (!session) {
      purgeSupabaseStorage();
      window.location.replace('/login.html');
      return new Promise(function () {});
    }
    setAuthCookie(session.access_token, 7 * 24 * 3600);
    client.auth.onAuthStateChange(function (event, freshSession) {
      if (freshSession && freshSession.access_token) setAuthCookie(freshSession.access_token, 7 * 24 * 3600);
      if (event === 'SIGNED_OUT' && !signingOut) {
        setAuthCookie('', 0);
        window.location.replace('/login.html');
      }
    });

    // A failed lookup (network blip, RLS hiccup) is NOT the same as a
    // blocked account — only a successful read saying active=false (or
    // expired) may ever sign the user out. Retries with backoff instead.
    function fetchProfile(attempt) {
      return client.from('profiles')
        .select('username, active, expires_at, erp_role, workspace_owner, erp_modules')
        .eq('id', session.user.id).single()
        .then(function (profileResult) {
          if (!profileResult.data && profileResult.error) {
            var wait = Math.min(30000, 3000 * Math.pow(2, Math.min(attempt, 4)));
            return new Promise(function (resolve) { window.setTimeout(resolve, wait); })
              .then(function () { return fetchProfile(attempt + 1); });
          }
          return profileResult.data;
        });
    }

    return fetchProfile(0)
      .then(function (profile) {
        var expired = profile && profile.expires_at && new Date(profile.expires_at).getTime() <= Date.now();
        if (!profile || !profile.active || expired) {
          signingOut = true;
          try { client.auth.signOut(); } catch (_) { /* ignore */ }
          wipeLocalWorkspace();
          purgeSupabaseStorage();
          setAuthCookie('', 0);
          window.location.replace('/login.html');
          return new Promise(function () {});
        }
        var role = (profile.workspace_owner || profile.erp_role === 'STAFF') ? 'STAFF' : 'OWNER';
        var name = profile.username || session.user.email || '';
        var modules = Array.isArray(profile.erp_modules) ? profile.erp_modules : [];
        try {
          localStorage.setItem(ERP_PROFILE_KEY, JSON.stringify({ id: session.user.id, role: role, name: name, modules: modules }));
        } catch (_) { /* ignore */ }
        seedErpAuth(role, name, session.user.id, modules);
        tryUnlock();
        var employeeReconcile = null;
        if (role === 'OWNER') {
          domReady.then(function () {
            try { employeeReconcile = hookEmployeeManagement(); } catch (error) { console.warn('Employee management unavailable:', error.message); }
          });
        }

        // Restore only after the ERP has fully parsed: its inline first-run
        // initializers must never execute AFTER the restore, or they would
        // reset the freshly restored store. Retries with backoff so a
        // connectivity blip never leaves the ERP usable-but-unsynced.
        function initialPull(attempt) {
          return domReady.then(function () {
            return client.from('app_state').select('version, snapshot').maybeSingle();
          }).then(function (stateResult) {
            if (stateResult.error) throw new Error(stateResult.error.message || 'read failed');
            var data = stateResult.data || { version: 0, snapshot: {} };
            revision = Number(data.version) || 0;
            publishRevision();
            if (revision && data.snapshot && Object.keys(data.snapshot).length) restore(data.snapshot);
            syncActive = true;
            announce('online', revision ? 'Ulangan · v' + revision : 'Ulangan');
            tryUnlock();
            // Only reconcile employees AFTER the initial restore has landed —
            // running it concurrently let restore()'s server snapshot
            // silently overwrite a just-applied prune with stale data.
            if (role === 'OWNER') {
              (employeeReconcile ? Promise.resolve(employeeReconcile) : domReady.then(hookEmployeeManagement))
                .then(function (fn) { return fn && fn(); })
                .catch(function (error) { console.warn('Employee reconcile unavailable:', error.message); });
            }
          }).catch(function () {
            announce('error', 'Bazaga ulanib bo‘lmadi — qayta urinilmoqda');
            var wait = Math.min(30000, 3000 * Math.pow(2, Math.min(attempt, 4)));
            return new Promise(function (resolve) { window.setTimeout(resolve, wait); })
              .then(function () { return initialPull(attempt + 1); });
          });
        }
        return initialPull(0).then(function () { return session; });
      });
  });
})();
