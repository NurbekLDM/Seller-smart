/* ERP staff management API (Vercel serverless function).
   Lets a WORKSPACE OWNER manage their own ERP employees: accounts that
   log in with a username (mapped to <username>@STAFF_EMAIL_DOMAIN), see
   only the ERP sections the owner grants them, and work inside the
   owner's workspace. Owners can only ever touch staff bound to themselves.
   Managed from the ERP's own "Employees" screen (public/assets/erp-page.js
   bridges that native UI to this API).

   Environment variables:
     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (required)
     STAFF_EMAIL_DOMAIN (optional, default staff.sellersmart.uz) */

import { recordAudit } from './_audit.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
/* Sanitised, not used raw: a value pasted into the Vercel dashboard can
   carry a stray space or newline (invisible there) or a leading "@", and
   Supabase Auth then refuses every staff address with "Unable to validate
   email address: invalid format". Anything that is not a plain hostname
   falls back to the default and is logged, so the Employees screen keeps
   working while the variable gets fixed. */
const DEFAULT_STAFF_DOMAIN = 'staff.sellersmart.uz';
const STAFF_DOMAIN = (function () {
  const raw = String(process.env.STAFF_EMAIL_DOMAIN || '').trim().replace(/^@+/, '').replace(/\.+$/, '').toLowerCase();
  if (!raw) return DEFAULT_STAFF_DOMAIN;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw)) {
    console.warn('sr-staff: STAFF_EMAIL_DOMAIN is not a valid hostname, using the default', JSON.stringify({ value: process.env.STAFF_EMAIL_DOMAIN }));
    return DEFAULT_STAFF_DOMAIN;
  }
  return raw;
})();
const MAX_STAFF = 30;

const serviceHeaders = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  'content-type': 'application/json'
};

async function readJson(response) {
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* empty body */ }
  if (!response.ok) {
    const message = payload.msg || payload.message || payload.error_description || payload.error || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function callerToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookies = String(req.headers.cookie || '');
  const match = cookies.match(/(?:^|;\s*)sr-access-token=([^;]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch (_) { return ''; }
}

async function authenticate(req) {
  const token = callerToken(req);
  if (!token) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

function notExpired(profile) {
  return !profile.expires_at || new Date(profile.expires_at).getTime() > Date.now();
}

// The caller must be an active, unexpired workspace OWNER who has the ERP.
async function requireOwner(userId) {
  const rows = await readJson(await fetch(
    // select=*: the products column (2026-09-03) may not exist yet.
    `${SUPABASE_URL}/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`,
    { headers: serviceHeaders }
  ));
  const profile = rows[0];
  if (!profile || profile.active === false || !notExpired(profile)) throw fail(403, 'Hisobingiz faol emas.');
  if (profile.workspace_owner) throw fail(403, 'Xodimlarni faqat workspace egasi boshqaradi.');
  // ERP staff belong to the ERP product; an account without it has none.
  if (Array.isArray(profile.products) && !profile.products.includes('erp')) {
    throw fail(403, 'Bu hisobga Smart Retail ERP ulanmagan.');
  }
  return profile;
}

async function ownStaffProfiles(ownerId) {
  return readJson(await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id,username,active,erp_modules&workspace_owner=eq.${encodeURIComponent(ownerId)}`,
    { headers: serviceHeaders }
  ));
}

async function requireOwnStaff(ownerId, staffId) {
  const rows = await readJson(await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id,workspace_owner&id=eq.${encodeURIComponent(staffId)}&workspace_owner=eq.${encodeURIComponent(ownerId)}`,
    { headers: serviceHeaders }
  ));
  if (!rows.length) throw fail(404, 'Bunday xodim topilmadi.');
}

async function listStaff(ownerId) {
  const [profiles, authData] = await Promise.all([
    ownStaffProfiles(ownerId),
    readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: serviceHeaders }))
  ]);
  const authUsers = Array.isArray(authData) ? authData : (authData.users || []);
  const authById = new Map(authUsers.map((user) => [user.id, user]));
  return profiles.map((profile) => {
    const authUser = authById.get(profile.id) || {};
    const email = authUser.email || '';
    return {
      id: profile.id,
      login: email.endsWith(`@${STAFF_DOMAIN}`) ? email.slice(0, -(STAFF_DOMAIN.length + 1)) : email,
      name: profile.username || '',
      active: profile.active !== false,
      erp_modules: Array.isArray(profile.erp_modules) ? profile.erp_modules : [],
      last_sign_in_at: authUser.last_sign_in_at || '',
      created_at: authUser.created_at || ''
    };
  }).sort((a, b) => a.login.localeCompare(b.login));
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

// Whitelist by shape rather than by a fixed enum: the embedded ERP's own
// menu/section ids have changed across vendor upgrades, so pin the format
// (lowercase id-like tokens) and let the owner only ever grant sections
// that actually exist in the ERP's own permission picker on the client.
function validModules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    if (typeof value === 'string' && /^[a-z0-9_-]{2,40}$/.test(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
      if (out.length >= 25) break;
    }
  }
  return out;
}

