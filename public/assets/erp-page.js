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
  /* Which Supabase project this terminal's local data belongs to — see
     fenceForeignProject() below and the same fence in auth-guard.js. */
  var PROJECT_REF_KEY = 'sr-supabase-ref';
  var PROJECT_REF = (function () {
    try { return new URL(config.supabaseUrl).hostname.split('.')[0] || ''; } catch (_) { return ''; }
  })();
  var ANALYTICS_KEY = 'srerp_analytics_parent_state';
  // How long logout waits for the final sync push before giving up on it.
  var LOGOUT_FLUSH_MS = 8000;
  var signingOut = false;

  /* Rollout switch for the per-key Postgres store (workspace-store.js,
     supabase/2026-09-01-workspace-kv.sql). While it is off this file
     behaves exactly as before, snapshot engine and all.

     `?kv=1` turns it on for this terminal and remembers the choice;
     `?kv=0` turns it back off. Read here, at parse time, because the
     store is about to replace window.localStorage with a shim and this
     answer must come from the real one. */
  var store = window.smartRetailWorkspaceStore || null;

  /* Whether the Postgres data layer is live. The switch itself lives in
     workspace-store.js (see STORE_ENABLED there) because build.mjs reads
     it from that file to decide whether to mark the ERP's inline scripts
     inert — a build that defers them while this file declines to execute
     them would produce a blank till.

     This is deliberately NOT a per-terminal choice any more. Once the
     build defers those scripts, a terminal that opted out would simply
     never run them.

     History, because it constrains the design: the first attempt installed
     the shim before the ERP's scripts parsed but hydrated afterwards. The
     ERP therefore booted against an EMPTY store, cached empty arrays in
     its module-level variables, and wrote them straight back — emptying
     srerp_cells (6 249 rows), srerp_products and srerp_receipts_v13 in the
     live workspace. Discarding the pre-hydration write queue does not fix
     it: those writes arrive AFTER hydration and are indistinguishable from
     real edits. Nothing downstream of that ordering is safe, so the ERP's
     scripts now do not run at all until the store is full. */
  var KV_MODE = !!(store && store.enabled);

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
        // This project's session only — a token left by a previous project
        // names a user the current one has never heard of.
        if (key && key.indexOf('sb-') === 0 && key.slice(-11) === '-auth-token'
            && (!PROJECT_REF || key === 'sb-' + PROJECT_REF + '-auth-token')) {
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

  /* Matches every browser key the app owns — see the same predicate in
     auth-guard.js: the v26 modules added "uzum_analytics_", "uzum_market_"
     and "uzum-sales-" keys that a two-prefix check left behind for the
     next account on this browser. */
  function isWorkspaceKey(key) {
    return typeof key === 'string' && /^(srerp_|uzum[-_])/.test(key);
  }

  /* Clear this TERMINAL — never delete the workspace.

     While the data lived in the browser those were the same operation, so
     logout and the account-switch guard simply removed the keys. Under the
     Postgres store they are opposites: window.localStorage is a shim whose
     removeItem queues a DELETE against the shared workspace row, so the
     plain loop below would have a cashier erase the whole shop by logging
     out. Everything here therefore goes through the store's real-storage
     handle, and the workspace is dropped from memory with forget(), which
     touches no rows. */
  function wipeLocalWorkspace() {
    try {
      var device = store && KV_MODE ? store.raw : {
        removeItem: function (key) { localStorage.removeItem(key); },
        key: function (index) { return localStorage.key(index); },
        count: function () { return localStorage.length; }
      };
      var doomed = [];
      for (var index = 0; index < device.count(); index += 1) {
        var key = device.key(index);
        if (isWorkspaceKey(key)) doomed.push(key);
      }
      doomed.forEach(function (key) { device.removeItem(key); });
      if (store && KV_MODE) store.forget();
      var doomedSession = [];
      for (var position = 0; position < sessionStorage.length; position += 1) {
        var sessionKey = sessionStorage.key(position);
        if (isWorkspaceKey(sessionKey)) doomedSession.push(sessionKey);
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

  /* Drop everything a previous Supabase project left on this terminal, once,
     on the first load after the project changes. Same fence as
     auth-guard.js — a till reached through /erp.html never loads that file,
     so it needs its own copy. See the long note there for why a stale
     `sb-<oldref>-auth-token` is dangerous rather than merely untidy. */
  function fenceForeignProject() {
    if (!PROJECT_REF) return;
    var foreign = [];
    var previous = null;
    try {
      previous = localStorage.getItem(PROJECT_REF_KEY);
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf('sb-') === 0 && key.indexOf('sb-' + PROJECT_REF + '-') !== 0) {
          foreign.push(key);
        }
      }
    } catch (_) { return; /* storage unreadable — nothing safe to do */ }

    if (!foreign.length && previous !== null && previous === PROJECT_REF) return;
    if (!foreign.length) {
      try { localStorage.setItem(PROJECT_REF_KEY, PROJECT_REF); } catch (_) { /* ignore */ }
      return;
    }

    foreign.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    });
    wipeLocalWorkspace();
    try {
      localStorage.removeItem(ACTIVE_USER_KEY);
      localStorage.removeItem(ERP_PROFILE_KEY);
      localStorage.removeItem('sr-username');
      localStorage.removeItem('sr-ws-revision');
      localStorage.removeItem('sr-conflict-backup');
      localStorage.removeItem('sr-pending-changes');
      localStorage.setItem(PROJECT_REF_KEY, PROJECT_REF);
    } catch (_) { /* ignore */ }
    setAuthCookie('', 0);
    console.warn('Smart Retail ERP: cleared local data left by a previous Supabase project.');
  }

  /* ------------------------------ boot ---------------------------------- */

  fenceForeignProject();

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
      localStorage.removeItem(PENDING_KEY);
      localStorage.setItem(ACTIVE_USER_KEY, stored.id);
    } catch (_) { /* ignore */ }
  }

  /* The shim has to be in place before the ERP's own scripts parse — they
     read storage immediately — but AFTER the account-switch wipe above,
     which is about this device and must never reach the database. It
     starts empty; start() below fills it, and nothing is sent until then. */
  if (KV_MODE) store.install();

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
    // The snapshot engine and the store must never both be live: they
    // would write the same data to two different places.
    if (!KV_MODE) hookSync();
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
    /* Lock the terminal immediately: the cookie the middleware checks and
       the ERP's own per-tab session both go now, so nobody can pick this
       till up mid-logout.

       The supabase-js session is NOT purged here. It lives only in the
       `sb-*-auth-token` localStorage entry — the vendored client re-reads
       it on every request — so purging first made the farewell push
       authenticate as `anon`, RLS rejected it, and the shift's last sales
       could never reach the database. It is purged below, after the push
       has had its chance. */
    setAuthCookie('', 0);
    try {
      sessionStorage.removeItem('srerp_auth_session_v6');
      sessionStorage.removeItem('srerp_analytics_erp_access_v22');
    } catch (_) { /* ignore */ }
    var pendingFlush = Promise.resolve();
    try {
      if (KV_MODE) pendingFlush = Promise.resolve(store.flush()).catch(function () {});
      else if (syncActive) pendingFlush = flush().catch(function () {});
    } catch (_) { /* ignore */ }
    var cap = new Promise(function (resolve) { window.setTimeout(resolve, LOGOUT_FLUSH_MS); });
    Promise.race([pendingFlush, cap]).then(function () {
      // Revoke server-side while the session is still readable, then purge.
      try { client.auth.signOut(); } catch (_) { /* fire and forget */ }
      /* Stop the engine before anything below erases local data. Every
         localStorage write now feeds the engine, so the wipe itself would
         otherwise be announced as a change and re-arm the unsent-work
         marker this logout just cleared. */
      syncActive = false;
      if (KV_MODE) store.suspend();
      purgeSupabaseStorage();
      /* Auth material is always gone by now. The shift's data may only be
         erased once the database actually has it — wiping a till whose
         last push never landed destroys those sales with no copy left.
         What stays behind is still isolated: a different account signing
         in on this terminal wipes it, and the same account resends it. */
      var unsent = KV_MODE ? store.status().unsent > 0 : pending;
      if (unsent) {
        window.location.replace('/login.html?unsaved=1');
        return;
      }
      wipeLocalWorkspace();
      try {
        localStorage.removeItem(ACTIVE_USER_KEY);
        localStorage.removeItem(ERP_PROFILE_KEY);
        localStorage.removeItem('sr-username');
        localStorage.removeItem('sr-ws-revision');
        localStorage.removeItem('sr-conflict-backup');
        localStorage.removeItem(PENDING_KEY);
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
  var PENDING_KEY = 'sr-pending-changes';
  var pending = false;
  var pendingSeq = 0;

  /* Unsent-change marker — see the same block in supabase-sync.js. A till
     that loses its connection mid-shift keeps its sales here; without this
     the next boot restores the older server snapshot straight over them.
     The account id is stored with it: staff and owner share ONE app_state
     row, so a marker a staff member left behind would otherwise match the
     owner's server version exactly and make the owner's boot push a wiped
     key space over the whole workspace. */
  function markPending() {
    pending = true;
    pendingSeq += 1;
    // Always (re)write — another tab may have cleared the shared key.
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ u: stored ? stored.id : '', v: revision }));
    } catch (_) { /* ignore */ }
  }
  function clearPending() {
    pending = false;
    try { localStorage.removeItem(PENDING_KEY); } catch (_) { /* ignore */ }
  }
  function pendingBaseline() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (raw === null) return null;
      var parsed = JSON.parse(raw);
      // A bare number is the pre-namespacing format: unattributable, ignore it.
      if (!parsed || typeof parsed !== 'object') return null;
      if (String(parsed.u || '') !== String(stored ? stored.id : '')) return null;
      return Number(parsed.v) || 0;
    } catch (_) { return null; }
  }

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

  /* Interface language is a device preference, not workspace data — see
     the same block in supabase-sync.js. Without this a till that its
     cashier switched to Russian is back in Uzbek after every reload. */
  var DEVICE_PREFERENCE = /^srerp_interface_language_v\d+$/;

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !DEVICE_PREFERENCE.test(key)
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
      clearPending(); // local now mirrors the server; the divergence is in the backup
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
    firstChangeAt = 0; // the max-wait window restarts with the next change
    var flushedSeq = pendingSeq; // changes arriving mid-RPC are not covered
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
      if (pendingSeq === flushedSeq) clearPending();
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

  /* Coalesce a burst of writes into one push, but never postpone a push
     indefinitely. A till writes continuously while a sale is being rung
     up, and a debounce that restarts on every change then never fires:
     the shift's work stayed in the browser until logout swept it up. */
  var DEBOUNCE_MS = 900;
  var MAX_DEBOUNCE_MS = 4000;
  var SAFETY_FLUSH_MS = 15000;
  var REMOTE_POLL_MS = 12000;
  var firstChangeAt = 0;
  var storagePatched = false;

  function notify() {
    if (!syncActive || applying || signingOut) return;
    markPending();
    var now = Date.now();
    if (!firstChangeAt) firstChangeAt = now;
    window.clearTimeout(timer);
    var wait = Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_DEBOUNCE_MS - now));
    timer = window.setTimeout(flush, wait);
  }

  /* Several people share one account (two cashiers on two tills, the owner
     in the office). Each terminal used to sit on its own local copy with
     nothing ever pulling the others' work in, so a till only learned about
     the rest of the workspace when a push happened to collide. Poll the
     row's version -- one small column -- and adopt a newer snapshot as soon
     as another terminal publishes one.

     Skipped while this terminal holds unsent work: that is the flush's
     version_conflict path, which backs the local state up before adopting
     the server's, and must not be pre-empted by a silent overwrite. */
  async function pullRemote() {
    if (!syncActive || busy || applying || pending || signingOut) return;
    busy = true;
    try {
      adoptSharedRevision();
      var head = await client.from('app_state').select('version').maybeSingle();
      if (head.error || !head.data) return;
      if ((Number(head.data.version) || 0) <= revision) return;
      var full = await client.from('app_state').select('version, snapshot').maybeSingle();
      if (full.error || !full.data) return;
      var next = Number(full.data.version) || 0;
      // A write landed here while the snapshot was in flight -- leave it to
      // flush(), which protects it, rather than restoring straight over it.
      if (next <= revision || pending) return;
      revision = next;
      publishRevision();
      restore(full.data.snapshot || {});
      announce('online', 'Yangilandi \u00b7 v' + revision);
    } catch (_) {
      /* the next tick retries */
    } finally {
      busy = false;
      if (delayed && syncActive) { delayed = false; timer = window.setTimeout(flush, 800); }
    }
  }

  /* db_set is only ONE of the ERP's write paths. Large parts of it (WMS,
     cells, orders, waybills, purchases, settings, audit) call
     localStorage.setItem directly, and those writes were never announced
     to the sync engine -- so they sat in the browser for the whole shift
     and only reached the database at logout, when flush()'s collect()
     re-read localStorage and swept them up. That is precisely the reported
     symptom. Patching the Storage prototype makes EVERY write path notify
     the engine, whichever module performed it. */
  function hookStorageWrites() {
    var proto = window.Storage && window.Storage.prototype;
    if (!proto || storagePatched) return;
    storagePatched = true;
    var setItem = proto.setItem;
    var removeItem = proto.removeItem;
    var clearAll = proto.clear;
    /* sessionStorage shares this prototype, so every hook checks that it
       was localStorage that was written. The engine's own bookkeeping keys
       (sr-pending-changes, sr-ws-revision) are not `permitted`, so
       markPending()/publishRevision() cannot recurse back in here. */
    proto.setItem = function (key, value) {
      var output = setItem.apply(this, arguments);
      try { if (this === window.localStorage && permitted(key)) notify(); } catch (_) { /* ignore */ }
      return output;
    };
    proto.removeItem = function (key) {
      var output = removeItem.apply(this, arguments);
      try { if (this === window.localStorage && permitted(key)) notify(); } catch (_) { /* ignore */ }
      return output;
    };
    proto.clear = function () {
      var output = clearAll.apply(this, arguments);
      try { if (this === window.localStorage) notify(); } catch (_) { /* ignore */ }
      return output;
    };
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
    hookStorageWrites();
    window.addEventListener('storage', function (event) {
      if (event.key === WS_REVISION_KEY) { adoptSharedRevision(); return; }
      if (permitted(event.key)) notify();
    });
    window.addEventListener('online', notify);

    /* Last-resort net: anything the hooks still miss (a write made while
       `applying` was set, a flush that failed and left work behind) goes
       up on the next tick instead of waiting for the logout button. */
    window.setInterval(function () {
      if (syncActive && pending && !busy && !applying && !signingOut) flush();
    }, SAFETY_FLUSH_MS);

    /* A till is closed, locked or switched away from far more often than
       it is logged out of. Push whatever is unsent at that moment. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && pending) flush();
    });
    window.addEventListener('pagehide', function () { if (pending) flush(); });

    window.setInterval(pullRemote, REMOTE_POLL_MS);
  }

  /* --------------------- Postgres-backed store boot --------------------- */

  var rerenderTimer = null;

  /* Run the ERP's own scripts, which build.mjs marked inert so they could
     not boot against an empty store. Document order is preserved and each
     block is re-inserted as a real script element, so it still evaluates
     in global scope exactly as it would have during parsing. */
  function runDeferredScripts() {
    var blocks = document.querySelectorAll('script[type="text/sr-deferred"]');
    if (!blocks.length) return 0;
    for (var index = 0; index < blocks.length; index += 1) {
      var inert = blocks[index];
      var live = document.createElement('script');
      for (var position = 0; position < inert.attributes.length; position += 1) {
        var attribute = inert.attributes[position];
        if (attribute.name.toLowerCase() !== 'type') live.setAttribute(attribute.name, attribute.value);
      }
      live.text = inert.textContent;
      // Replacing the node executes it synchronously, in order.
      inert.parentNode.replaceChild(live, inert);
    }
    /* Those blocks register ~53 DOMContentLoaded listeners and several
       load listeners. Both events fired long ago, while the blocks were
       still inert, so every one of them would otherwise never be called.
       Re-dispatch now that the listeners actually exist. */
    try { document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (_) { /* ignore */ }
    try { window.dispatchEvent(new Event('load')); } catch (_) { /* ignore */ }
    return blocks.length;
  }

  function rerenderErp() {
    try { if (typeof renderAll === 'function') renderAll(); } catch (_) { /* best effort */ }
    try { if (typeof crm21Refresh === 'function') crm21Refresh(); } catch (_) { /* ignore */ }
  }

  /* Deliberately gated on domReady, for the same reason the snapshot
     restore was: the ERP's inline first-run initialisers must have run to
     completion before the real data lands, or they reset it right after.
     Everything they wrote in the meantime is discarded by hydrate(), which
     is why nothing is sent to the database before this point. */
  function startWorkspaceStore(profile, session, attempt) {
    var workspace = profile.workspace_owner || session.user.id;
    store.subscribe(function (state, label) { announce(state, label); });
    return domReady
      .then(function () {
        return store.start(client, workspace, function () {
          // Another terminal changed a key. Coalesce: a burst of remote
          // rows should cost one re-render, not one per row.
          window.clearTimeout(rerenderTimer);
          rerenderTimer = window.setTimeout(rerenderErp, 150);
        }, { exclude: [ANALYTICS_KEY] });
      })
      .then(function (count) {
        /* Only now is it safe to let the ERP run: every key it is about to
           read is already in the store. */
        var executed = runDeferredScripts();
        /* These wrap functions the ERP itself defines, so the earlier
           attempt at DOMContentLoaded found nothing to wrap. */
        hookLogout();
        if (!profile.workspace_owner && profile.erp_role !== 'STAFF') {
          try {
            var reconcile = hookEmployeeManagement();
            if (typeof reconcile === 'function') {
              Promise.resolve(reconcile()).catch(function (error) {
                console.warn('Employee reconcile unavailable:', error.message);
              });
            }
          } catch (error) { console.warn('Employee management unavailable:', error.message); }
        }
        rerenderErp();
        tryUnlock();
        announce('online', 'Bazaga ulangan \u00b7 ' + count + ' kalit');
        return executed;
      })
      .catch(function (error) {
        console.warn('Workspace store unavailable:', error.message);
        announce('error', 'Bazadan yuklab bo\u2018lmadi \u2014 qayta urinilmoqda');
        var wait = Math.min(30000, 3000 * Math.pow(2, Math.min(attempt || 0, 4)));
        return new Promise(function (resolve) { window.setTimeout(resolve, wait); })
          .then(function () { return startWorkspaceStore(profile, session, (attempt || 0) + 1); });
      });
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
          syncActive = false;
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
            var serverVersion = Number(data.version) || 0;
            var baseline = pendingBaseline();
            /* Work this terminal never managed to send (connection dropped
               mid-shift, tab closed, machine slept) must not be erased by
               the older server snapshot — decide which side is newer. */
            if (baseline !== null && serverVersion === baseline) {
              // Nothing was written elsewhere: this terminal holds the
              // newest state. Keep it and push it up.
              revision = serverVersion;
              publishRevision();
              /* restore() is deliberately skipped here, but it is also what
                 normally fills `carried` — the owner's analytics entry that
                 this page never edits and must hand back untouched. Without
                 this the recovery push would drop it from the workspace. */
              carried = {};
              if (data.snapshot && typeof data.snapshot[ANALYTICS_KEY] === 'string') {
                carried[ANALYTICS_KEY] = data.snapshot[ANALYTICS_KEY];
              }
              pending = true;
              syncActive = true;
              announce('syncing', 'Saqlanmagan o‘zgarishlar yuborilmoqda...');
              notify();
            } else {
              if (baseline !== null && serverVersion > baseline) {
                // Another device wrote while this one was offline: the
                // server wins, but keep the divergent state recoverable.
                try {
                  localStorage.setItem('sr-conflict-backup', JSON.stringify({ at: new Date().toISOString(), snapshot: collect() }));
                } catch (_) { /* backup is best-effort */ }
              }
              clearPending();
              revision = serverVersion;
              publishRevision();
              if (revision && data.snapshot && Object.keys(data.snapshot).length) restore(data.snapshot);
              syncActive = true;
              announce('online', revision ? 'Ulangan · v' + revision : 'Ulangan');
            }
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
        if (KV_MODE) return startWorkspaceStore(profile, session).then(function () { return session; });
        return initialPull(0).then(function () { return session; });
      });
  });
})();
