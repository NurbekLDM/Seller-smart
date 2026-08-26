/* Admin user-management API (Vercel serverless function).
   Runs server-side with the Supabase service-role key, which must never
   reach the browser. Only members of the public.admins table (who are
   themselves active) may use it. Manages ACCOUNTS only — it never reads
   or writes any user's workspace data.

   Required environment variables (Vercel project settings):
     SUPABASE_URL               — project URL
     SUPABASE_ANON_KEY          — anon/publishable key (validates callers)
     SUPABASE_SERVICE_ROLE_KEY  — service_role / secret key (admin ops) */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

function callerToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookies = String(req.headers.cookie || '');
  const match = cookies.match(/(?:^|;\s*)sr-access-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
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

// Admin = row in public.admins AND an active profile.
async function isAdmin(userId) {
  const [admins, profiles] = await Promise.all([
    readJson(await fetch(`${SUPABASE_URL}/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(userId)}`, { headers: serviceHeaders })),
    readJson(await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=active&id=eq.${encodeURIComponent(userId)}`, { headers: serviceHeaders }))
  ]);
  return admins.length > 0 && profiles.length > 0 && profiles[0].active !== false;
}

async function listUsers() {
  const [authData, profiles, admins] = await Promise.all([
    readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: serviceHeaders })),
    readJson(await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,username,active`, { headers: serviceHeaders })),
    readJson(await fetch(`${SUPABASE_URL}/rest/v1/admins?select=user_id`, { headers: serviceHeaders }))
  ]);
  const authUsers = Array.isArray(authData) ? authData : (authData.users || []);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const adminIds = new Set(admins.map((row) => row.user_id));
  return authUsers.map((user) => {
    const profile = profileById.get(user.id) || {};
    return {
      id: user.id,
      email: user.email || '',
      username: profile.username || '',
      active: profile.active !== false,
      is_admin: adminIds.has(user.id),
      created_at: user.created_at || '',
      last_sign_in_at: user.last_sign_in_at || ''
    };
  }).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

function validEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 120;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

function cleanUsername(value) {
  return String(value || '').trim().slice(0, 60);
}

async function createUser(body) {
  if (!validEmail(body.email)) throw Object.assign(new Error('Email noto‘g‘ri.'), { status: 400 });
  if (!validPassword(body.password)) throw Object.assign(new Error('Parol kamida 8 belgidan iborat bo‘lishi kerak.'), { status: 400 });
  const created = await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      email: body.email.trim(),
      password: body.password,
      email_confirm: true,
      user_metadata: { username: cleanUsername(body.username) }
    })
  }));
  return { id: created.id, email: created.email };
}

async function updateProfile(callerId, body) {
  const id = String(body.id || '');
  if (!id) throw Object.assign(new Error('Foydalanuvchi tanlanmagan.'), { status: 400 });
  const patch = {};
  if (typeof body.username === 'string') patch.username = cleanUsername(body.username);
  if (typeof body.active === 'boolean') {
    if (id === callerId && body.active === false) {
      throw Object.assign(new Error('O‘zingizni o‘chira olmaysiz.'), { status: 400 });
    }
    patch.active = body.active;
  }
  if (!Object.keys(patch).length) throw Object.assign(new Error('O‘zgartirish ko‘rsatilmagan.'), { status: 400 });
  await readJson(await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...serviceHeaders, prefer: 'return=minimal' },
    body: JSON.stringify(patch)
  }));
  return { ok: true };
}

async function resetPassword(body) {
  const id = String(body.id || '');
  if (!id) throw Object.assign(new Error('Foydalanuvchi tanlanmagan.'), { status: 400 });
  if (!validPassword(body.password)) throw Object.assign(new Error('Parol kamida 8 belgidan iborat bo‘lishi kerak.'), { status: 400 });
  await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: serviceHeaders,
    body: JSON.stringify({ password: body.password })
  }));
  return { ok: true };
}

async function deleteUser(callerId, body) {
  const id = String(body.id || '');
  if (!id) throw Object.assign(new Error('Foydalanuvchi tanlanmagan.'), { status: 400 });
  if (id === callerId) throw Object.assign(new Error('O‘zingizni o‘chira olmaysiz.'), { status: 400 });
  await readJson(await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: serviceHeaders
  }));
  return { ok: true };
}

async function setAdmin(callerId, body) {
  const id = String(body.id || '');
  if (!id) throw Object.assign(new Error('Foydalanuvchi tanlanmagan.'), { status: 400 });
  if (body.is_admin === true) {
    await readJson(await fetch(`${SUPABASE_URL}/rest/v1/admins?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...serviceHeaders, prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: id })
    }));
    return { ok: true };
  }
  if (id === callerId) {
    throw Object.assign(new Error('O‘zingizni adminlikdan chiqara olmaysiz.'), { status: 400 });
  }
  await readJson(await fetch(`${SUPABASE_URL}/rest/v1/admins?user_id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...serviceHeaders, prefer: 'return=minimal' }
  }));
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !ANON_KEY) {
      return res.status(500).json({ error: 'Server sozlanmagan: SUPABASE_URL / SUPABASE_ANON_KEY yo‘q.' });
    }
    if (!SERVICE_KEY) {
      return res.status(500).json({ error: 'Server sozlanmagan: SUPABASE_SERVICE_ROLE_KEY qo‘shilmagan.' });
    }

    const caller = await authenticate(req);
    if (!caller) return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi.' });
    if (!(await isAdmin(caller.id))) {
      return res.status(403).json({ error: 'Bu sahifa faqat administrator uchun.' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ users: await listUsers(), me: { id: caller.id, email: caller.email } });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      switch (body.action) {
        case 'create': return res.status(201).json(await createUser(body));
        case 'update': return res.status(200).json(await updateProfile(caller.id, body));
        case 'password': return res.status(200).json(await resetPassword(body));
        case 'delete': return res.status(200).json(await deleteUser(caller.id, body));
        case 'set-admin': return res.status(200).json(await setAdmin(caller.id, body));
        default: return res.status(400).json({ error: 'Noma’lum amal.' });
      }
    }

    return res.status(405).json({ error: 'HTTP metod qo‘llanmaydi.' });
  } catch (error) {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    return res.status(status).json({ error: error.message || 'Server xatosi.' });
  }
}
