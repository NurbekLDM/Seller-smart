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
