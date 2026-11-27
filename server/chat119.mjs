/* ERP 119.3 online chat ("Online chat va vazifalar") on the server.

   ERP 119.3 ships its chat in two modes: "local" (one browser, IndexedDB)
   and "online" against a chat server it talks to through a bridge the
   storage adapter may provide (SRTransfer113.chat(); erp119/sync.js gives
   it one that calls this module). This is that server.

   The chat rules are not re-written here: the ERP's own chat core
   (SRChat84Core — rooms, messages, tasks, review, timers, idempotency by
   request id) is taken from the vendor file and run unchanged, against one
   authoritative state per workspace kept in Postgres
   (erp119_chat_state, supabase/2026-11-28-erp119-team.sql). Writes use an
   optimistic revision check, so two people writing at once cannot lose a
   message. Attachments are stored per workspace (erp119_chat_files) and
   handed out only to members of their room. erp119_chat_head is bumped on
   every change; devices subscribe to it (Realtime) and refresh.

   Who is who: the caller's SellerSmart session (Authorization: Bearer) is
   checked with Supabase Auth; the workspace owner is the ERP administrator,
   a staff account is the ERP employee with the same login. Their chat
   permissions come from the employee list the owner keeps in the ERP
   (erp119_kv "srerp_auth_users_v6"), read on the server — never from the
   browser.

   Routes (prefix /api/chat119, the paths the ERP chat client uses):
     GET  /health /me /boot /messages /audit   POST /command /upload /logout
     GET  /files/<id>                          POST /import /import-file  */

import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';

const PREFIX = '/api/chat119';
const USERS_KEY = 'srerp_auth_users_v6';
const CHAT_PERMS = ['chat.send', 'chat.manage', 'tasks.create', 'tasks.review'];
const FILE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'xlsx', 'csv', 'txt'];
const MAX_FILE = 10 * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;

const PAYLOAD_TAG = '<script type="application/octet-stream" id="portable-payload">';
const ASSETS_TAG = 'window.SRCHAT84_ASSETS=';

/* --------------------------------------------------------- vendor core -- */

export function chatCoreSource(vendorHtml) {
  const at = vendorHtml.lastIndexOf(PAYLOAD_TAG);
  if (at < 0) throw new Error('chat119: ERP payload not found');
  const start = at + PAYLOAD_TAG.length;
  const end = vendorHtml.indexOf('</script>', start);
  const inner = gunzipSync(Buffer.from(vendorHtml.slice(start, end).trim(), 'base64')).toString('utf8');
  const a = inner.indexOf(ASSETS_TAG);
  if (a < 0) throw new Error('chat119: chat core not found in the ERP');
  const b = inner.indexOf('</script>', a);
  const assets = JSON.parse(inner.slice(a + ASSETS_TAG.length, b).trim().replace(/;\s*$/, ''));
  if (typeof assets.core !== 'string') throw new Error('chat119: chat core missing');
  return assets.core;
}

export function loadChatCore(source) {
  const sandbox = { crypto: webcrypto, module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'SRChat84Core.js', timeout: 2000 });
  const C = sandbox.module.exports;
  for (const fn of ['command', 'visible', 'hasRoom', 'can', 'empty', 'uid']) {
    if (typeof C[fn] !== 'function') throw new Error('chat119: chat core has no ' + fn);
  }
  return C;
}

/* --------------------------------------------------------- directory -- */

const norm = (v) => String(v ?? '').trim().normalize('NFKC').toLowerCase();

// The same projection the ERP's chat makes of its employees (localUsers).
export function chatUsers(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.id).map((x) => ({
    id: x.id,
    username: x.username,
    name: x.fullName || x.username,
    role: x.role === 'ADMIN' ? 'admin' : (x.access70?.actions || []).includes('tasks.create') ? 'manager' : 'employee',
    active: x.active !== false && !x.archived,
    permissions: ((x.role === 'ADMIN' || x.access70?.views?.includes('chat84')) ? (x.access70?.actions || []) : [])
      .filter((k) => CHAT_PERMS.includes(k)),
    scope: x.access70?.scope || { warehouses: [], stores: [] }
  }));
}

/* Which ERP employee a SellerSmart account is. The owner is the ERP's
   administrator; a staff account is the active employee whose ERP login
   equals the account's login. */
export function erpEmployeeFor(list, { owner, login }) {
  const rows = Array.isArray(list) ? list : [];
  const alive = (u) => u && u.active !== false && !u.archived;
  if (owner) {
    const admin = (u) => alive(u) && u.role === 'ADMIN';
    return rows.find((u) => u.id === 'AUTH-ROOT-ADMIN' && admin(u)) || rows.find(admin) || null;
  }
  const want = norm(login);
  return want ? rows.find((u) => alive(u) && norm(u.username) === want) || null : null;
}

