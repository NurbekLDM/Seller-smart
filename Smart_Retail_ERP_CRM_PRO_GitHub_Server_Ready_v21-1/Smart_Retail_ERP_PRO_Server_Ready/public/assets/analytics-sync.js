/* Parent application synchronization: analytics IndexedDB + ERP local storage. */
(function smartRetailParentSync() {
  'use strict';

  if (!/^https?:$/.test(window.location.protocol)) return;

  const ANALYTICS_KEY = 'srerp_analytics_parent_state';
  let revision = 0;
  let csrf = '';
  let active = false;
  let applying = false;
  let busy = false;
  let delayed = false;
  let timeout = null;
  const subscribers = new Set();

  function permitted(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !/password|secret|credential|session|token|pin|auth_users/i.test(key);
  }

  function announce(status, label) {
    for (const subscriber of subscribers) {
      try { subscriber(status, label); } catch (_) { /* Subscriber errors do not stop persistence. */ }
    }
    const frame = document.getElementById('smartRetailErpFrame');
    try {
      const indicator = frame?.contentDocument?.getElementById('crm21SyncState');
      if (indicator) {
        indicator.dataset.state = status;
        const text = indicator.querySelector('span:last-child');
        if (text) text.textContent = label;
      }
    } catch (_) { /* Cross-origin frames are not supported. */ }
  }

  function collect() {
    const result = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (permitted(key)) result[key] = localStorage.getItem(key);
    }
    if (typeof cloneState === 'function') result[ANALYTICS_KEY] = JSON.stringify(cloneState());
    return result;
  }

  async function restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    applying = true;
    try {
      const existing = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (permitted(key)) existing.push(key);
      }
      existing.filter(key => !Object.prototype.hasOwnProperty.call(snapshot, key)).forEach(key => localStorage.removeItem(key));
      for (const [key, value] of Object.entries(snapshot)) {
        if (key !== ANALYTICS_KEY && permitted(key) && typeof value === 'string') localStorage.setItem(key, value);
      }
      if (typeof snapshot[ANALYTICS_KEY] === 'string' && typeof deepMerge === 'function') {
        state = deepMerge(DEFAULT_STATE, JSON.parse(snapshot[ANALYTICS_KEY]));
        if (typeof saveState === 'function') await saveState();
        if (typeof rebuildAnalytics === 'function') rebuildAnalytics();
        if (typeof renderAll === 'function') renderAll();
      }
      const frame = document.getElementById('smartRetailErpFrame');
      if (frame?.dataset.loaded === '1') {
        try { frame.contentWindow?.renderAll?.(); frame.contentWindow?.crm21Refresh?.(); } catch (_) { /* Frame can be reloaded manually. */ }
      }
    } finally { applying = false; }
  }

  async function readJson(response) {
    let data = {};
    try { data = await response.json(); } catch (_) { /* Errors may contain no JSON. */ }
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.details = data.details;
      throw error;
    }
    return data;
  }

  async function flush() {
    if (!active || applying) return;
    if (busy) { delayed = true; return; }
    busy = true;
    announce('syncing', 'Serverga saqlanmoqda...');
    try {
      const result = await readJson(await fetch('/api/v1/state', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ expectedVersion: revision, snapshot: collect() })
      }));
      revision = result.version;
      announce('online', `Serverda saqlandi · v${revision}`);
    } catch (error) {
      if (error.status === 409) {
        active = false;
        announce('conflict', 'Boshqa qurilmada o‘zgarish bor');
        console.warn('Server state conflict:', error.details);
      } else if (error.status === 401) {
        active = false;
        announce('error', 'Server sessiyasi tugadi');
      } else {
        delayed = true;
        announce('error', 'Serverga ulanish vaqtincha uzildi');
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
    notify,
    flush,
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      subscribers.add(callback);
      callback(active ? 'online' : 'local', active ? `Server bilan ulangan · v${revision}` : 'Serverga ulanish tekshirilmoqda');
      return () => subscribers.delete(callback);
    },
    status: () => ({ active, revision, busy }),
    reload: async () => {
      const result = await readJson(await fetch('/api/v1/state', { credentials: 'same-origin' }));
      revision = Number(result.version) || 0;
      await restore(result.snapshot || {});
      active = true;
      announce('online', `Serverdan tiklandi · v${revision}`);
      return revision;
    }
  };

  async function start() {
    try {
      const session = await readJson(await fetch('/api/v1/auth/me', { credentials: 'same-origin' }));
      csrf = session.csrfToken;
      const result = await readJson(await fetch('/api/v1/state', { credentials: 'same-origin' }));
      revision = Number(result.version) || 0;
      if (revision && Object.keys(result.snapshot || {}).length) await restore(result.snapshot);
      if (typeof saveState === 'function') {
        const original = saveState;
        saveState = async function serverAwareSaveState() {
          const output = await original.apply(this, arguments);
          notify();
          return output;
        };
      }
      window.addEventListener('storage', event => { if (permitted(event.key)) notify(); });
      window.addEventListener('online', notify);
      active = true;
      announce('online', revision ? `Server bilan ulangan · v${revision}` : 'Server bilan ulangan');
      if (!revision) notify();
    } catch (error) {
      if (error.status !== 401 && error.status !== 404) console.warn('Server synchronization unavailable:', error.message);
    }
  }

  if (document.readyState === 'complete') window.setTimeout(start, 250);
  else window.addEventListener('load', () => window.setTimeout(start, 250), { once: true });
})();
