/* Parent application synchronization via Supabase: analytics IndexedDB state
   + ERP localStorage are stored as one versioned snapshot in the shared
   app_state table. Exposes window.smartRetailAnalyticsServerSync with the
   same interface as the previous server build, so the embedded ERP module
   coordinates through it unchanged. */
(function smartRetailSupabaseSync() {
  'use strict';

  if (!/^https?:$/.test(window.location.protocol)) return;

  var ANALYTICS_KEY = 'srerp_analytics_parent_state';
  var WRITER_ROLES = ['ADMIN', 'POS', 'WMS'];
  var revision = 0;
  var role = '';
  var active = false;
  var applying = false;
  var busy = false;
  var delayed = false;
  var timeout = null;
  var subscribers = new Set();

  function client() { return window.smartRetailSupabase || null; }
  function canWrite() { return WRITER_ROLES.indexOf(role) !== -1; }

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !/password|secret|credential|session|token|pin|auth_users/i.test(key);
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
    var result = await client().from('app_state').select('version, snapshot').eq('id', 'main').maybeSingle();
    if (result.error) {
      var error = new Error(result.error.message || 'Supabase read failed');
      error.code = result.error.code;
      throw error;
    }
    return result.data || { version: 0, snapshot: {} };
  }

  async function flush() {
    if (!active || applying || !canWrite()) return;
    if (busy) { delayed = true; return; }
    busy = true;
    announce('syncing', 'Bazaga saqlanmoqda...');
    try {
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
      announce('online', 'Bazada saqlandi · v' + revision);
    } catch (error) {
      var message = String(error.message || '');
      if (message.indexOf('version_conflict') !== -1) {
        active = false;
        announce('conflict', 'Boshqa qurilmada o‘zgarish bor');
        console.warn('Shared state conflict at version', revision);
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
    if (!active || applying || !canWrite()) return;
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
    status: function () { return { active: active, revision: revision, busy: busy, role: role }; },
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
          '<div style="color:#8ea0bd;font-size:11px">' + new Date(row.created_at).toLocaleString() + ' · ' + (row.created_by || '') + ' · ' + fmtSize(row.size_bytes) + '</div>';
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

  async function start() {
    if (!client() || !window.smartRetailAuthReady) return;
    try {
      var session = await window.smartRetailAuthReady;
      if (!session) return;

      var profileResult = await client().from('profiles').select('role, active, username').eq('id', session.user.id).single();
      var profile = profileResult.data;
      if (!profile || !profile.active) {
        announce('error', 'Hisob faol emas');
        await client().auth.signOut();
        return;
      }
      role = profile.role;

      var data = await readServerState();
      revision = Number(data.version) || 0;
      if (revision && data.snapshot && Object.keys(data.snapshot).length) await restore(data.snapshot);

      if (typeof saveState === 'function') {
        var original = saveState;
        saveState = async function serverAwareSaveState() {
          var output = await original.apply(this, arguments);
          notify();
          return output;
        };
      }
      window.addEventListener('storage', function (event) { if (permitted(event.key)) notify(); });
      window.addEventListener('online', notify);
      active = true;
      if (role === 'ADMIN') {
        try { initVersionPanel(); } catch (error) { console.warn('Version panel unavailable:', error.message); }
      }
      if (!canWrite()) {
        announce('online', 'Faqat o‘qish rejimi · v' + revision);
      } else {
        announce('online', revision ? 'Baza bilan ulangan · v' + revision : 'Baza bilan ulangan');
        if (!revision) notify();
      }
    } catch (error) {
      console.warn('Supabase synchronization unavailable:', error.message);
      announce('error', 'Bazaga ulanib bo‘lmadi');
    }
  }

  if (document.readyState === 'complete') window.setTimeout(start, 250);
  else window.addEventListener('load', function () { window.setTimeout(start, 250); }, { once: true });
})();