async function createStaff(ownerId, body) {
  const login = String(body.login || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(login)) {
    throw fail(400, 'Login 3–30 belgidan iborat bo‘lsin: faqat kichik lotin harflari, raqamlar va _');
  }
  if (!validPassword(body.password)) throw fail(400, 'Parol kamida 8 belgidan iborat bo‘lishi kerak.');
  const name = String(body.name || '').trim().slice(0, 60) || login;
  const modules = validModules(body.modules);
  if (!modules.length) throw fail(400, 'Kamida bitta bo‘limga ruxsat bering.');

  const existing = await ownStaffProfiles(ownerId);
  if (existing.length >= MAX_STAFF) throw fail(400, `Xodimlar soni cheklangan (${MAX_STAFF}).`);

  let created;
  try {
    created = await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({
        email: `${login}@${STAFF_DOMAIN}`,
        password: body.password,
        email_confirm: true,
        user_metadata: { username: name }
      })
    }));
  } catch (error) {
    if (/already|registered|exists|duplicate/i.test(error.message)) {
      throw fail(409, `"${login}" logini band. Boshqa login tanlang.`);
    }
    // Say WHICH address was refused: the login is the owner's, the
    // domain is ours, and only one of them can be at fault.
    if (/validate email|email address/i.test(error.message)) {
      throw fail(400, `Supabase "${login}@${STAFF_DOMAIN}" manzilini qabul qilmadi (${error.message}).`);
    }
    throw error;
  }

  // Bind the profile to the owner. If this fails, roll the auth user back
  // so no half-provisioned account (a full owner workspace!) survives.
  try {
    await readJson(await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      headers: { ...serviceHeaders, prefer: 'return=minimal' },
      body: JSON.stringify({ workspace_owner: ownerId, erp_role: 'STAFF', username: name, erp_modules: modules })
    }));
  } catch (bindError) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(created.id)}`, {
        method: 'DELETE',
        headers: serviceHeaders
      });
    } catch (_) { /* best-effort rollback */ }
    throw fail(500, 'Xodimni bog‘lab bo‘lmadi, qaytadan urinib ko‘ring: ' + bindError.message);
  }
  return { id: created.id, login };
}

async function updateStaff(ownerId, body) {
  const id = String(body.id || '');
  if (!id) throw fail(400, 'Xodim tanlanmagan.');
  await requireOwnStaff(ownerId, id);
  const patch = {};
  if (typeof body.active === 'boolean') patch.active = body.active;
  if (typeof body.name === 'string') patch.username = body.name.trim().slice(0, 60);
  if (body.modules !== undefined) {
    const modules = validModules(body.modules);
    if (!modules.length) throw fail(400, 'Kamida bitta bo‘limga ruxsat bering.');
    patch.erp_modules = modules;
  }
  if (Object.keys(patch).length) {
    await readJson(await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...serviceHeaders, prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    }));
  }
  if (body.password !== undefined) {
    if (!validPassword(body.password)) throw fail(400, 'Parol kamida 8 belgidan iborat bo‘lishi kerak.');
    await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: serviceHeaders,
      body: JSON.stringify({ password: body.password })
    }));
  }
  return { ok: true };
}

async function deleteStaff(ownerId, body) {
  const id = String(body.id || '');
  if (!id) throw fail(400, 'Xodim tanlanmagan.');
  await requireOwnStaff(ownerId, id);
  await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: serviceHeaders
  }));
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
      return res.status(500).json({ error: 'Server sozlanmagan: Supabase kalitlari yetishmayapti.' });
    }
    const caller = await authenticate(req);
    if (!caller) return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi.' });
    await requireOwner(caller.id);

    if (req.method === 'GET') {
      return res.status(200).json({ staff: await listStaff(caller.id), staffDomain: STAFF_DOMAIN });
    }
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const actions = {
        create: () => createStaff(caller.id, body),
        update: () => updateStaff(caller.id, body),
        delete: () => deleteStaff(caller.id, body)
      };
      const run = actions[body.action];
      if (!run) return res.status(400).json({ error: 'Noma’lum amal.' });
      const result = await run();
      await recordAudit({
        actor_id: caller.id,
        actor_email: caller.email,
        action: 'staff.' + body.action,
        target_id: body.action === 'create' ? result.id : (body.id || null),
        service: 'erp',
        details: {
          login: body.login, name: body.name, active: body.active, modules: body.modules,
          password_changed: Boolean(body.password)
        }
      }, req);
      return res.status(body.action === 'create' ? 201 : 200).json(result);
    }
    return res.status(405).json({ error: 'HTTP metod qo‘llanmaydi.' });
  } catch (error) {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    return res.status(status).json({ error: error.message || 'Server xatosi.' });
  }
}
