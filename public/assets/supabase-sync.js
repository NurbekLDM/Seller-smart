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
  var revision = 0;
  var active = false;

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

  function client() { return window.smartRetailSupabase || null; }

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
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
    window.clearTimeout(timeout);
    timeout = window.setTimeout(flush, 900);
  }

  window.smartRetailAnalyticsServerSync = {
    notify: notify,
    flush: flush,
    subscribe: function (callback) {
      if (typeof callback !== 'function') return function () {};
      subscribers.add(callback);
      callback(active ? 'online' : 'local', active ? 'Baza bilan ulangan · v' + revision : 'Bazaga ulanish tekshirilmoqda');
      return function () { subscribers.delete(callback); };
    },
    status: function () { return { active: active, revision: revision, busy: busy }; },
    reload: async function () {
      var data = await readServerState();
      revision = Number(data.version) || 0;
      await restore(data.snapshot || {});
      active = true;
      announce('online', 'Bazadan tiklandi · v' + revision);
      return revision;
    }
  };

  /* Admin-only version panel: list automatic hourly snapshots and named
     backups, create a named backup, restore any of them. */
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
      var result = await client().rpc('list_app_state_versions');
      if (result.error) { list.textContent = 'Xatolik: ' + result.error.message; return; }
      var rows = result.data || [];
      if (!rows.length) { list.textContent = 'Hali versiyalar yo‘q. Ma’lumot saqlanganda avtomatik paydo bo‘ladi.'; return; }
      list.innerHTML = '';
      rows.forEach(function (row) {
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(255,255,255,.04)';
        var name = row.label ? row.label : 'avto-versiya';
        var info = document.createElement('div');
        info.innerHTML = '<div style="font-weight:700">' + name.replace(/[<>&]/g, '') + ' · v' + row.version + '</div>' +
          '<div style="color:#8ea0bd;font-size:11px">' + new Date(row.created_at).toLocaleString() + ' · ' + fmtSize(row.size_bytes) + '</div>';
        var actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
        var restoreButton = document.createElement('button');
        restoreButton.textContent = 'Tiklash';
        restoreButton.style.cssText = 'padding:5px 10px;border:0;border-radius:7px;background:#2f855a;color:#fff;font-size:11px;font-weight:700;cursor:pointer';
        restoreButton.onclick = async function () {
          if (!window.confirm('Bazani "' + name + '" (v' + row.version + ') holatiga qaytarasizmi?\nHozirgi holat avtomatik backup sifatida saqlanadi.')) return;
          restoreButton.disabled = true;
          var restored = await client().rpc('restore_app_state_version', { history_id: row.id });
          if (restored.error) { window.alert('Tiklab bo‘lmadi: ' + restored.error.message); restoreButton.disabled = false; return; }
          try { await window.smartRetailAnalyticsServerSync.reload(); } catch (_) { /* reload below refreshes anyway */ }
          window.location.reload();
        };
        actions.appendChild(restoreButton);
        if (row.label) {
          var deleteButton = document.createElement('button');
          deleteButton.textContent = 'O‘chirish';
          deleteButton.style.cssText = 'padding:5px 10px;border:0;border-radius:7px;background:#823a3a;color:#fff;font-size:11px;font-weight:700;cursor:pointer';
          deleteButton.onclick = async function () {
            if (!window.confirm('"' + name + '" backupini o‘chirasizmi?')) return;
            var removed = await client().rpc('delete_app_state_version', { history_id: row.id });
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
      var created = await client().rpc('create_app_state_version', { version_label: labelInput.value });
      if (created.error) { window.alert('Saqlab bo‘lmadi: ' + created.error.message); return; }
      labelInput.value = '';
      refreshList();
    };
  }

  /* Owner-only staff panel: manage ERP employees (username logins that see
     only POS + Inventarizatsiya and work in this owner's workspace). */
  function initStaffPanel(session) {
    if (document.getElementById('srStaffPanelBtn')) return;

    var button = document.createElement('button');
    button.id = 'srStaffPanelBtn';
    button.textContent = '👥 Xodimlar';
    button.style.cssText = 'position:fixed;left:132px;bottom:14px;z-index:99998;padding:8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(13,22,40,.92);color:#dbe6f7;font:600 12px -apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)';

    var panel = document.createElement('div');
    panel.id = 'srStaffPanel';
    panel.style.cssText = 'position:fixed;left:14px;bottom:56px;z-index:99999;display:none;width:min(460px,92vw);max-height:64vh;overflow:auto;padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(10,17,32,.97);color:#dbe6f7;font:13px -apple-system,"Segoe UI",sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.5)';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<strong>ERP xodimlari</strong>' +
      '<button id="srStaffClose" style="border:0;background:none;color:#8ea0bd;font-size:16px;cursor:pointer">✕</button></div>' +
      '<div style="color:#8ea0bd;font-size:11px;margin-bottom:10px">Xodim faqat ERP’ga kiradi (POS Kassa va Inventarizatsiya) va sizning do‘koningiz ma’lumotlarida ishlaydi. Kirish: login + parol.</div>' +
      '<div style="display:grid;gap:6px;margin-bottom:10px">' +
      '<div style="display:flex;gap:6px">' +
      '<input id="srStaffLogin" placeholder="login (masalan: kassir1)" maxlength="30" style="flex:1;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#101b30;color:#fff;font-size:12px">' +
      '<input id="srStaffName" placeholder="Ism (ixtiyoriy)" maxlength="60" style="flex:1;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#101b30;color:#fff;font-size:12px"></div>' +
      '<div style="display:flex;gap:6px">' +
      '<input id="srStaffExpiry" type="date" title="Amal qilish muddati (ixtiyoriy)" style="flex:1;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#101b30;color:#fff;font-size:12px">' +
      '<button id="srStaffCreate" style="height:32px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(105deg,#6961fa,#3686ef);color:#fff;font-weight:700;font-size:12px;cursor:pointer">Xodim qo‘shish</button></div></div>' +
      '<div id="srStaffNotice" style="display:none;margin-bottom:8px;padding:9px;border-radius:8px;background:rgba(48,209,88,.12);border:1px solid rgba(48,209,88,.4);font-size:12px;word-break:break-all"></div>' +
      '<div id="srStaffList" style="display:grid;gap:6px">Yuklanmoqda...</div>';

    document.body.appendChild(button);
    document.body.appendChild(panel);

    function generatePassword() {
      var alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
      var bytes = new Uint8Array(10);
      window.crypto.getRandomValues(bytes);
      var out = '';
      for (var i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
      return out;
    }

    async function api(method, body) {
      var sessionResult = await client().auth.getSession();
      var current = sessionResult.data && sessionResult.data.session;
      if (!current) throw new Error('Sessiya tugagan');
      var response = await fetch('/api/staff', {
        method: method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.access_token },
        body: body ? JSON.stringify(body) : undefined
      });
      var payload = {};
      try { payload = await response.json(); } catch (_) { /* empty */ }
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
      return payload;
    }

    function showNotice(html) {
      var notice = document.getElementById('srStaffNotice');
      notice.innerHTML = html;
      notice.style.display = 'block';
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
      });
    }

    async function refresh() {
      var list = document.getElementById('srStaffList');
      list.textContent = 'Yuklanmoqda...';
      try {
        var data = await api('GET');
        var staff = data.staff || [];
        if (!staff.length) { list.textContent = 'Hali xodimlar yo‘q.'; return; }
        list.innerHTML = '';
        staff.forEach(function (member) {
          var expired = member.expires_at && new Date(member.expires_at).getTime() <= Date.now();
          var item = document.createElement('div');
          item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(255,255,255,.04)';
          var info = document.createElement('div');
          info.innerHTML = '<div style="font-weight:700">' + esc(member.login) + (member.name && member.name !== member.login ? ' · ' + esc(member.name) : '') + '</div>' +
            '<div style="color:#8ea0bd;font-size:11px">' +
            (member.active ? (expired ? 'Muddati tugagan' : 'Faol') : 'Bloklangan') +
            (member.expires_at ? ' · muddat: ' + new Date(member.expires_at).toLocaleDateString() : '') +
            (member.last_sign_in_at ? ' · kirgan: ' + new Date(member.last_sign_in_at).toLocaleDateString() : '') + '</div>';
          var actions = document.createElement('div');
          actions.style.cssText = 'display:flex;gap:5px;flex-shrink:0';

          var passwordButton = document.createElement('button');
          passwordButton.textContent = 'Parol';
          passwordButton.style.cssText = 'padding:5px 9px;border:0;border-radius:7px;background:rgba(255,255,255,.1);color:#c8d5ea;font-size:11px;font-weight:700;cursor:pointer';
          passwordButton.onclick = async function () {
            var next = generatePassword();
            if (!window.confirm(member.login + ' uchun yangi parol: ' + next + '\nOK bosilgach nusxalab oling.')) return;
            try { await api('POST', { action: 'update', id: member.id, password: next }); showNotice(esc(member.login) + ' yangi paroli: <b style="user-select:all">' + esc(next) + '</b>'); }
            catch (error) { window.alert('Xatolik: ' + error.message); }
          };
          actions.appendChild(passwordButton);

          var toggleButton = document.createElement('button');
          toggleButton.textContent = member.active ? 'Bloklash' : 'Ochish';
          toggleButton.style.cssText = 'padding:5px 9px;border:0;border-radius:7px;background:' + (member.active ? '#823a3a' : '#2f855a') + ';color:#fff;font-size:11px;font-weight:700;cursor:pointer';
          toggleButton.onclick = async function () {
            try { await api('POST', { action: 'update', id: member.id, active: !member.active }); refresh(); }
            catch (error) { window.alert('Xatolik: ' + error.message); }
          };
          actions.appendChild(toggleButton);

          var deleteButton = document.createElement('button');
          deleteButton.textContent = 'O‘chirish';
          deleteButton.style.cssText = 'padding:5px 9px;border:0;border-radius:7px;background:#823a3a;color:#fff;font-size:11px;font-weight:700;cursor:pointer';
          deleteButton.onclick = async function () {
            if (!window.confirm(member.login + ' xodimi o‘chirilsinmi? U boshqa kira olmaydi.')) return;
            try { await api('POST', { action: 'delete', id: member.id }); refresh(); }
            catch (error) { window.alert('Xatolik: ' + error.message); }
          };
          actions.appendChild(deleteButton);

          item.appendChild(info);
          item.appendChild(actions);
          list.appendChild(item);
        });
      } catch (error) {
        list.textContent = 'Xatolik: ' + error.message;
      }
    }

    button.onclick = function () {
      var visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      if (!visible) refresh();
    };
    panel.querySelector('#srStaffClose').onclick = function () { panel.style.display = 'none'; };
    panel.querySelector('#srStaffCreate').onclick = async function () {
      var login = document.getElementById('srStaffLogin').value.trim().toLowerCase();
      var name = document.getElementById('srStaffName').value.trim();
      var expiry = document.getElementById('srStaffExpiry').value;
      if (!login) { window.alert('Xodim loginini kiriting.'); return; }
      var password = generatePassword();
      var createButton = this;
      createButton.disabled = true;
      try {
        await api('POST', {
          action: 'create', login: login, name: name, password: password,
          expires_at: expiry ? new Date(expiry + 'T23:59:59').toISOString() : null
        });
        showNotice('Xodim yaratildi. Kirish — login: <b style="user-select:all">' + esc(login) + '</b> · parol: <b style="user-select:all">' + esc(password) + '</b><br>Hozir nusxalab xodimga yuboring.');
        document.getElementById('srStaffLogin').value = '';
        document.getElementById('srStaffName').value = '';
        document.getElementById('srStaffExpiry').value = '';
        refresh();
      } catch (error) {
        window.alert('Xatolik: ' + error.message);
      } finally { createButton.disabled = false; }
    };
  }

  async function start() {
    if (!client() || !window.smartRetailAuthReady) return;
    try {
      var session = await window.smartRetailAuthReady;
      if (!session) return;

      var profileResult = await client().from('profiles').select('active, username, workspace_owner').eq('id', session.user.id).single();
      var profile = profileResult.data;
      if (!profile || !profile.active) {
        announce('error', 'Hisob faol emas');
        await client().auth.signOut();
        return;
      }
      var isOwner = !profile.workspace_owner;

      var data = await readServerState();
      revision = Number(data.version) || 0;
      publishRevision();
      if (revision && data.snapshot && Object.keys(data.snapshot).length) await restore(data.snapshot);

      if (typeof saveState === 'function') {
        var original = saveState;
        saveState = async function serverAwareSaveState() {
          var output = await original.apply(this, arguments);
          notify();
          return output;
        };
      }
      window.addEventListener('storage', function (event) {
        if (event.key === WS_REVISION_KEY) { adoptSharedRevision(); return; }
        if (permitted(event.key)) notify();
      });
      window.addEventListener('online', notify);
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
        try { initStaffPanel(session); } catch (error) { console.warn('Staff panel unavailable:', error.message); }
      }
      announce('online', revision ? 'Baza bilan ulangan · v' + revision : 'Baza bilan ulangan');
      if (!revision) notify();
    } catch (error) {
      console.warn('Supabase synchronization unavailable:', error.message);
      announce('error', 'Bazaga ulanib bo‘lmadi');
    }
  }

  if (document.readyState === 'complete') window.setTimeout(start, 250);
  else window.addEventListener('load', function () { window.setTimeout(start, 250); }, { once: true });
})();
