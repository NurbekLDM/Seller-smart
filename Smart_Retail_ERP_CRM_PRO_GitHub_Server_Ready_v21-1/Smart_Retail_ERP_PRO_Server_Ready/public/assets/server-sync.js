/* Optional authenticated server synchronization. Standalone HTML remains offline-first. */
(function smartRetailServerSync() {
  'use strict';

  const MAX_KEYS = 250;
  const EXCLUDED = new Set([
    'srerp_auth_users_v6',
    'srerp_auth_session_v6',
    'srerp_v14_security_pin',
    'srerp_pin_settings_v14'
  ]);
  let revision = 0;
  let csrf = '';
  let enabled = false;
  let applying = false;
  let timer = null;
  let running = false;
  let pending = false;

  function apiOrigin() {
    try {
      if (/^https?:$/.test(window.location.protocol)) return window.location.origin;
      if (window.parent !== window && /^https?:$/.test(window.parent.location.protocol)) return window.parent.location.origin;
      if (window.opener && /^https?:$/.test(window.opener.location.protocol)) return window.opener.location.origin;
    } catch (_) { /* Cross-origin embedding stays offline. */ }
    return '';
  }

  function showState(state, message) {
    const badge = document.getElementById('crm21SyncState');
    if (!badge) return;
    badge.dataset.state = state;
    const label = badge.querySelector('span:last-child');
    if (label) label.textContent = message;
    badge.title = state === 'conflict'
      ? 'Boshqa qurilmada o‘zgarish aniqlandi. Sahifani yangilashdan oldin lokal backup oling.'
      : message;
  }

  function included(key) {
    return typeof key === 'string'
      && key.startsWith('srerp_')
      && !EXCLUDED.has(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !/password|secret|credential|session|token|pin/i.test(key);
  }

  function snapshot() {
    const result = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (included(key)) result[key] = localStorage.getItem(key);
      if (Object.keys(result).length > MAX_KEYS) throw new Error('Sinxronlash uchun kalitlar soni cheklovdan oshdi.');
    }
    return result;
  }

  function applySnapshot(values) {
    if (!values || typeof values !== 'object') return;
    applying = true;
    try {
      const existing = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (included(key)) existing.push(key);
      }
      existing.filter(key => !Object.prototype.hasOwnProperty.call(values, key)).forEach(key => localStorage.removeItem(key));
      for (const [key, value] of Object.entries(values)) {
        if (included(key) && typeof value === 'string') localStorage.setItem(key, value);
      }
    } finally { applying = false; }
    try {
      if (typeof renderAll === 'function') renderAll();
      if (typeof crm21Refresh === 'function') crm21Refresh();
    } catch (error) { console.warn('Serverdagi holatni chizishda xatolik:', error); }
  }

  async function readResponse(response) {
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* Server errors can be empty. */ }
    if (!response.ok) {
      const error = new Error(payload.error || `Server xatosi: HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function sync() {
    if (!enabled || applying) return;
    if (running) { pending = true; return; }
    running = true;
    showState('syncing', 'Serverga saqlanmoqda...');
    try {
      const response = await fetch(`${apiOrigin()}/api/v1/state`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ expectedVersion: revision, snapshot: snapshot() })
      });
      const data = await readResponse(response);
      revision = data.version;
      showState('online', `Serverda saqlandi · v${revision}`);
    } catch (error) {
      if (error.status === 409) {
        enabled = false;
        showState('conflict', 'Sinxronlash mojarosi — backup oling');
        console.warn('State version conflict:', error.payload);
      } else if (error.status === 401) {
        enabled = false;
        showState('error', 'Server sessiyasi tugadi');
      } else {
        showState('error', 'Server vaqtincha mavjud emas');
        pending = true;
      }
    } finally {
      running = false;
      if (pending && enabled) {
        pending = false;
        timer = window.setTimeout(sync, 2500);
      }
    }
  }

  function schedule() {
    if (!enabled || applying) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(sync, 850);
  }

  function watchStorage() {
    const original = db_set;
    db_set = function syncedDatabaseSet(key, value) {
      const result = original.apply(this, arguments);
      if (included(key)) schedule();
      return result;
    };
    window.addEventListener('online', schedule);
    window.addEventListener('pagehide', () => {
      if (!enabled || !timer) return;
      window.clearTimeout(timer);
      fetch(`${apiOrigin()}/api/v1/state`, {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ expectedVersion: revision, snapshot: snapshot() })
      }).catch(() => {});
    });
  }

  async function start() {
    const origin = apiOrigin();
    if (!origin) return;
    try {
      if (window.parent !== window && window.parent.smartRetailAnalyticsServerSync) {
        const coordinator = window.parent.smartRetailAnalyticsServerSync;
        coordinator.subscribe(showState);
        const original = db_set;
        db_set = function parentCoordinatedDatabaseSet(key, value) {
          const result = original.apply(this, arguments);
          if (included(key)) coordinator.notify();
          return result;
        };
        enabled = true;
        return;
      }
    } catch (_) { /* Direct ERP deployments use their own authenticated client. */ }
    try {
      const session = await readResponse(await fetch(`${origin}/api/v1/auth/me`, { credentials: 'same-origin' }));
      csrf = session.csrfToken;
      const data = await readResponse(await fetch(`${origin}/api/v1/state`, { credentials: 'same-origin' }));
      revision = Number(data.version) || 0;
      if (data.snapshot && Object.keys(data.snapshot).length) applySnapshot(data.snapshot);
      enabled = true;
      watchStorage();
      showState('online', revision ? `Server bilan ulangan · v${revision}` : 'Server bilan ulangan');
      if (!revision && Object.keys(snapshot()).length) schedule();
    } catch (error) {
      if (error.status !== 401 && error.status !== 404) {
        showState('error', 'Lokal rejim · server topilmadi');
        console.info('ERP server sync unavailable:', error.message);
      }
    }
  }

  window.smartRetailServerSync = {
    sync,
    status: () => ({ enabled, revision, running, pending }),
    reload: async () => {
      const data = await readResponse(await fetch(`${apiOrigin()}/api/v1/state`, { credentials: 'same-origin' }));
      revision = Number(data.version) || 0;
      applySnapshot(data.snapshot || {});
      enabled = true;
      showState('online', `Serverdan tiklandi · v${revision}`);
      return revision;
    }
  };
  document.addEventListener('DOMContentLoaded', () => window.setTimeout(start, 200));
})();
