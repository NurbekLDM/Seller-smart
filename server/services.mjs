/* Account-based access to the services that are not part of the main app:
   Kartochka Studio (kartochka.<domain>, its own container) and Diet Seller
   (served at /diet). Both used to be open or behind one shared password;
   now each person uses their own SellerSmart account, and an administrator
   gives or takes the service per account (service_grants,
   supabase/2026-11-28-erp119-team.sql).

   How it works:
     1. "Mening servislarim" (/app.html) asks POST /api/gate/issue with the
        user's session. The server checks the account (Supabase Auth) and
        the grant (service_allowed), then sets a signed cookie, sr-svc, for
        the whole domain (kartochka.<domain> and <domain> alike), valid 12 h.
     2. Every request to Kartochka passes Caddy's forward_auth through
        GET /api/gate/check?service=kartochka; /diet checks the same way
        here. The cookie must be valid AND the grant must still hold — it
        is re-checked at most once a minute per account, so blocking an
        account takes effect within a minute, not after 12 hours.
     3. No cookie, expired, or no grant: a page request goes to the cabinet
        (/app.html?svc=…&next=…), which renews it in one hop and comes back.

   Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
   APP_DOMAIN (cookie domain and cabinet address; without it: off),
   SERVICE_GATE_SECRET (optional; default derived from the service key). */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const COOKIE = 'sr-svc';
const TTL_S = 12 * 3600;
const GATED = ['kartochka', 'diet'];

export function createServices({ env, root, audit }) {
  const SUPABASE_URL = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const ANON = String(env.SUPABASE_ANON_KEY || '');
  const SERVICE = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const DOMAIN = String(env.APP_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!SUPABASE_URL || !ANON || !SERVICE || !DOMAIN) return null;
  const SECRET = String(env.SERVICE_GATE_SECRET || '') || createHash('sha256').update('sr-gate:' + SERVICE).digest('hex');
  const dietFile = join(root, 'releases', 'diet-seller', 'DIET_SELLER_v2.html');

  const b64 = (s) => Buffer.from(s).toString('base64url');
  const sign = (body) => createHmac('sha256', SECRET).update(body).digest('base64url');

  function issue(userId) {
    const body = b64(JSON.stringify({ u: userId, exp: Math.floor(Date.now() / 1000) + TTL_S }));
    return body + '.' + sign(body);
  }
  function read(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(sign(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p && p.u && p.exp > Date.now() / 1000 ? p : null;
    } catch (_) { return null; }
  }
  function cookieOf(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
  }

  const grantCache = new Map(); // user:service -> { at, ok }
  async function allowed(userId, service) {
    const key = userId + ':' + service;
    const c = grantCache.get(key);
    if (c && Date.now() - c.at < 60000) return c.ok;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/service_allowed`, {
      method: 'POST',
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user: userId, p_service: service })
    });
    const ok = r.ok && (await r.json()) === true;
    grantCache.set(key, { at: Date.now(), ok });
    if (grantCache.size > 2000) grantCache.clear();
    return ok;
  }

  async function sessionUser(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : cookieOf(req, 'sr-access-token');
    if (!token) return null;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  }

  // Only our own hosts may be a "next" address.
  function safeNext(next, service) {
    const fallback = service === 'kartochka' ? `https://kartochka.${DOMAIN}/` : `https://${DOMAIN}/diet`;
    try {
      if (!next) return fallback;
      const u = new URL(String(next), fallback);
      const host = u.hostname.toLowerCase();
      if (u.protocol === 'https:' && (host === DOMAIN || host.endsWith('.' + DOMAIN))) return u.toString();
    } catch (_) { /* bad url */ }
    return fallback;
  }

  function cabinet(service, next) {
    return `https://${DOMAIN}/app.html?svc=${encodeURIComponent(service)}&next=${encodeURIComponent(next)}`;
  }

  function json(res, status, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store', ...extra });
    res.end(data);
  }

  async function passes(req, service) {
    const p = read(cookieOf(req, COOKIE));
    return !!p && await allowed(p.u, service);
  }

  return {
    domain: DOMAIN,
    matches: (pathname) => pathname === '/api/gate/check' || pathname === '/api/gate/issue' || pathname === '/diet' || pathname === '/diet/',

    async handle(req, res, url, pathname) {
      if (pathname === '/api/gate/check') {
        const service = url.searchParams.get('service') || '';
        if (!GATED.includes(service)) return json(res, 400, { error: 'unknown service' });
        if (await passes(req, service)) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
        const method = String(req.headers['x-forwarded-method'] || 'GET').toUpperCase();
        const original = `https://${req.headers['x-forwarded-host'] || `${service}.${DOMAIN}`}${req.headers['x-forwarded-uri'] || '/'}`;
        if (method === 'GET' || method === 'HEAD') {
          res.writeHead(302, { location: cabinet(service, safeNext(original, service)), 'cache-control': 'no-store' });
          return res.end();
        }
        return json(res, 401, { error: 'SellerSmart hisobi bilan qayta kiring: sahifani yangilang.' });
      }

      if (pathname === '/api/gate/issue') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
        let body = {};
        try {
          const chunks = [];
          for await (const c of req) { chunks.push(c); if (chunks.length > 64) break; }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (_) { body = {}; }
        const service = String(body.service || '');
        if (!GATED.includes(service)) return json(res, 400, { error: 'Noma’lum servis.' });
        const user = await sessionUser(req);
        if (!user) return json(res, 401, { error: 'Qayta kiring.' });
        grantCache.delete(user.id + ':' + service);
        if (!(await allowed(user.id, service))) return json(res, 403, { error: 'Bu servis hisobingizga ulanmagan yoki muddati tugagan.' });
        const cookie = [`${COOKIE}=${issue(user.id)}`, `Domain=${DOMAIN}`, 'Path=/', `Max-Age=${TTL_S}`, 'HttpOnly', 'Secure', 'SameSite=Lax'].join('; ');
        if (audit) audit({ actor_id: user.id, actor_email: user.email, action: 'service.open', service, target_id: user.id }).catch(() => {});
        return json(res, 200, { url: safeNext(body.next, service) }, { 'set-cookie': cookie });
      }

      // Diet Seller (a single-file app) for accounts that have it.
      if (pathname === '/diet' || pathname === '/diet/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
        if (!(await passes(req, 'diet'))) {
          res.writeHead(302, { location: cabinet('diet', `https://${DOMAIN}/diet`), 'cache-control': 'no-store' });
          return res.end();
        }
        const info = await stat(dietFile);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': info.size,
          'cache-control': 'private, no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin'
        });
        if (req.method === 'HEAD') return res.end();
        createReadStream(dietFile).on('error', () => res.destroy()).pipe(res);
      }
    }
  };
}
