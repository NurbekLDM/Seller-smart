/* SellerSmart ERP 119.3 — server storage adapter ("provider", protocol 1).

   ERP 119.3 keeps its data in this browser: srerp_* keys (and a few others)
   in localStorage, plus four IndexedDB databases. It was built to accept a
   server adapter through SRTransfer113.registerProvider() before it boots,
   and it announces every write through SRTransfer113.subscribeInvalidation().
   This file is that adapter, backed by Supabase (supabase/2026-11-27-erp119-kv.sql):

     open    login check → (one-time seed from the live ERP) → download the
             workspace → SRTransfer113.hydrateBeforeBoot() → boot → the
             loader is allowed to start the ERP iframe (SRCloud119.ready);
     write   each announced key is queued, persisted as "dirty" in real
             localStorage, and sent with the revision it was based on
             (erp119_put); a conflict is merged and re-sent;
     others  Realtime on erp119_head tells this device that another one
             changed a key; the user gets a "refresh" prompt, and any key both
             sides changed is merged on the next write.

   Synced: every localStorage key the ERP itself allows in backups
   (SRTransfer113.keyAllowed) and the "analytics" and "uzum" IndexedDB
   databases (packed with the ERP's own codec under "idb:<id>"). Not synced:
   the chat database (it has its own server) and "imports" (original import
   files, kept on the device that imported them).

   The ERP data stays in native localStorage/IndexedDB, exactly where 119.3
   expects it; nothing replaces window.localStorage. */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------- merge -- */

  /* Three-way merge of two edits of one key. Values are the strings the ERP
     stored. Lists of records with an "id" are merged record by record:
     a record only one side changed takes that side's version, a record both
     sides changed takes this device's version, and additions and deletions
     from both sides are kept. Anything else: this device wins (the server
     keeps the overwritten value in erp119_kv_history). Without a base
     (offline edit from before a reload) deletions cannot be told from
     additions, so both sides' records are kept. */
  function parse(text) {
    if (typeof text !== 'string') return undefined;
    try { return JSON.parse(text); } catch (_) { return undefined; }
  }
  function recordList(value) {
    if (!Array.isArray(value)) return null;
    const map = new Map();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const id = item.id;
      if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return null;
      const k = typeof id + ':' + id;
      if (map.has(k)) return null;
      map.set(k, item);
    }
    return map;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function merge3(baseText, mineText, theirsText) {
    if (theirsText == null) return mineText;
    if (mineText == null) return theirsText;
    if (mineText === theirsText) return mineText;
    if (baseText != null && theirsText === baseText) return mineText;
    if (baseText != null && mineText === baseText) return theirsText;
    const mine = recordList(parse(mineText));
    const theirs = recordList(parse(theirsText));
    if (!mine || !theirs) return mineText;
    const base = baseText == null ? null : recordList(parse(baseText));
    const out = [];
    for (const [k, t] of theirs) {
      const m = mine.get(k);
      const b = base && base.get(k);
      if (m !== undefined) out.push(b !== undefined && same(m, b) ? t : m);
      else if (!base || b === undefined) out.push(t);          // new on the server
      else if (!same(t, b)) out.push(t);                        // deleted here, changed there: keep
    }
    for (const [k, m] of mine) {
      if (theirs.has(k)) continue;
      const b = base && base.get(k);
      if (!base || b === undefined) out.push(m);                // new here
      else if (!same(m, b)) out.push(m);                        // deleted there, changed here: keep
    }
    return JSON.stringify(out);
  }

  if (typeof module === 'object' && module.exports) module.exports = { merge3 };
  if (!root || !root.document) return;

  /* ------------------------------------------------------------ set-up -- */

  const doc = root.document;
  const config = root.SMART_RETAIL_CONFIG || {};
  const T = root.SRTransfer113;
  const Codec = root.SRTransferCodec113;
  const STATE_KEY = 'sr119-state';
  const DEVICE_KEY = 'sr119-device';
  const BOUND_KEY = 'SellerSmart.workspace113';
  const IDB_SYNC = { 'smart-retail-analytics91': 'analytics', 'uzum-analytics-pro': 'uzum' };
  const STORAGE_DEBOUNCE_MS = 800;
  const IDB_DEBOUNCE_MS = 2500;
  const RETRY_MAX_MS = 60000;
  const BATCH_BYTES = 4 * 1024 * 1024;

  const rawGet = Storage.prototype.getItem;
  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  const rawKey = Storage.prototype.key;
  const rawLength = Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get;
  const store = root.localStorage;
  const lsGet = (k) => { try { return rawGet.call(store, k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { rawSet.call(store, k, v); } catch (_) { /* quota */ } };
  const lsKeys = () => { const a = []; const n = rawLength.call(store); for (let i = 0; i < n; i++) a.push(rawKey.call(store, i)); return a; };

  let resolveReady, rejectReady;
  const ready = new Promise((ok, no) => { resolveReady = ok; rejectReady = no; });
  ready.catch(() => {});
  /* The ERP (patched by server/erp119.mjs) asks erpUserId() which employee
     to open as (null: the administrator), and calls employeeSaved() after
     the owner saves an employee. */
  root.SRCloud119 = {
    ready,
    get status() { return statusInfo(); },
    erpUserId: () => erpUserId,
    employeeSaved: (employee, password, creating) => { employeeSaved(employee, password, creating).catch((e) => toast(String(e.message || e), true)); }
  };

  function say(text) {
    const el = doc.getElementById('message');
    if (el) el.textContent = text;
  }

  function fail(text) {
    rejectReady(new Error(text));
  }

  if (!T || !Codec || !root.supabase || !config.supabaseUrl || !config.supabaseAnonKey) {
    fail('Server sozlamasi topilmadi (app-config / supabase.js). / Нет настроек сервера.');
    return;
  }

  const client = root.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storageKey: 'sr119-auth', persistSession: true, autoRefreshToken: true }
  });

  const DEVICE = (() => {
    let id = lsGet(DEVICE_KEY);
    if (!id) { id = (root.crypto?.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 36); lsSet(DEVICE_KEY, id); }
    return id;
  })();

  /* ------------------------------------------------------------- state -- */

  let ws = null;             // workspace id (owner's user id)
  let epoch = 0;             // goes up each time a backup is restored onto the server
  let wsOwner = false;       // this account owns the workspace (else: staff)
  let erpUserId = null;      // staff: the ERP employee this account opens as
  let userId = null;
  let email = '';
  // The id the ERP binds its local data to: a restore makes a new one, so
  // every device replaces its copy with the restored data.
  const wsId = () => (epoch ? ws + ':r' + epoch : ws);
  const known = new Map();   // server key -> { rev, value } as last agreed with the server
  const pending = new Set(); // server keys changed here and not yet accepted
  const remoteNewer = new Set();
  let owner = false;         // this tab holds the ERP's single-writer lock
  let mode = 'starting';     // starting | synced | pending | offline | error | auth
  let lastError = '';
  let paused = 0;
  let inflight = null;
  let timer = null;
  let retryMs = 2000;

  function loadState() {
    try { return JSON.parse(lsGet(STATE_KEY) || 'null') || {}; } catch (_) { return {}; }
  }
  function saveState() {
    const revs = {};
    for (const [k, v] of known) if (v.rev != null) revs[k] = v.rev;
    lsSet(STATE_KEY, JSON.stringify({ ws, epoch, owner: wsOwner, user: userId, revs, dirty: [...pending] }));
  }

  /* ----------------------------------------------------------- helpers -- */

  function setCookie(session) {
    const parts = ['sr-access-token=' + encodeURIComponent(session ? session.access_token : ''), 'Path=/', 'SameSite=Lax'];
    parts.push('Max-Age=' + (session ? Math.max(60, (session.expires_in || 3600)) : 0));
    if (root.location.protocol === 'https:') parts.push('Secure');
    doc.cookie = parts.join('; ');
  }

  function toLogin(reason) {
    setCookie(null);
    root.location.replace('/login.html' + (reason ? '?session=' + encodeURIComponent(reason) : ''));
  }

  function isNetworkError(error) {
    const text = String(error?.message || error || '');
    return !root.navigator.onLine || /fetch|network|timeout|Load failed|ECONN/i.test(text);
  }

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) throw Object.assign(new Error(error.message || name + ' failed'), { code: error.code, status: error.status });
    return data;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const spec = (id) => T.registry.find((x) => x.id === id);
  const serverKeyForIdb = (name) => IDB_SYNC[name] ? 'idb:' + IDB_SYNC[name] : null;

  // Reads one of the ERP's IndexedDB databases without creating it.
  function readDb(s) {
    return new Promise((resolve, reject) => {
      const result = { id: s.id, name: s.name, version: s.version, stores: Object.fromEntries(s.stores.map((n) => [n, []])) };
      let absent = false;
      const req = root.indexedDB.open(s.name);
      req.onupgradeneeded = () => { absent = true; req.transaction.abort(); };
      req.onerror = () => (absent ? resolve(result) : reject(req.error));
      req.onblocked = () => reject(new Error('Baza boshqa oynada band: ' + s.name));
      req.onsuccess = () => {
        const db = req.result;
        const present = s.stores.filter((n) => db.objectStoreNames.contains(n));
        if (!present.length) { db.close(); resolve(result); return; }
        const tx = db.transaction(present, 'readonly');
        for (const n of present) {
          const cur = tx.objectStore(n).openCursor();
          cur.onsuccess = () => { const c = cur.result; if (c) { result.stores[n].push({ key: c.key, value: c.value }); c.continue(); } };
        }
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB o‘qilmadi: ' + s.name)); };
      };
    });
  }

  /* A packed database carries its creation time, so two packs of the same
     data differ byte for byte. sig is what is compared instead: the
     manifest's per-file sha256 list, which depends on the content only. */
  async function packDb(id) {
    const d = await readDb(spec(id));
    const { blob, manifest } = await Codec.pack({ stores: d.stores });
    const empty = Object.values(d.stores).every((rows) => !rows.length);
    return {
      value: toBase64(new Uint8Array(await blob.arrayBuffer())),
      sig: empty ? null : JSON.stringify(manifest.entries.map((e) => [e.path, e.sha256]))
    };
  }

  async function unpackDb(id, text) {
    const s = spec(id);
    const { snapshot } = await Codec.unpack(new Blob([fromBase64(text)]));
    const stores = Object.fromEntries(s.stores.map((n) => [n, Array.isArray(snapshot?.stores?.[n]) ? snapshot.stores[n] : []]));
    return { id: s.id, name: s.name, version: s.version, stores };
  }

  const emptyDb = (id) => { const s = spec(id); return { id: s.id, name: s.name, version: s.version, stores: Object.fromEntries(s.stores.map((n) => [n, []])) }; };

  // The current local value of a server key as it would be sent, and the
  // signature it is compared by (the value itself for localStorage keys).
  async function localValue(key) {
    if (key.startsWith('idb:')) return packDb(key.slice(4));
    const value = lsGet(key);
    return { value, sig: value };
  }

  /* -------------------------------------------------------- server I/O -- */

  async function fetchAll() {
    const rows = [];
    for (let from = 0; ; from += 200) {
      const { data, error } = await client.from('erp119_kv').select('key,value,revision').order('key').range(from, from + 199);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      rows.push(...data);
      if (data.length < 200) break;
    }
    return rows;
  }

  // Builds the ERP's snapshot from server rows. chat and imports always come
  // from this device; analytics/uzum from the server, or from this device if
  // the server has none yet and this device already belongs to the workspace.
  async function buildSnapshot(rows, { localFallback }) {
    const storage = {};
    const dbs = {};
    for (const r of rows) {
      if (r.key.startsWith('idb:')) dbs[r.key.slice(4)] = r.value;
      else if (T.keyAllowed(r.key)) storage[r.key] = r.value;
    }
    const databases = [];
    for (const s of T.registry) {
      if (s.id === 'chat' || s.id === 'imports') databases.push(await readDb(s));
      else if (dbs[s.id] != null) databases.push(await unpackDb(s.id, dbs[s.id]));
      else databases.push(localFallback ? await readDb(s) : emptyDb(s.id));
    }
    return { schema: 1, storage, databases, legacyPending: [] };
  }

  /* -------------------------------------------------------------- push -- */

  function schedule(delay) {
    root.clearTimeout(timer);
    timer = root.setTimeout(() => { timer = null; flush(); }, delay);
  }

  function updateMode() {
    if (mode === 'auth' || mode === 'error' || mode === 'offline') { render(); return; }
    mode = pending.size ? 'pending' : 'synced';
    render();
  }

  function flush() {
    if (inflight) return inflight;
    if (mode === 'restored') { render(); return Promise.resolve(); }
    if (!owner || paused || !ws || !pending.size) { updateMode(); return Promise.resolve(); }
    inflight = (async () => {
      try {
        await pushPending();
        retryMs = 2000;
        if (!pending.size) lastError = '';
        if (mode !== 'auth') mode = pending.size ? 'pending' : 'synced';
      } catch (error) {
        if (/workspace was restored/.test(error.message || '')) {
          // A backup was restored onto the server after this page loaded:
          // its edits belong to the old data. Stop; the chip asks to reload.
          mode = 'restored';
          lastError = 'Server baza zaxiradan tiklangan. Sahifani yangilang.';
          inflight = null;
          render();
          return;
        }
        if (error.code === 'PGRST301' || error.status === 401 || /JWT|jwt/.test(error.message)) {
          const { data } = await client.auth.refreshSession().catch(() => ({ data: {} }));
          if (!data?.session) mode = 'auth';
        } else {
          mode = isNetworkError(error) ? 'offline' : 'error';
        }
        lastError = String(error.message || error);
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      } finally {
        inflight = null;
        render();
      }
      if (pending.size && !timer && !paused) schedule(STORAGE_DEBOUNCE_MS);
    })();
    return inflight;
  }

  async function pushPending() {
    for (let round = 0; round < 4 && pending.size; round++) {
      const entries = [];
      let bytes = 0;
      const sigs = new Map();
      for (const key of [...pending]) {
        const { value, sig } = await localValue(key);
        const k = known.get(key);
        if (k && k.sig !== undefined && k.sig === sig) { pending.delete(key); continue; }
        if (!k && sig == null) { pending.delete(key); continue; }
        sigs.set(key, sig);
        entries.push({ key, value, base: k ? k.rev : null });
        bytes += (value ? value.length : 0) + key.length;
        if (bytes > BATCH_BYTES || entries.length >= 200) break;
      }
      saveState();
      if (!entries.length) return;
      const sent = new Map(entries.map((e) => [e.key, e]));
      const results = await rpc('erp119_put', { p_entries: entries, p_device: DEVICE, p_epoch: epoch });
      for (const r of results || []) {
        const e = sent.get(r.key);
        if (!e) continue;
        if (r.status === 'ok') {
          known.set(r.key, { rev: r.revision, value: e.value, sig: sigs.get(r.key) });
          // Changed again while the request was out? Keep it queued.
          if ((await localValue(r.key)).sig === sigs.get(r.key)) pending.delete(r.key);
          remoteNewer.delete(r.key);
        } else if (r.status === 'conflict') {
          await resolveConflict(r, e);
        } else if (r.status === 'forbidden') {
          pending.delete(r.key);
          known.set(r.key, { rev: known.get(r.key)?.rev ?? null, value: e.value, sig: sigs.get(r.key) });
          lastError = 'Bu hisobga ' + r.key + ' ni o‘zgartirish ruxsat etilmagan.';
        }
      }
      saveState();
    }
  }

  async function resolveConflict(r, sentEntry) {
    const key = r.key;
    const base = known.get(key);
    const theirs = r.value == null ? null : r.value;
    let merged;
    if (key.startsWith('idb:')) merged = sentEntry.value;   // whole-database blobs: this device wins
    else merged = merge3(base && base.value !== undefined ? base.value : null, sentEntry.value, theirs);
    // Next attempt is based on what the server has now. For an IndexedDB
    // blob there is no comparable signature of "theirs": leave it unknown
    // so the local database is re-sent.
    known.set(key, { rev: r.revision, value: theirs, sig: key.startsWith('idb:') ? undefined : theirs });
    if (!key.startsWith('idb:') && merged !== sentEntry.value && merged != null) {
      T.assertWritable();
      root.localStorage.setItem(key, merged);   // through the ERP's gate; the ERP re-reads on render
      remoteNewer.add(key);
    }
    if (merged === theirs) pending.delete(key);
    else pending.add(key);
  }

  function onInvalidated(event) {
    if (!owner) return;
    let delay = STORAGE_DEBOUNCE_MS;
    for (const k of event?.keys || []) {
      let key = null;
      if (k.startsWith('idb:')) { key = serverKeyForIdb(k.slice(4)); delay = Math.max(delay, IDB_DEBOUNCE_MS); }
      else if (T.keyAllowed(k)) key = k;
      if (key) pending.add(key);
    }
    if (pending.size) { saveState(); updateMode(); schedule(delay); }
  }

  /* ---------------------------------------------------------- realtime -- */

  function subscribeRealtime() {
    client.channel('erp119-' + ws)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'erp119_head', filter: 'workspace_id=eq.' + ws }, (payload) => {
        const row = payload.new && payload.new.key ? payload.new : null;
        if (!row || row.device === DEVICE) return;
        const k = known.get(row.key);
        if (k && k.rev != null && Number(k.rev) >= Number(row.revision)) return;
        remoteNewer.add(row.key);
        render();
      })
      .subscribe();
  }

  /* ---------------------------------------------------------------- UI -- */

  let chip, menu;
  function render() {
    if (!doc.body || !ws) return;
    if (!chip) {
      chip = doc.createElement('button');
      chip.type = 'button';
      chip.id = 'sr119Status';
      chip.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483600;border:0;border-radius:999px;padding:6px 12px;font:600 12px system-ui;color:#fff;box-shadow:0 2px 10px #0006;cursor:pointer;opacity:.92';
      chip.onclick = toggleMenu;
      doc.body.append(chip);
    }
    const n = pending.size;
    const view = {
      starting: ['#475569', 'Ulanmoqda…'],
      synced: ['#15803d', '● Serverda saqlangan'],
      pending: ['#b45309', '● Yuborilmoqda: ' + n],
      offline: ['#475569', '● Internet yo‘q — navbatda: ' + n],
      error: ['#b91c1c', '● Saqlash xatosi — navbatda: ' + n],
      auth: ['#b91c1c', '● Qayta kiring — navbatda: ' + n],
      restored: ['#1d4ed8', '↻ Baza zaxiradan tiklandi — yangilash']
    }[mode] || ['#475569', mode];
    const newer = remoteNewer.size && mode !== 'restored';
    chip.style.background = newer ? '#1d4ed8' : view[0];
    chip.textContent = newer ? '↻ Boshqa qurilmada o‘zgarish bor — yangilash' : view[1];
    chip.title = lastError || '';
  }

  // Short notice above the status chip (employee accounts, chat import).
  function toast(text, bad) {
    if (!doc.body) return;
    const n = doc.createElement('div');
    n.setAttribute('role', bad ? 'alert' : 'status');
    n.style.cssText = 'position:fixed;left:10px;bottom:48px;z-index:2147483601;max-width:min(420px,calc(100vw - 20px));padding:10px 14px;border-radius:10px;font:13px/1.4 system-ui;color:#fff;box-shadow:0 6px 24px #0007;background:' + (bad ? '#b91c1c' : '#15803d');
    n.textContent = text;
    doc.body.append(n);
    root.setTimeout(() => n.remove(), bad ? 9000 : 5000);
  }

  function toggleMenu() {
    if (mode === 'restored') { root.location.reload(); return; }
    if (remoteNewer.size && !pending.size) { root.location.reload(); return; }
    if (menu) { menu.remove(); menu = null; return; }
    menu = doc.createElement('div');
    menu.style.cssText = 'position:fixed;left:10px;bottom:46px;z-index:2147483600;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:12px;font:13px system-ui;min-width:240px;box-shadow:0 8px 30px #0008';
    const line = (t) => { const p = doc.createElement('div'); p.textContent = t; p.style.margin = '4px 0'; return p; };
    const button = (t, fn) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = t; b.style.cssText = 'display:block;width:100%;margin-top:8px;padding:8px;border:0;border-radius:8px;background:#334155;color:#fff;font:inherit;cursor:pointer'; b.onclick = fn; return b; };
    menu.append(line(email || ''), line('Navbatda: ' + pending.size + (owner ? '' : ' (faqat ko‘rish oynasi)')));
    if (lastError) menu.append(line(lastError));
    menu.append(button('Hozir yuborish', () => { retryMs = 2000; if (mode !== 'auth') mode = 'pending'; flush(); }));
    menu.append(button('Yangilash (serverdan qayta yuklash)', () => root.location.reload()));
    menu.append(button('Chiqish', signOut));
    doc.body.append(menu);
  }

  async function signOut() {
    if (pending.size) {
      await flush();
      if (pending.size && !root.confirm(pending.size + ' ta o‘zgarish hali serverga yetmadi. Ular shu qurilmada qoladi va keyingi kirishda yuboriladi. Chiqilsinmi?')) return;
    }
    await client.auth.signOut().catch(() => {});
    toLogin();
  }

  function statusInfo() {
    let rev = 0;
    for (const v of known.values()) if (v.rev != null && Number(v.rev) > rev) rev = Number(v.rev);
    const label = { synced: 'Serverda saqlangan', pending: 'Yuborilmoqda', offline: 'Internet yo‘q', error: 'Saqlash xatosi', auth: 'Qayta kirish kerak', starting: 'Ulanmoqda' }[mode] || mode;
    return { workspaceId: wsId(), state: mode, label, pending: pending.size, revision: rev };
  }

  /* --------------------------------------------------------- employees -- */

  const norm = (v) => String(v ?? '').trim().normalize('NFKC').toLowerCase();
  const USERS_KEY = 'srerp_auth_users_v6';

  function loginOf(mail) {
    const e = String(mail || '').toLowerCase();
    const suffix = '@' + String(config.staffEmailDomain || 'staff.sellersmart.uz').toLowerCase();
    return e.endsWith(suffix) ? e.slice(0, -suffix.length) : e;
  }

  /* A staff account opens the ERP as the active employee with the same
     login; the owner opens as the administrator (erpUserId stays null).
     Returns an error text when there is no such employee. */
  function resolveIdentity(usersText) {
    erpUserId = null;
    if (wsOwner) return '';
    let list = [];
    try { list = JSON.parse(usersText || '[]') || []; } catch (_) { list = []; }
    const login = loginOf(email);
    const me = Array.isArray(list) && list.find((u) => u && u.active !== false && !u.archived && norm(u.username) === login);
    if (!me) {
      return 'ERP xodimlari ro‘yxatida "' + login + '" loginli faol xodim yo‘q. Egasi ERP → Xodimlar oynasida shu login bilan xodim qo‘shsin (yoki blokdan chiqarsin).\n' +
        'В списке сотрудников ERP нет активного сотрудника с логином "' + login + '".';
    }
    erpUserId = me.id;
    return '';
  }

  async function bearer() {
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw Object.assign(new Error('Sessiya tugagan, qayta kiring.'), { status: 401 });
    return token;
  }

  async function api(path, init = {}) {
    const res = await fetch(path, {
      ...init,
      headers: { authorization: 'Bearer ' + (await bearer()), ...(init.body && !(init.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) }
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'HTTP ' + res.status), { status: res.status });
    return data;
  }

  /* The owner saved an employee in the ERP: their SellerSmart login (used
     on any other device) follows. A new employee with a password gets an
     account; a blocked or archived one is blocked; a new password is set. */
  async function employeeSaved(employee, password, creating) {
    if (!wsOwner || !employee || employee.id === 'AUTH-ROOT-ADMIN') return;
    const login = norm(employee.username);
    const active = employee.active !== false && !employee.archived;
    if (!/^[a-z0-9_]{3,30}$/.test(login)) {
      if (creating || password) toast('ERP saqlandi, lekin "' + login + '" logini bilan SellerSmart hisobi ochilmadi: login 3–30 belgi, faqat kichik lotin harf, raqam va _ bo‘lsin.', true);
      return;
    }
    const { staff } = await api('/api/staff');
    const found = (staff || []).find((s) => s.login === login);
    if (!found) {
      if (!active) return;
      if (!password) {
        toast('"' + login + '" boshqa qurilmadan kirishi uchun xodimga parol kiriting (kamida 8 belgi) va saqlang.', true);
        return;
      }
      await api('/api/staff', { method: 'POST', body: JSON.stringify({ action: 'create', login, password, name: employee.fullName || login, modules: ['erp119'] }) });
      toast('Xodim hisobi yaratildi. Kirish: erp sahifasida login "' + login + '" va shu parol.');
      return;
    }
    const patch = { action: 'update', id: found.id, active, name: employee.fullName || login };
    if (password) patch.password = password;
    await api('/api/staff', { method: 'POST', body: JSON.stringify(patch) });
    toast(active ? (password ? 'Xodim paroli serverda ham yangilandi.' : 'Xodim hisobi yangilandi.') : 'Xodim hisobi bloklandi: u endi kira olmaydi.');
  }

  /* -------------------------------------------------------------- chat -- */

  /* The ERP's chat runs in "online" mode through this bridge to the chat
     server (server/chat119.mjs): same requests as its own server protocol,
     authenticated with the SellerSmart session instead of a cookie. */
  const chatBridge = {
    async request(path, options = {}) {
      const init = { method: options.method || 'GET' };
      if (options.body instanceof FormData) {
        const file = options.body.get('file');
        init.body = file;
        init.headers = { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'file') };
      } else if (options.body) {
        init.body = options.body;
      }
      return api('/api/chat119' + path, init);
    },
    subscribe(fn) {
      let timer = 0;
      const channel = client.channel('erp119-chat-' + ws)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'erp119_chat_head', filter: 'workspace_id=eq.' + ws }, () => {
          root.clearTimeout(timer);
          timer = root.setTimeout(fn, 150);
        })
        .subscribe();
      return () => { client.removeChannel(channel); };
    },
    async downloadFile(id) {
      const res = await fetch('/api/chat119/files/' + encodeURIComponent(id), { headers: { authorization: 'Bearer ' + (await bearer()) } });
      if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch (_) { /* */ } throw Object.assign(new Error(m || 'Fayl ochilmadi.'), { status: res.status }); }
      return res.blob();
    }
  };

  // The chat this browser kept before the server existed moves to the
  // (empty) server chat once, with its files.
  async function importLocalChat() {
    const flag = 'sr119-chat-imported:' + ws;
    if (!wsOwner || lsGet(flag)) return;
    const local = await readDb(spec('chat'));
    const state = (local.stores.state || []).find((r) => r.key === 'main')?.value;
    if (!state || !Array.isArray(state.rooms) || !state.rooms.length) { lsSet(flag, 'empty'); return; }
    const { imported } = await api('/api/chat119/import', { method: 'POST', body: JSON.stringify({ state }) });
    if (imported) {
      let files = 0;
      for (const row of local.stores.files || []) {
        const f = row.value;
        if (!f || !f.id || !(f.blob instanceof Blob)) continue;
        try { await api('/api/chat119/import-file?id=' + encodeURIComponent(f.id), { method: 'POST', body: f.blob, headers: { 'content-type': 'application/octet-stream' } }); files++; } catch (_) { /* a file the chat no longer references */ }
      }
      toast('Bu qurilmadagi chat serverga ko‘chirildi (' + state.rooms.length + ' suhbat, ' + files + ' fayl).');
    }
    lsSet(flag, imported ? 'imported' : 'server-had-chat');
  }

  /* ----------------------------------------------------------- restore -- */

  async function restoreEntries(snapshot) {
    const entries = [];
    for (const [key, value] of Object.entries(snapshot?.storage || {})) {
      if (typeof value === 'string' && T.keyAllowed(key)) entries.push({ key, value });
    }
    for (const d of snapshot?.databases || []) {
      const id = IDB_SYNC[d.name] || (Object.values(IDB_SYNC).includes(d.id) ? d.id : null);
      if (!id || !d.stores || Object.values(d.stores).every((rows) => !rows || !rows.length)) continue;
      const { blob } = await Codec.pack({ stores: d.stores });
      entries.push({ key: 'idb:' + id, value: toBase64(new Uint8Array(await blob.arrayBuffer())) });
    }
    return entries;
  }

  /* ---------------------------------------------------------- provider -- */

  function makeProvider() {
    return {
      protocol: 1,
      workspaceId: wsId(),
      chat: chatBridge,
      async pause() {
        paused++;
        if (inflight) await inflight;
        let released = false;
        return async () => { if (released) return; released = true; paused--; if (!paused && pending.size) schedule(0); };
      },
      async beforeHydrate() { if (inflight) await inflight; },
      async status() { return statusInfo(); },
      async exportWorkspace() {
        await flush();
        const rows = await fetchAll();
        const snapshot = await buildSnapshot(rows, { localFallback: false });
        for (const d of snapshot.databases) if (d.id === 'chat' || d.id === 'imports') Object.assign(d, emptyDb(d.id));
        const rev = rows.reduce((m, r) => Math.max(m, Number(r.revision) || 0), 0);
        return { complete: true, scope: 'workspace', workspaceId: wsId(), snapshot, snapshotId: 'erp119-' + rev, revision: rev };
      },
      /* Restore a ZIP backup onto the server (owner only, checked by the
         server): upload to a staging area, verify the count, then swap in
         one transaction (supabase/2026-11-28-erp119-team.sql). The data it
         replaces is archived on the server. */
      async stageRestore({ snapshot, operationId }) {
        if (!wsOwner) throw new Error('Zaxirani serverga faqat ish maydoni egasi tiklaydi.');
        await flush();
        const entries = await restoreEntries(snapshot);
        if (!entries.length) throw new Error('Zaxirada tiklanadigan ERP ma’lumoti yo‘q.');
        const stageId = root.crypto.randomUUID();
        await rpc('erp119_restore_begin', { p_stage: stageId, p_operation: operationId, p_expected: entries.length });
        try {
          for (let i = 0; i < entries.length;) {
            const batch = [];
            let bytes = 0;
            while (i < entries.length && batch.length < 200 && (bytes < BATCH_BYTES || !batch.length)) {
              bytes += entries[i].value.length + entries[i].key.length;
              batch.push(entries[i++]);
            }
            await rpc('erp119_restore_rows', { p_stage: stageId, p_entries: batch });
          }
          const check = await rpc('erp119_restore_verify', { p_stage: stageId });
          if (!check || check.verified !== true) throw new Error('Server zaxirani to‘liq qabul qilmadi (' + (check?.received ?? 0) + '/' + entries.length + ').');
        } catch (error) {
          await rpc('erp119_restore_abort', { p_stage: stageId }).catch(() => {});
          throw error;
        }
        return { operationId, verified: true, stageId };
      },
      async commitRestore({ operationId, stageId }) {
        const r = await rpc('erp119_restore_commit', { p_stage: stageId });
        // This page's data is now the old workspace: send nothing more.
        pending.clear();
        mode = 'restored';
        lastError = 'Server baza zaxiradan tiklandi. Sahifani yangilang.';
        lsSet(STATE_KEY, JSON.stringify({ ws, epoch: Number(r.epoch), user: userId, revs: {}, dirty: [] }));
        render();
        return { workspaceId: ws + ':r' + r.epoch, operationId, complete: true };
      },
      async restoreStatus(operationId) {
        const r = await rpc('erp119_restore_status', { p_operation: operationId });
        if (r?.state === 'committed') return { operationId, state: 'committed', complete: true, workspaceId: ws + ':r' + r.epoch };
        if (r?.state === 'staging' || r?.state === 'staged') return { operationId, state: r.state, complete: false };
        return { operationId, state: 'aborted', cleanupComplete: true, complete: false };
      }
    };
  }

  /* ------------------------------------------------------------- start -- */

  async function writerOwner() {
    if (!root.SRWriter101) return true;
    await root.SRWriter101.ready;
    return !!root.SRWriter101.owner;
  }

  function localHasErpData() {
    return lsKeys().some((k) => T.keyAllowed(k));
  }

  async function openOffline(state, why) {
    if (!state.ws || state.user !== userId) {
      fail('Serverga ulanib bo‘lmadi va bu qurilmada shu hisobning bazasi yo‘q. Internetni tekshirib, qayta oching.\n' + why);
      return;
    }
    ws = state.ws;
    epoch = Number(state.epoch) || 0;
    wsOwner = state.owner !== false;
    const who = resolveIdentity(lsGet(USERS_KEY));
    if (who) { fail(who); return; }
    for (const [k, rev] of Object.entries(state.revs || {})) known.set(k, { rev, value: undefined });
    for (const k of state.dirty || []) pending.add(k);
    owner = await writerOwner();
    T.registerProvider(makeProvider());
    await T.boot();
    mode = 'offline';
    lastError = why;
    T.subscribeInvalidation(onInvalidated);
    root.addEventListener('online', () => { mode = 'pending'; flush(); });
    resolveReady();
    render();
    schedule(5000);
  }

  async function start() {
    say('Hisob tekshirilmoqda… / Проверка аккаунта…');
    const { data: { session } } = await client.auth.getSession();
    if (!session) return toLogin('required');
    setCookie(session);
    userId = session.user.id;
    email = session.user.email || '';
    client.auth.onAuthStateChange((event, s) => {
      if (s) setCookie(s);
      if (event === 'SIGNED_OUT') { mode = 'auth'; render(); }
    });

    const state = loadState();
    let status;
    try {
      status = await rpc('erp119_status');
    } catch (error) {
      if (isNetworkError(error)) return openOffline(state, String(error.message || error));
      if (error.status === 401 || /JWT/i.test(error.message)) return toLogin('rejected');
      throw error;
    }
    if (!status || !status.workspace_id) return toLogin('rejected');
    if (!status.active) {
      fail('Hisobingiz faol emas yoki ERP ruxsati tugagan. Administratorga murojaat qiling.\nАккаунт не активен или доступ к ERP истёк.');
      return;
    }
    ws = status.workspace_id;
    epoch = Number(status.epoch) || 0;
    wsOwner = !!status.owner;

    // Unsent edits made before a backup was restored onto the server belong
    // to the old data: they are dropped (the server keeps the old data in
    // its archive), never written into the restored workspace.
    if (state.ws === ws && (Number(state.epoch) || 0) !== epoch && (state.dirty || []).length) {
      if (!root.confirm('Server baza zaxiradan tiklangan. Bu qurilmadagi ' + state.dirty.length + ' ta yuborilmagan o‘zgarish eski bazaga tegishli va bekor qilinadi.\n\nБаза на сервере восстановлена из резервной копии. Неотправленные изменения этого устройства будут отменены.')) {
        fail('Bekor qilindi. Avval ZIP zaxira oling, keyin qayta oching.');
        return;
      }
      state.dirty = [];
      state.revs = {};
      lsSet(STATE_KEY, JSON.stringify({ ...state, epoch }));
    }

    if (state.ws && state.ws !== ws && (state.dirty || []).length) {
      fail('Bu qurilmada boshqa hisobning serverga yetmagan ' + state.dirty.length + ' ta o‘zgarishi bor. Avval o‘sha hisob bilan kirib, ularni yuboring.\nНа устройстве есть неотправленные изменения другого аккаунта.');
      return;
    }

    owner = await writerOwner();
    T.registerProvider(makeProvider());

    if (!owner) {
      // Another tab is the ERP's writer; this one only reads.
      const who = resolveIdentity(lsGet(USERS_KEY));
      if (who) { fail(who); return; }
      await T.boot();
      mode = 'synced';
      subscribeRealtime();
      resolveReady();
      render();
      return;
    }

    // Unsent work from the last visit goes first, so the download below
    // cannot overwrite it.
    if (state.ws === ws && (state.dirty || []).length) {
      say('Oldingi o‘zgarishlar yuborilmoqda… / Отправка прошлых изменений…');
      for (const [k, rev] of Object.entries(state.revs || {})) known.set(k, { rev, value: undefined });
      for (const k of state.dirty) pending.add(k);
      try { await pushPending(); } catch (error) {
        if (isNetworkError(error)) return openOffline(state, String(error.message || error));
        throw error;
      }
      if (pending.size) {
        fail('Oldingi o‘zgarishlarni serverga yuborib bo‘lmadi: ' + (lastError || 'noma’lum xato') + '\nСтраница не будет перезаписана, пока изменения не отправлены.');
        return;
      }
    }

    if (!status.seeded && !Number(status.keys)) {
      say('Joriy ma’lumotlar ERP 119.3 ga nusxalanmoqda… / Копирование данных…');
      await rpc('erp119_seed');
    }

    say('Ma’lumotlar serverdan yuklanmoqda… / Загрузка данных с сервера…');
    const rows = await fetchAll();
    const who = resolveIdentity(rows.find((r) => r.key === USERS_KEY)?.value);
    if (who) { fail(who); return; }
    const bound = lsGet(BOUND_KEY);
    const snapshot = await buildSnapshot(rows, { localFallback: bound === wsId() });

    let replaceLocal = false;
    if (localHasErpData() && bound !== wsId()) {
      if (bound) replaceLocal = true;   // another account's copy; its data is on the server
      else if (root.confirm('Bu qurilmada serverga ulanmagan lokal ERP bazasi bor. U serverdagi baza bilan almashtiriladi.\n\nLokal bazani saqlab qolish kerak bo‘lsa, "Bekor qilish"ni bosing va avval ZIP zaxira oling.\n\nНа устройстве есть локальная база. Заменить её базой с сервера?')) replaceLocal = true;
      else { fail('Lokal baza saqlab qolindi. Avval ZIP zaxira oling, keyin qayta oching.'); return; }
    }

    say('ERP tayyorlanmoqda… / Подготовка ERP…');
    await T.hydrateBeforeBoot(snapshot, wsId(), { replaceLocal });
    known.clear();
    pending.clear();
    for (const r of rows) known.set(r.key, { rev: r.revision, value: r.value, sig: r.key.startsWith('idb:') ? undefined : r.value });
    // The synced IndexedDB databases now hold the server's content (or this
    // device's, if the server had none): take their signatures as agreed,
    // and queue a database the server does not have yet.
    for (const id of Object.values(IDB_SYNC)) {
      const key = 'idb:' + id;
      const { sig } = await localValue(key);
      const k = known.get(key);
      if (k) known.set(key, { rev: k.rev, value: undefined, sig });
      else if (sig != null) pending.add(key);
    }
    saveState();

    await T.boot();
    T.subscribeInvalidation(onInvalidated);
    subscribeRealtime();
    root.addEventListener('online', () => { if (mode === 'offline') mode = 'pending'; flush(); });
    mode = pending.size ? 'pending' : 'synced';
    resolveReady();
    render();
    if (pending.size) schedule(IDB_DEBOUNCE_MS);
    importLocalChat().catch((e) => toast('Lokal chatni serverga ko‘chirib bo‘lmadi: ' + (e.message || e), true));
  }

  start().catch((error) => fail(String(error?.message || error)));
})(typeof window !== 'undefined' ? window : null);
