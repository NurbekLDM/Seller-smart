/* Parent application synchronization via Supabase: analytics IndexedDB state
   + ERP localStorage are stored as one versioned snapshot in the shared
   app_state table. Exposes window.smartRetailAnalyticsServerSync with the
   same interface as the previous server build, so the embedded ERP module
   coordinates through it unchanged. */
(function smartRetailSupabaseSync() {
  'use strict';

  if (!/^https?:$/.test(window.location.protocol)) return;

  var ANALYTICS_KEY = 'srerp_analytics_parent_state';
  var WS_REVISION_KEY = 'sr-ws-revision';
  var PENDING_KEY = 'sr-pending-changes';
  var revision = 0;
  var active = false;
  var pending = false;
  var pendingSeq = 0;      // bumped per change; guards the clear below
  var workspaceUser = '';  // the account this marker belongs to

  /* Unsent-change marker, persisted so it survives a reload, a crash or a
     closed laptop. Without it the boot restore below cannot tell "this
     device is behind the database" from "this device holds work the
     database never received", and silently overwrites the second case
     with the older server snapshot.

     It records the account id alongside the server version the unsent work
     was built on. The id is essential: a bare version number means nothing
     outside the workspace that wrote it, and a marker left by the previous
     user could match the NEXT user's server version, skip their restore
     and push a freshly wiped key space over their workspace. */
  function markPending() {
    pending = true;
    pendingSeq += 1;
    // Always (re)write, never short-circuit on the in-memory flag: another
    // tab may have removed the shared key after ITS successful flush while
    // this tab still holds changes of its own.
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ u: workspaceUser, v: revision }));
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
      if (String(parsed.u || '') !== String(workspaceUser || '')) return null;
      return Number(parsed.v) || 0;
    } catch (_) { return null; }
  }

  // Workspace version shared across tabs/pages (the staff ERP page uses the
  // same key), so no writer pushes with a stale expected_version.
  function adoptSharedRevision() {
    try {
      var shared = Number(localStorage.getItem(WS_REVISION_KEY)) || 0;
      if (shared > revision) revision = shared;
    } catch (_) { /* ignore */ }
  }
  function publishRevision() {
    try { localStorage.setItem(WS_REVISION_KEY, String(revision)); } catch (_) { /* ignore */ }
  }
  var applying = false;
  var busy = false;
  var delayed = false;
  var timeout = null;
  var subscribers = new Set();

  /* Coalesce a burst of writes into one push, but never postpone a push
     indefinitely: a debounce that restarts on every change never fires
     while the user keeps working, which left the whole session's work in
     the browser until the logout button forced the final flush. */
  var DEBOUNCE_MS = 900;
  var MAX_DEBOUNCE_MS = 4000;
  var SAFETY_FLUSH_MS = 15000;
  var REMOTE_POLL_MS = 12000;
  var firstChangeAt = 0;
  var storagePatched = false;

  function client() { return window.smartRetailSupabase || null; }

  /* ---------------------- Postgres-backed store path --------------------
     When the store is on, everything below this line that belongs to the
     snapshot engine stays inert: `active` is never set, so notify(),
     flush() and the poll are all no-ops, and the two engines can never
     both write. See STORE_ENABLED in workspace-store.js. */
  var store = window.smartRetailWorkspaceStore || null;
  var STORE_MODE = !!(store && store.enabled);

  /* The ERP document is opened two ways from this page: in the srcdoc
     iframe, and in its own window from a blob URL ("Yangi oynada ochish").
     Both are separate realms that must be pointed at this page's shim,
     and they reach it differently — an iframe through `parent`, a popup
     through `opener`. Looking only at `parent` left the popup with the
     real, empty browser store: the workspace lives in memory now, so the
     window opened with no data in it at all.

     If neither is reachable the ERP would boot against an empty store and
     look like an empty shop, so say what happened instead. */
  var FRAME_BOOTSTRAP = '<script id="srStoreFrameBootstrap">(function(){'
    + 'function host(){'
    + 'try{if(window.parent&&window.parent!==window&&window.parent.smartRetailWorkspaceStore)return window.parent;}catch(e){}'
    + 'try{if(window.opener&&window.opener.smartRetailWorkspaceStore)return window.opener;}catch(e){}'
    + 'return null;}'
    + 'var h=host();'
    + 'if(h){try{var m=h.smartRetailWorkspaceStore.shim();'
    + 'Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return m;}});return;}catch(e){}}'
    + 'function warn(){try{var d=document.createElement("div");'
    + 'd.setAttribute("style","position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;'
    + 'background:#07111f;color:#dbe6f7;font:600 14px -apple-system,sans-serif;text-align:center;padding:24px");'
    + 'd.innerHTML="<div style=\'max-width:340px;line-height:1.6\'>Ma\u2019lumot manbai topilmadi.<br>'
    + 'Bu oynani asosiy ERP oynasidan oching va uni yopmang.</div>";'
    + 'document.documentElement.appendChild(d);}catch(e){}}'
    + 'if(document.body)warn();else document.addEventListener("DOMContentLoaded",warn,{once:true});'
    + '})();<' + '/script>';

  function bootstrapFrameHtml(html) {
    if (typeof html !== 'string' || html.indexOf('srStoreFrameBootstrap') !== -1) return html;
    var head = /<head[^>]*>/i.exec(html);
    if (!head) return html;

    /* Retire the ERP's own VPS-era sync engine before this copy runs.

       crm21ServerSync reads every srerp_* key, pushes them to /api/v1 -
       gone, so it 404s on every load - and on a pull writes and REMOVES
       keys through localStorage, which in this frame is the shim: it would
       be writing and deleting in the database, alongside the store.

       scripts/build.mjs disables it in public/erp.html, but this copy is
       decoded from base64 at run time and never passes through the build,
       so it has to be disabled here. A type nothing executes, rather than
       a deletion, so the block is one word from coming back. */
    html = html.replace(/<script(\s+id="crm21ServerSync")/i,
      '<script type="text/sr-disabled"$1');

    var at = head.index + head[0].length;
    return html.slice(0, at) + FRAME_BOOTSTRAP + html.slice(at);
  }

  /* Assigning srcdoc boots the entire ERP, so the frame must not be built
     before the workspace has arrived: an ERP that boots against an empty
     store caches empty arrays in its module variables and writes them back
     over the real rows. Both of the page's own globals are wrapped. */
  function guardErpFrame() {
    if (typeof window.getSmartRetailErpHtml === 'function' && !window.getSmartRetailErpHtml.srStorePatched) {
      var buildHtml = window.getSmartRetailErpHtml;
      var withBootstrap = function () { return bootstrapFrameHtml(buildHtml.apply(this, arguments)); };
      withBootstrap.srStorePatched = true;
      window.getSmartRetailErpHtml = withBootstrap;
    }
    if (typeof window.initSmartRetailERP === 'function' && !window.initSmartRetailERP.srStoreGated) {
      var openErp = window.initSmartRetailERP;
      var gated = function guardedInitSmartRetailERP(forceReload) {
        if (!store.status().hydrated) {
          // Leave the existing spinner up and open as soon as we have data.
          try {
            var loading = document.getElementById('smartRetailErpLoading');
            if (loading) loading.style.display = 'grid';
          } catch (_) { /* the frame just opens a moment later */ }
          store.ready().then(function () { guardedInitSmartRetailERP(forceReload); });
          return;
        }
        return openErp.apply(this, arguments);
      };
      gated.srStoreGated = true;
      window.initSmartRetailERP = gated;
    }
  }

  /* The analytics module keeps its state in IndexedDB rather than
     localStorage, so it is the one part of the workspace the shim cannot
     capture by itself — it has to be read out of and written into the
     store explicitly, exactly as the snapshot engine had to do. */
  async function applyAnalytics(raw) {
    if (typeof raw !== 'string' || typeof deepMerge !== 'function') return;
    applying = true;
    try {
      state = deepMerge(DEFAULT_STATE, JSON.parse(raw));
      if (typeof saveState === 'function') await saveState();
      if (typeof rebuildAnalytics === 'function') rebuildAnalytics();
      if (typeof renderAll === 'function') renderAll();
    } catch (error) {
      console.warn('Analytics state could not be applied:', error.message);
    } finally { applying = false; }
  }

  function refreshErpFrame() {
    var frame = document.getElementById('smartRetailErpFrame');
    if (!frame || frame.dataset.loaded !== '1') return;
    try {
      if (frame.contentWindow && frame.contentWindow.renderAll) frame.contentWindow.renderAll();
      if (frame.contentWindow && frame.contentWindow.crm21Refresh) frame.contentWindow.crm21Refresh();
    } catch (_) { /* the frame can be reopened manually */ }
  }

  /* The app's own boot runs inline while the page is still parsing:
     init() reads location.hash and, for "#retailerp", builds the ERP frame
     right there — before this file (injected before </body>) has wrapped
     getSmartRetailErpHtml / initSmartRetailERP. That frame has no
     FRAME_BOOTSTRAP, so its localStorage is the browser's real, empty one:
     the ERP opens with 0 products and everything typed into it goes to
     the browser instead of the database. Reloading the frame by hand
     ("Qayta yuklash") fixed it, so do that automatically the moment the
     workspace has arrived. The srcdoc attribute is the definitive signal
     (the frame document may still be parsing). */
  function repairUnboundErpFrame() {
    var frame = document.getElementById('smartRetailErpFrame');
    if (!frame || frame.dataset.loaded !== '1') return false;
    var html = frame.getAttribute('srcdoc') || '';
    if (!html || html.indexOf('srStoreFrameBootstrap') !== -1) return false;
    console.warn('ERP frame booted before the workspace store — reloading it.');
    try {
      frame.dataset.loaded = '0';
      if (typeof window.initSmartRetailERP === 'function') window.initSmartRetailERP(true);
      return true;
    } catch (error) {
      console.warn('ERP frame reload failed:', error.message);
      return false;
    }
  }

  async function startStore(session, profile) {
    var workspace = profile.workspace_owner || session.user.id;
    store.install();
    store.subscribe(function (state, label) { announce(state, label); });
    // The page's globals exist by now (this file is injected before
    // </body>), but re-run after DOM ready in case of a slow definition.
    guardErpFrame();
    document.addEventListener('DOMContentLoaded', guardErpFrame);

    await store.start(client(), workspace, function (key) {
      if (key === ANALYTICS_KEY) { applyAnalytics(localStorage.getItem(ANALYTICS_KEY)); return; }
      refreshErpFrame();
    });
    repairUnboundErpFrame();
    document.addEventListener('DOMContentLoaded', repairUnboundErpFrame);

    await applyAnalytics(localStorage.getItem(ANALYTICS_KEY));

    if (typeof saveState === 'function') {
      var originalSave = saveState;
      saveState = async function storeAwareSaveState() {
        var output = await originalSave.apply(this, arguments);
        // Skipped while applyAnalytics() is installing a value that came
        // FROM the store — otherwise every remote update echoes back.
        if (!applying && typeof cloneState === 'function') {
          try { localStorage.setItem(ANALYTICS_KEY, JSON.stringify(cloneState())); } catch (_) { /* ignore */ }
        }
        return output;
      };
    }

    guardErpFrame();

    if (!profile.workspace_owner) {
      try { initVersionPanel(); } catch (error) { console.warn('Version panel unavailable:', error.message); }
      /* The snapshot engine took an automatic version inside every save.
         Per-key writes have no such moment, so the client asks for one at
         sign-in and hourly after that; snapshot_workspace_kv() keeps at
         most one an hour and prunes to the newest 72, so an extra call
         costs nothing. */
      var takeVersion = function () {
        client().rpc('snapshot_workspace_kv', { version_label: '' })
          .then(function (result) {
            if (result.error) console.warn('Automatic version failed:', result.error.message);
          });
      };
      takeVersion();
      window.setInterval(takeVersion, 3600000);
    }

    announce('online', 'Bazaga ulangan');
  }

  /* Interface language belongs to the device, not the workspace. The i18n
     module writes it straight to localStorage — never through saveState()
     or db_set() — so the engine is never told it changed and never pushes
     it. It then sits inside the synced key space with no entry on the
     server, and the next boot's restore deletes it (absent from the
     snapshot) or resets it to a stale value: the user picks RU, reloads,
     and is back in Uzbek. Keeping it out of the snapshot fixes that and
     lets a shop run its till and its office in different languages.
     (srerp_theme does NOT belong here — it goes through db_set, so it is
     pushed properly and syncing it is intentional.) */
  var DEVICE_PREFERENCE = /^srerp_interface_language_v\d+$/;

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !DEVICE_PREFERENCE.test(key)
      // initialized/seeded markers are device-local: syncing or removing
      // them re-triggers the ERP's first-run store reset on other devices.
      && !/password|secret|credential|session|token|pin|auth_users|initialized|seeded/i.test(key);
  }

  function announce(status, label) {
    subscribers.forEach(function (subscriber) {
      try { subscriber(status, label); } catch (_) { /* Subscriber errors do not stop persistence. */ }
    });
    var frame = document.getElementById('smartRetailErpFrame');
    try {
      var indicator = frame && frame.contentDocument ? frame.contentDocument.getElementById('crm21SyncState') : null;
      if (indicator) {
        indicator.dataset.state = status;
        var text = indicator.querySelector('span:last-child');
        if (text) text.textContent = label;
      }
    } catch (_) { /* Cross-origin frames are not supported. */ }
  }

  function collect() {
    var result = {};
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (permitted(key)) result[key] = localStorage.getItem(key);
    }
    if (typeof cloneState === 'function') result[ANALYTICS_KEY] = JSON.stringify(cloneState());
    return result;
  }

  async function restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    applying = true;
    try {
      var existing = [];
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (permitted(key)) existing.push(key);
      }
      existing
        .filter(function (key) { return !Object.prototype.hasOwnProperty.call(snapshot, key); })
        .forEach(function (key) { localStorage.removeItem(key); });
      for (var entry of Object.entries(snapshot)) {
        if (entry[0] !== ANALYTICS_KEY && permitted(entry[0]) && typeof entry[1] === 'string') {
          localStorage.setItem(entry[0], entry[1]);
        }
      }
      if (typeof snapshot[ANALYTICS_KEY] === 'string' && typeof deepMerge === 'function') {
        state = deepMerge(DEFAULT_STATE, JSON.parse(snapshot[ANALYTICS_KEY]));
        if (typeof saveState === 'function') await saveState();
        if (typeof rebuildAnalytics === 'function') rebuildAnalytics();
        if (typeof renderAll === 'function') renderAll();
      }
      var frame = document.getElementById('smartRetailErpFrame');
      if (frame && frame.dataset.loaded === '1') {
        try {
          if (frame.contentWindow && frame.contentWindow.renderAll) frame.contentWindow.renderAll();
          if (frame.contentWindow && frame.contentWindow.crm21Refresh) frame.contentWindow.crm21Refresh();
        } catch (_) { /* Frame can be reloaded manually. */ }
      }
    } finally { applying = false; }
  }

  async function readServerState() {
    // RLS returns only the caller's own workspace row (if it exists yet).
    var result = await client().from('app_state').select('version, snapshot').maybeSingle();
    if (result.error) {
      var error = new Error(result.error.message || 'Supabase read failed');
      error.code = result.error.code;
      throw error;
    }
    return result.data || { version: 0, snapshot: {} };
  }

  /* Conflict recovery: another device (or a staff terminal) saved first.
     Keep sync alive — back up the divergent local state, adopt the newer
     server snapshot, continue from its version. */
  async function recoverFromConflict() {
    try {
      try {
        localStorage.setItem('sr-conflict-backup', JSON.stringify({ at: new Date().toISOString(), snapshot: collect() }));
      } catch (_) { /* backup is best-effort */ }
      var data = await readServerState();
      revision = Number(data.version) || 0;
      publishRevision();
      await restore(data.snapshot || {});
      clearPending(); // local now mirrors the server; the divergence is in the backup
      announce('online', 'Boshqa qurilmadagi o‘zgarishlar yuklandi · v' + revision);
    } catch (_) {
      delayed = true;
      announce('error', 'Yangilashda xatolik — qayta uriniladi');
    }
  }

  async function flush() {
    if (!active || applying) return;
    if (busy) { delayed = true; return; }
    busy = true;
    firstChangeAt = 0; // the max-wait window restarts with the next change
    // Changes that land while the RPC is in flight are NOT covered by it.
    var flushedSeq = pendingSeq;
    announce('syncing', 'Bazaga saqlanmoqda...');
    try {
      adoptSharedRevision();
      var result = await client().rpc('save_app_state', {
        expected_version: revision,
        new_snapshot: collect()
      });
      if (result.error) {
        var error = new Error(result.error.message || 'Supabase save failed');
        error.code = result.error.code;
        throw error;
      }
      revision = Number(result.data) || revision + 1;
      publishRevision();
      // Only if no further change arrived while that RPC was in flight —
      // otherwise the newer edit would lose its protection.
      if (pendingSeq === flushedSeq) clearPending();
      announce('online', 'Bazada saqlandi · v' + revision);
    } catch (error) {
      var message = String(error.message || '');
      if (message.indexOf('version_conflict') !== -1) {
        await recoverFromConflict();
      } else if (error.code === '42501' || message.indexOf('forbidden') !== -1) {
        active = false;
        announce('error', 'Saqlash uchun ruxsat yo‘q');
      } else if (message.indexOf('JWT') !== -1 || error.code === 'PGRST301') {
        active = false;
        announce('error', 'Sessiya tugadi — qayta kiring');
        window.location.replace('/login.html');
      } else {
        delayed = true;
        announce('error', 'Bazaga ulanish vaqtincha uzildi');
      }
    } finally {
      busy = false;
      if (delayed && active) { delayed = false; timeout = window.setTimeout(flush, 2200); }
    }
  }

  function notify() {
    if (!active || applying) return;
    markPending();
    var now = Date.now();
    if (!firstChangeAt) firstChangeAt = now;
    window.clearTimeout(timeout);
    var wait = Math.max(0, Math.min(DEBOUNCE_MS, firstChangeAt + MAX_DEBOUNCE_MS - now));
    timeout = window.setTimeout(flush, wait);
  }

  /* Two or three people work one account at once (a cashier at the till,
     the owner in the office). Nothing used to pull another device's work
     in, so each browser sat on its own copy until a push happened to
     collide. Poll the row's version -- one small column -- and adopt a
     newer snapshot as soon as another device publishes one.

     Skipped while this device holds unsent work: that case belongs to
     flush()'s version_conflict path, which backs the divergent local state
     up before adopting the server's. */
  async function pullRemote() {
    if (!active || busy || applying || pending) return;
    busy = true;
    try {
      adoptSharedRevision();
      var head = await client().from('app_state').select('version').maybeSingle();
      if (head.error || !head.data) return;
      if ((Number(head.data.version) || 0) <= revision) return;
      var data = await readServerState();
      var next = Number(data.version) || 0;
      // A change landed here while the snapshot was in flight -- leave it
      // to flush(), which protects it, rather than restoring over it.
      if (next <= revision || pending) return;
      revision = next;
      publishRevision();
      await restore(data.snapshot || {});
      announce('online', 'Yangilandi \u00b7 v' + revision);
    } catch (_) {
      /* the next tick retries */
    } finally {
      busy = false;
      if (delayed && active) { delayed = false; timeout = window.setTimeout(flush, 800); }
    }
  }

  /* saveState() is only ONE of the write paths into the synced key space.
     The ERP modules write plenty of `srerp_*` keys with a direct
     localStorage.setItem, and those writes were never announced to the
     engine -- they sat in the browser and only reached the database at
     logout, when flush()'s collect() re-read localStorage and swept them
     up. Patching the Storage prototype makes every write path notify the
     engine, whichever module performed it. */
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

  window.smartRetailAnalyticsServerSync = {
    notify: notify,
    flush: function () { return STORE_MODE ? store.flush() : flush(); },
    subscribe: function (callback) {
      if (typeof callback !== 'function') return function () {};
      subscribers.add(callback);
      var live = STORE_MODE ? store.status().online : active;
      callback(live ? 'online' : 'local',
        live ? (STORE_MODE ? 'Baza bilan ulangan' : 'Baza bilan ulangan · v' + revision)
             : 'Bazaga ulanish tekshirilmoqda');
      return function () { subscribers.delete(callback); };
    },
    // `pending` is true while this device holds changes the database has
    // not accepted yet — logout checks it before wiping local data.
    status: function () {
      if (STORE_MODE) {
        var live = store.status();
        // `pending` is what logout consults before it erases anything.
        return { active: live.online, revision: 0, busy: live.flushing, pending: live.unsent > 0 };
      }
      return { active: active, revision: revision, busy: busy, pending: pending };
    },
    /* Stop the engine for good. Logout calls this before erasing local
       data: every localStorage write now feeds the engine, so the wipe
       itself would otherwise be announced as a change and re-arm the
       unsent-work marker the logout just cleared. */
    suspend: function () {
      /* Under the store this must FORGET, not merely pause. Logout calls
         it immediately before wiping the browser, and window.localStorage
         is a shim: a plain pause would leave the wipe queued in the outbox
         and replay it as a workspace-wide delete at the next login. */
      if (STORE_MODE) { store.forget(); return; }
      active = false;
      delayed = false;
      window.clearTimeout(timeout);
    },
    reload: async function () {
      var data = await readServerState();
      revision = Number(data.version) || 0;
      await restore(data.snapshot || {});
      clearPending();
      active = true;
      announce('online', 'Bazadan tiklandi · v' + revision);
      return revision;
    }
  };

  /* Admin-only version panel: list automatic hourly snapshots and named
     backups, create a named backup, restore any of them. */
  var VERSION_RPC = {
    list: 'list_app_state_versions',
    create: 'create_app_state_version',
    restore: 'restore_app_state_version',
    remove: 'delete_app_state_version'
  };
  var STORE_VERSION_RPC = {
    list: 'list_workspace_kv_versions',
    create: 'snapshot_workspace_kv',
    restore: 'restore_workspace_kv_version',
    remove: 'delete_workspace_kv_version'
  };
  function versionRpc() { return STORE_MODE ? STORE_VERSION_RPC : VERSION_RPC; }

  function initVersionPanel() {
    if (document.getElementById('srVersionPanelBtn')) return;

    var button = document.createElement('button');
    button.id = 'srVersionPanelBtn';
    button.textContent = '🕘 Versiyalar';
    button.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:99998;padding:8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(13,22,40,.92);color:#dbe6f7;font:600 12px -apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)';

    var panel = document.createElement('div');
    panel.id = 'srVersionPanel';
    panel.style.cssText = 'position:fixed;left:14px;bottom:56px;z-index:99999;display:none;width:min(430px,92vw);max-height:62vh;overflow:auto;padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(10,17,32,.97);color:#dbe6f7;font:13px -apple-system,"Segoe UI",sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.5)';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<strong>Baza versiyalari</strong>' +
      '<button id="srVersionClose" style="border:0;background:none;color:#8ea0bd;font-size:16px;cursor:pointer">✕</button></div>' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
      '<input id="srVersionLabel" placeholder="Backup nomi (masalan: iyul hisobot)" maxlength="60" style="flex:1;height:34px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#101b30;color:#fff;font-size:12px">' +
      '<button id="srVersionCreate" style="height:34px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(105deg,#6961fa,#3686ef);color:#fff;font-weight:700;font-size:12px;cursor:pointer">Saqlash</button></div>' +
      '<div id="srVersionList" style="display:grid;gap:6px">Yuklanmoqda...</div>';

    document.body.appendChild(button);
    document.body.appendChild(panel);

    function fmtSize(bytes) {
      var mb = bytes / (1024 * 1024);
      return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    async function refreshList() {
      var list = document.getElementById('srVersionList');
      list.textContent = 'Yuklanmoqda...';
      var result = await client().rpc(versionRpc().list);
      if (result.error) { list.textContent = 'Xatolik: ' + result.error.message; return; }
      var rows = result.data || [];
      if (!rows.length) { list.textContent = 'Hali versiyalar yo‘q. Ma’lumot saqlanganda avtomatik paydo bo‘ladi.'; return; }
      list.innerHTML = '';
      rows.forEach(function (row) {
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(255,255,255,.04)';
        var name = row.label ? row.label : 'avto-versiya';
        // The snapshot engine numbered versions; the store counts keys.
        var detail = row.version === undefined ? (row.keys + ' kalit') : ('v' + row.version);
        var info = document.createElement('div');
        info.innerHTML = '<div style="font-weight:700">' + name.replace(/[<>&]/g, '') + ' · ' + detail + '</div>' +
          '<div style="color:#8ea0bd;font-size:11px">' + new Date(row.created_at).toLocaleString() + ' · ' + fmtSize(row.size_bytes) + '</div>';
        var actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
        var restoreButton = document.createElement('button');
        restoreButton.textContent = 'Tiklash';
        restoreButton.style.cssText = 'padding:5px 10px;border:0;border-radius:7px;background:#2f855a;color:#fff;font-size:11px;font-weight:700;cursor:pointer';

        /* Re-enabled once restore_workspace_kv_version stopped deleting
           every row before re-inserting it. That intermediate empty state
           was broadcast to every connected till, which then wrote empty
           arrays over the restore — see
           supabase/2026-09-01-workspace-kv-restore-fix.sql. It now applies
           the difference in place, so terminals only ever see ordinary
           updates. The page still reloads afterwards: the ERP holds its own
           copies of these stores in module variables, and a restore can
           change all of them at once. */
        restoreButton.onclick = async function () {
          if (!window.confirm('Bazani "' + name + '" (' + detail + ') holatiga qaytarasizmi?\nHozirgi holat avtomatik backup sifatida saqlanadi.')) return;
          restoreButton.disabled = true;
          var restored = await client().rpc(versionRpc().restore, { history_id: row.id });
          if (restored.error) { window.alert('Tiklab bo‘lmadi: ' + restored.error.message); restoreButton.disabled = false; return; }
          if (!STORE_MODE) {
            try { await window.smartRetailAnalyticsServerSync.reload(); } catch (_) { /* reload below refreshes anyway */ }
          }
          window.location.reload();
        };
        actions.appendChild(restoreButton);
        if (row.label) {
          var deleteButton = document.createElement('button');
          deleteButton.textContent = 'O‘chirish';
          deleteButton.style.cssText = 'padding:5px 10px;border:0;border-radius:7px;background:#823a3a;color:#fff;font-size:11px;font-weight:700;cursor:pointer';
          deleteButton.onclick = async function () {
            if (!window.confirm('"' + name + '" backupini o‘chirasizmi?')) return;
            var removed = await client().rpc(versionRpc().remove, { history_id: row.id });
            if (removed.error) { window.alert('O‘chirib bo‘lmadi: ' + removed.error.message); return; }
            refreshList();
          };
          actions.appendChild(deleteButton);
        }
        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    button.onclick = function () {
      var visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      if (!visible) refreshList();
    };
    panel.querySelector('#srVersionClose').onclick = function () { panel.style.display = 'none'; };
    panel.querySelector('#srVersionCreate').onclick = async function () {
      var labelInput = document.getElementById('srVersionLabel');
      var created = await client().rpc(versionRpc().create, { version_label: labelInput.value });
      if (created.error) { window.alert('Saqlab bo‘lmadi: ' + created.error.message); return; }
      labelInput.value = '';
      refreshList();
    };
  }

  async function start() {
    if (!client() || !window.smartRetailAuthReady) return;
    try {
      var session = await window.smartRetailAuthReady;
      if (!session) return;
      workspaceUser = session.user.id; // must precede any pendingBaseline() read

      var profileResult = await client().from('profiles').select('active, username, workspace_owner').eq('id', session.user.id).single();
      var profile = profileResult.data;
      if (!profile && profileResult.error) {
        // A failed lookup is not the same as a blocked account — never
        // sign the user out over a transient read failure.
        announce('error', 'Bazaga ulanib bo‘lmadi');
        return;
      }
      if (!profile || !profile.active) {
        announce('error', 'Hisob faol emas');
        await client().auth.signOut();
        return;
      }
      var isOwner = !profile.workspace_owner;

      if (STORE_MODE) {
        await startStore(session, profile);
        return;
      }

      var data = await readServerState();
      var serverVersion = Number(data.version) || 0;
      var baseline = pendingBaseline();

      /* A previous session left work that never reached the database (the
         network dropped, the tab was closed, the machine slept). Restoring
         the server snapshot on top of it would destroy exactly that work,
         so decide which side is actually newer first. */
      if (baseline !== null && serverVersion === baseline) {
        // Nobody has written since this device went offline: what is on
        // this device IS the newest state. Keep it and push it up.
        revision = serverVersion;
        publishRevision();
        pending = true;
        active = true;
        announce('syncing', 'Saqlanmagan o‘zgarishlar yuborilmoqda...');
        notify();
      } else {
        if (baseline !== null && serverVersion > baseline) {
          // Another device wrote while this one was offline. The server
          // snapshot wins (as it always has), but never silently: keep the
          // divergent local state so it can still be recovered.
          try {
            localStorage.setItem('sr-conflict-backup', JSON.stringify({ at: new Date().toISOString(), snapshot: collect() }));
          } catch (_) { /* backup is best-effort */ }
        }
        clearPending();
        revision = serverVersion;
        publishRevision();
        if (revision && data.snapshot && Object.keys(data.snapshot).length) await restore(data.snapshot);
      }

      if (typeof saveState === 'function') {
        var original = saveState;
        saveState = async function serverAwareSaveState() {
          var output = await original.apply(this, arguments);
          notify();
          return output;
        };
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
        if (active && pending && !busy && !applying) flush();
      }, SAFETY_FLUSH_MS);

      /* A tab is closed, backgrounded or switched away from far more often
         than it is logged out of. Push whatever is unsent at that moment. */
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && pending) flush();
      });
      window.addEventListener('pagehide', function () { if (pending) flush(); });

      window.setInterval(pullRemote, REMOTE_POLL_MS);
      // The app's reset buttons (clearDataBtn/hardResetBtn) clear local data
      // without calling saveState, so the cleared state never reached the
      // database and reappeared on reload. Wrap their handlers so the sync
      // push runs exactly after the (async) reset completes; a cancelled
      // confirm just re-saves the unchanged state, which is harmless.
      ['clearDataBtn', 'hardResetBtn'].forEach(function (buttonId) {
        var resetButton = document.getElementById(buttonId);
        if (!resetButton) return;
        var originalHandler = resetButton.onclick || window.resetAll;
        resetButton.onclick = async function (event) {
          try {
            if (typeof originalHandler === 'function') await originalHandler.call(this, event);
          } finally {
            notify();
          }
        };
      });
      // Fallback for any other path that triggers a reset.
      document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('#clearDataBtn') || target.closest('#hardResetBtn')) {
          window.setTimeout(notify, 4000);
        }
      }, true);
      active = true;
      if (isOwner) {
        try { initVersionPanel(); } catch (error) { console.warn('Version panel unavailable:', error.message); }
      }
      // A recovery push is already announced and in flight — leave its
      // message up rather than reporting a clean connection over it.
      if (!pending) announce('online', revision ? 'Baza bilan ulangan · v' + revision : 'Baza bilan ulangan');
      if (!revision) notify();
    } catch (error) {
      console.warn('Supabase synchronization unavailable:', error.message);
      announce('error', 'Bazaga ulanib bo‘lmadi');
    }
  }

  if (document.readyState === 'complete') window.setTimeout(start, 250);
  else window.addEventListener('load', function () { window.setTimeout(start, 250); }, { once: true });
})();