export function loginOf(email, staffDomain) {
  const e = String(email || '').toLowerCase();
  const suffix = '@' + String(staffDomain || '').toLowerCase();
  return e.endsWith(suffix) ? e.slice(0, -suffix.length) : e;
}

/* ------------------------------------------------------------- server -- */

export function createChat119({ env, vendorHtmlPath }) {
  const SUPABASE_URL = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const ANON = String(env.SUPABASE_ANON_KEY || '');
  const SERVICE = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const STAFF_DOMAIN = String(env.STAFF_EMAIL_DOMAIN || 'staff.sellersmart.uz');
  if (!SUPABASE_URL || !ANON || !SERVICE) return null;

  const svc = { apikey: SERVICE, authorization: `Bearer ${SERVICE}` };
  let corePromise = null;
  const core = () => corePromise || (corePromise = readFile(vendorHtmlPath, 'utf8')
    .then((html) => loadChatCore(chatCoreSource(html)))
    .catch((e) => { corePromise = null; throw e; }));

  const fail = (status, message) => Object.assign(new Error(message), { status });

  async function rest(path, init = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { ...svc, 'content-type': 'application/json', ...(init.headers || {}) }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) throw fail(502, 'Baza javobi: ' + (data?.message || res.status));
    return data;
  }

  /* -------------------------------------------------------- identity -- */

  const sessions = new Map(); // token -> { at, who }

  async function identify(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw fail(401, 'Sessiyaga qayta kiring.');
    const cached = sessions.get(token);
    if (cached && Date.now() - cached.at < 30000) return cached.who;

    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
    if (!r.ok) throw fail(401, 'Sessiyaga qayta kiring.');
    const user = await r.json();
    const [profile] = await rest(`profiles?select=id,workspace_owner,active,expires_at&id=eq.${encodeURIComponent(user.id)}`);
    if (!profile) throw fail(403, 'Hisob topilmadi.');
    const allowed = await rest('rpc/service_allowed', { method: 'POST', body: JSON.stringify({ p_user: user.id, p_service: 'erp' }) });
    if (allowed !== true) throw fail(403, 'ERP ruxsati yo‘q yoki muddati tugagan.');
    const ws = profile.workspace_owner || profile.id;
    const who = { ws, owner: !profile.workspace_owner, login: loginOf(user.email, STAFF_DOMAIN), email: user.email || '' };
    sessions.set(token, { at: Date.now(), who });
    if (sessions.size > 500) for (const k of sessions.keys()) { sessions.delete(k); if (sessions.size < 400) break; }
    return who;
  }

  async function directory(who) {
    const rows = await rest(`erp119_kv?select=value&workspace_id=eq.${who.ws}&key=eq.${USERS_KEY}`);
    let list = [];
    try { list = JSON.parse(rows[0]?.value || '[]'); } catch (_) { list = []; }
    const me = erpEmployeeFor(list, who);
    if (!me) throw fail(403, who.owner ? 'ERP da faol administrator yo‘q.' : `ERP xodimlari ro‘yxatida "${who.login}" loginli faol xodim yo‘q.`);
    const users = chatUsers(list);
    return { users, user: users.find((u) => u.id === me.id) };
  }

  /* ----------------------------------------------------------- state -- */

  async function loadState(ws) {
    const rows = await rest(`erp119_chat_state?select=state,revision&workspace_id=eq.${ws}`);
    if (!rows.length) return { state: null, revision: null };
    return { state: rows[0].state, revision: Number(rows[0].revision) };
  }

  async function saveState(ws, state, revision) {
    let rows;
    if (revision == null) {
      rows = await rest('erp119_chat_state?on_conflict=workspace_id', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ workspace_id: ws, state, revision: 1 })
      });
    } else {
      rows = await rest(`erp119_chat_state?workspace_id=eq.${ws}&revision=eq.${revision}`, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ state, revision: revision + 1, updated_at: new Date().toISOString() })
      });
    }
    if (!Array.isArray(rows) || !rows.length) return false;
    await rest('erp119_chat_head?on_conflict=workspace_id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ workspace_id: ws, revision: Number(rows[0].revision), updated_at: new Date().toISOString() })
    });
    return true;
  }

  // Read-modify-write with retry on a concurrent change.
  async function mutate(ws, fn) {
    const C = await core();
    for (let attempt = 0; attempt < 6; attempt++) {
      const { state, revision } = await loadState(ws);
      const s = state || C.empty();
      const result = await fn(s, revision == null);
      if (await saveState(ws, s, revision)) return result;
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
    }
    throw fail(409, 'Chat band, qayta urinib ko‘ring.');
  }

  /* ----------------------------------------------------- attachments -- */

  async function fileMeta(ws, ids) {
    const list = [...new Set(ids.filter((x) => typeof x === 'string' && /^[\w.:-]{1,120}$/.test(x)))];
    if (!list.length) return new Map();
    const rows = await rest(`erp119_chat_files?select=id,room_id,name,mime,size&workspace_id=eq.${ws}&id=in.(${list.map((x) => '"' + x + '"').join(',')})`);
    return new Map(rows.map((r) => [r.id, r]));
  }

  // Attachments are what this server stored for that room, nothing else.
  async function cleanAttachments(ws, state, cmd) {
    const p = cmd.payload || {};
    if (!Array.isArray(p.attachments)) return;
    let roomId = p.roomId;
    if (cmd.type === 'task.update') roomId = state.tasks.find((t) => t.id === p.taskId)?.roomId;
    const meta = await fileMeta(ws, p.attachments.map((a) => a && a.id));
    p.attachments = p.attachments.slice(0, 3)
      .map((a) => meta.get(a && a.id))
      .filter((f) => f && (!roomId || f.room_id === roomId))
      .map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size }));
  }

  /* ---------------------------------------------------------- routes -- */

  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(fail(413, 'Fayl juda katta.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    const raw = await readRaw(req, MAX_JSON);
    try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (_) { throw fail(400, 'JSON noto‘g‘ri.'); }
  }

  function send(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    });
    res.end(data);
  }

  function boot(C, state, user, users) {
    const v = C.visible(state, user);
    const rooms = v.rooms.map((room) => {
      const ms = state.messages.filter((m) => m.roomId === room.id);
      return {
        ...room,
        lastSeq: ms.at(-1)?.seq || 0,
        unread: ms.filter((m) => m.senderId !== user.id && m.seq > (state.reads[user.id + ':' + room.id] || 0)).length,
        preview: ms.at(-1)?.text?.slice(0, 100) || ''
      };
    });
    return { user, users, ...v, rooms };
  }

  async function route(req, res, url, path) {
    const method = req.method;
    if (path === '/health' && method === 'GET') return send(res, 200, { service: 'smart-retail-chat', setupRequired: false });

    const who = await identify(req);
    const C = await core();

    if (path.startsWith('/files/') && method === 'GET') {
      const id = decodeURIComponent(path.slice(7));
      const rows = await rest(`erp119_chat_files?select=room_id,name,mime,size,data&workspace_id=eq.${who.ws}&id=eq.${encodeURIComponent(id)}`);
      const f = rows[0];
      if (!f) throw fail(404, 'Fayl topilmadi.');
      const { user } = await directory(who);
      const { state } = await loadState(who.ws);
      const room = (state || C.empty()).rooms.find((r) => r.id === f.room_id);
      if (!C.hasRoom(user, room)) throw fail(403, 'Faylga ruxsat yo‘q.');
      const bytes = Buffer.from(f.data, 'base64');
      res.writeHead(200, {
        'content-type': /^[\w.+-]+\/[\w.+-]+$/.test(f.mime) ? f.mime : 'application/octet-stream',
        'content-length': bytes.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff'
      });
      return res.end(bytes);
    }

    const { users, user } = await directory(who);

    if (path === '/me' && method === 'GET') return send(res, 200, { user, csrf: '' });
    if (path === '/logout' && method === 'POST') return send(res, 200, { ok: true });
    if (path === '/password' && method === 'POST') throw fail(400, 'Parol SellerSmart hisobida o‘zgartiriladi (administrator yoki egasi orqali).');

    if (path === '/boot' && method === 'GET') {
      const { state } = await loadState(who.ws);
      return send(res, 200, boot(C, state || C.empty(), user, users));
    }

    if (path === '/messages' && method === 'GET') {
      const { state: raw } = await loadState(who.ws);
      const state = raw || C.empty();
      const rid = url.searchParams.get('roomId') || '';
      const before = Number(url.searchParams.get('before') || 0);
      const q = String(url.searchParams.get('q') || '').toLowerCase();
      const room = state.rooms.find((r) => r.id === rid);
      if (!C.hasRoom(user, room)) throw fail(403, 'Suhbatga ruxsat yo‘q.');
      const rows = state.messages.filter((m) => m.roomId === rid && (!before || m.seq < before) && (!q || String(m.text || '').toLowerCase().includes(q)));
      return send(res, 200, {
        messages: rows.slice(-50),
        hasMore: rows.length > 50,
        pinned: state.messages.filter((m) => (room.pinned || []).includes(m.id))
      });
    }

    if (path === '/command' && method === 'POST') {
      const cmd = await readJson(req);
      if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw fail(400, 'Buyruq noto‘g‘ri.');
      cmd.requestId = String(cmd.requestId || '').slice(0, 100);
      cmd.payload = cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {};
      const result = await mutate(who.ws, async (state) => {
        await cleanAttachments(who.ws, state, cmd);
        return JSON.parse(JSON.stringify(C.command(state, user, users, cmd)));
      });
      return send(res, 200, result ?? { ok: true });
    }

    if (path === '/upload' && method === 'POST') {
      const rid = url.searchParams.get('roomId') || '';
      const { state } = await loadState(who.ws);
      if (!C.hasRoom(user, (state || C.empty()).rooms.find((r) => r.id === rid))) throw fail(403, 'Suhbatga ruxsat yo‘q.');
      let name = 'file';
      try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch (_) { /* keep */ }
      name = name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
      const ext = name.split('.').at(-1).toLowerCase();
      if (!FILE_TYPES.includes(ext)) throw fail(400, 'Fayl turi: PNG/JPG/WEBP/PDF/XLSX/CSV/TXT.');
      const bytes = await readRaw(req, MAX_FILE);
      if (!bytes.length) throw fail(400, 'Fayl bo‘sh.');
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
      const f = { id: C.uid(), name, mime, size: bytes.length };
      await rest('erp119_chat_files', {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ workspace_id: who.ws, id: f.id, room_id: rid, name, mime, size: f.size, data: bytes.toString('base64'), created_by: user.id })
      });
      return send(res, 200, f);
    }

    if (path === '/audit' && method === 'GET') {
      if (user.role !== 'admin') throw fail(403, 'Faqat administrator.');
      const { state } = await loadState(who.ws);
      const s = state || C.empty();
      return send(res, 200, { exportedAt: new Date().toISOString(), rooms: s.rooms, tasks: s.tasks, messages: s.messages.length, users });
    }

    /* One-time move of the chat this browser kept locally (before the
       server existed) into the empty server chat. Owner only. */
    if (path === '/import' && method === 'POST') {
      if (!who.owner || user.role !== 'admin') throw fail(403, 'Faqat egasi.');
      const body = await readJson(req);
      const src = body && body.state;
      if (!src || !Array.isArray(src.rooms) || !Array.isArray(src.messages) || !Array.isArray(src.tasks)) throw fail(400, 'Chat nusxasi noto‘g‘ri.');
      const imported = await mutate(who.ws, async (state, fresh) => {
        if (!fresh && (state.rooms.length || state.messages.length || state.tasks.length)) return false;
        Object.assign(state, C.empty(), {
          rooms: src.rooms, messages: src.messages, tasks: src.tasks,
          reads: src.reads && typeof src.reads === 'object' ? src.reads : {},
          requests: src.requests && typeof src.requests === 'object' ? src.requests : {},
          sequence: Math.max(Number(src.sequence) || 0, ...src.messages.map((m) => Number(m.seq) || 0)),
          ...(src.timerPolicy90 ? { timerPolicy90: src.timerPolicy90 } : {})
        });
        return true;
      });
      return send(res, 200, { imported });
    }

    if (path === '/import-file' && method === 'POST') {
      if (!who.owner || user.role !== 'admin') throw fail(403, 'Faqat egasi.');
      const id = String(url.searchParams.get('id') || '');
      const { state } = await loadState(who.ws);
      const s = state || C.empty();
      const owners = [...s.messages.map((m) => [m.roomId, m.attachments]), ...s.tasks.map((t) => [t.roomId, t.attachments])];
      const hit = owners.find(([, list]) => (list || []).some((a) => a && a.id === id));
      if (!hit) throw fail(404, 'Bu fayl chatda yo‘q.');
      const meta = (hit[1] || []).find((a) => a.id === id);
      const exists = await rest(`erp119_chat_files?select=id&workspace_id=eq.${who.ws}&id=eq.${encodeURIComponent(id)}`);
      const bytes = await readRaw(req, MAX_FILE);
      if (!exists.length && bytes.length) {
        await rest('erp119_chat_files', {
          method: 'POST',
          headers: { prefer: 'return=minimal' },
          body: JSON.stringify({ workspace_id: who.ws, id, room_id: hit[0], name: String(meta.name || 'file').slice(0, 200), mime: String(meta.mime || 'application/octet-stream').slice(0, 100), size: bytes.length, data: bytes.toString('base64'), created_by: user.id })
        });
      }
      return send(res, 200, { ok: true });
    }

    throw fail(404, 'Noma’lum chat so‘rovi.');
  }

  return {
    matches: (pathname) => pathname === PREFIX || pathname.startsWith(PREFIX + '/'),
    async handle(req, res, url, pathname) {
      try {
        await route(req, res, url, pathname.slice(PREFIX.length) || '/');
      } catch (error) {
        const status = error.status >= 400 && error.status < 600 ? error.status : 500;
        if (status === 500) console.error('chat119:', error && error.stack || error);
        if (!res.headersSent) send(res, status, { error: status === 500 ? 'Chat serverida xato.' : error.message });
        else res.destroy();
      }
    }
  };
}
