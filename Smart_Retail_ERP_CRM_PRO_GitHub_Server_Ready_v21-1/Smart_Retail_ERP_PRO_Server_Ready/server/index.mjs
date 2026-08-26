import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import {
  HttpError, verifyUser, createSession, findSession, destroySession, recordAudit, readState, saveState,
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer, listDebts, createDebt,
  updateDebt, createPayment, listPayments, dashboard, listAudit, closeDatabase
} from './database.mjs';

const VERSION = '21.0.0';
const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 7;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self' blob: data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.datatables.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.datatables.net https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(response, status, data) {
  securityHeaders(response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private'
  });
  response.end(JSON.stringify(data));
}

function requestIp(request) {
  if (config.trustProxy) return String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || '';
  return request.socket.remoteAddress || '';
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function setSessionCookie(response, token, maxAge = config.sessionHours * 3600) {
  const attributes = [`srerp_sid=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (config.secureCookies) attributes.push('Secure');
  response.setHeader('Set-Cookie', attributes.join('; '));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const forwardedProto = config.trustProxy ? String(request.headers['x-forwarded-proto'] || '').split(',')[0] : '';
  const host = config.trustProxy ? String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0] : request.headers.host;
  const allowed = config.appOrigin || `${forwardedProto || (config.secureCookies ? 'https' : 'http')}://${host}`;
  return origin === allowed;
}

function csrfMatches(actual, expected) {
  if (!actual || !expected) return false;
  const first = Buffer.from(String(actual));
  const second = Buffer.from(String(expected));
  return first.length === second.length && timingSafeEqual(first, second);
}

async function bodyJson(request) {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > config.maxBodyBytes) throw new HttpError(413, 'Request body is larger than the configured limit.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
    return value;
  } catch (_) { throw new HttpError(400, 'Request body must contain a valid JSON object.'); }
}

function enforceRateLimit(request, username) {
  const key = `${requestIp(request)}:${String(username || '').toLowerCase()}`;
  const threshold = Date.now() - WINDOW_MS;
  const attempts = (loginAttempts.get(key) || []).filter(value => value > threshold);
  if (attempts.length >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
  return {
    failure() { attempts.push(Date.now()); loginAttempts.set(key, attempts); },
    success() { loginAttempts.delete(key); }
  };
}

function authorize(request, response, pathname) {
  const token = cookies(request).srerp_sid;
  const session = findSession(token);
  if (!session) {
    if (pathname.startsWith('/api/')) throw new HttpError(401, 'Authentication is required.');
    securityHeaders(response);
    response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    response.end();
    return null;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method || '') && !csrfMatches(request.headers['x-csrf-token'], session.csrfToken)) {
    throw new HttpError(403, 'A valid CSRF token is required.');
  }
  return { ...session, token };
}

function requireRole(session, roles) {
  if (!roles.includes(session.user.role)) throw new HttpError(403, 'Your account does not have permission for this action.');
}

function staticFile(request, response, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { throw new HttpError(400, 'Invalid file path.'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'Invalid file path.');
  const candidate = resolve(config.publicDirectory, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (candidate !== config.publicDirectory && !candidate.startsWith(config.publicDirectory + sep)) throw new HttpError(403, 'File path is outside the public directory.');
  let stat;
  try { stat = statSync(candidate); } catch (_) { throw new HttpError(404, 'Requested page was not found.'); }
  if (!stat.isFile()) throw new HttpError(404, 'Requested page was not found.');
  securityHeaders(response);
  response.writeHead(200, {
    'Content-Type': MIME[extname(candidate).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': candidate.endsWith('.html') ? 'no-store, private' : 'private, max-age=3600'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(candidate).pipe(response);
}

async function router(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  const method = request.method || 'GET';
  const query = Object.fromEntries(requestUrl.searchParams.entries());

  if (method === 'GET' && pathname === '/api/health') return json(response, 200, { ok: true, service: 'smart-retail-erp', version: VERSION });
  if (!['GET', 'HEAD'].includes(method) && !sameOrigin(request)) throw new HttpError(403, 'Cross-origin requests are not allowed.');

  if (pathname === '/login' && method === 'GET') {
    if (findSession(cookies(request).srerp_sid)) {
      securityHeaders(response);
      response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    return staticFile(request, response, '/login.html');
  }

  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    const body = await bodyJson(request);
    const limiter = enforceRateLimit(request, body.username);
    const user = verifyUser(body.username, body.password);
    if (!user) {
      limiter.failure();
      recordAudit('anonymous', 'LOGIN_FAILURE', 'auth', String(body.username || '').slice(0, 80), 'Unsuccessful login attempt.', {}, requestIp(request));
      throw new HttpError(401, 'Login yoki parol noto‘g‘ri.');
    }
    limiter.success();
    const session = createSession(user);
    setSessionCookie(response, session.token);
    recordAudit(user.username, 'LOGIN_SUCCESS', 'auth', user.id, 'Successful server login.', {}, requestIp(request));
    return json(response, 200, { ok: true, user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }

  const session = authorize(request, response, pathname);
  if (!session) return;

  if (pathname === '/api/v1/auth/me' && method === 'GET') {
    return json(response, 200, { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }
  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    destroySession(session.token);
    setSessionCookie(response, '', 0);
    recordAudit(session.user.username, 'LOGOUT', 'auth', session.user.id, 'Server session closed.', {}, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (pathname === '/api/v1/state' && method === 'GET') return json(response, 200, readState());
  if (pathname === '/api/v1/state' && method === 'PUT') {
    requireRole(session, ['ADMIN', 'POS', 'WMS']);
    const input = await bodyJson(request);
    return json(response, 200, saveState(input.snapshot, input.expectedVersion, session.user.username, requestIp(request)));
  }
  if (pathname === '/api/v1/dashboard' && method === 'GET') return json(response, 200, dashboard());
  if (pathname === '/api/v1/audit' && method === 'GET') {
    requireRole(session, ['ADMIN']);
    return json(response, 200, listAudit(query));
  }
  if (pathname === '/api/v1/customers' && method === 'GET') return json(response, 200, listCustomers(query));
  if (pathname === '/api/v1/customers' && method === 'POST') {
    requireRole(session, ['ADMIN', 'POS']);
    return json(response, 201, createCustomer(await bodyJson(request), session.user.username, requestIp(request)));
  }

  let match = pathname.match(/^\/api\/v1\/customers\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (method === 'GET') return json(response, 200, getCustomer(id));
    if (method === 'PATCH') {
      requireRole(session, ['ADMIN', 'POS']);
      return json(response, 200, updateCustomer(id, await bodyJson(request), session.user.username, requestIp(request)));
    }
    if (method === 'DELETE') {
      requireRole(session, ['ADMIN']);
      return json(response, 200, deleteCustomer(id, session.user.username, requestIp(request)));
    }
  }

  if (pathname === '/api/v1/debts' && method === 'GET') return json(response, 200, listDebts(query));
  if (pathname === '/api/v1/debts' && method === 'POST') {
    requireRole(session, ['ADMIN', 'POS']);
    return json(response, 201, createDebt(await bodyJson(request), session.user.username, session.user.role, requestIp(request)));
  }
  match = pathname.match(/^\/api\/v1\/debts\/([^/]+)$/);
  if (match && method === 'PATCH') {
    requireRole(session, ['ADMIN', 'POS']);
    return json(response, 200, updateDebt(decodeURIComponent(match[1]), await bodyJson(request), session.user.username, requestIp(request)));
  }
  match = pathname.match(/^\/api\/v1\/debts\/([^/]+)\/payments$/);
  if (match && method === 'POST') {
    requireRole(session, ['ADMIN', 'POS']);
    return json(response, 201, createPayment(decodeURIComponent(match[1]), await bodyJson(request), session.user.username, requestIp(request)));
  }
  if (pathname === '/api/v1/payments' && method === 'GET') return json(response, 200, listPayments(query));

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found.');
  if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, 'HTTP method is not supported.');
  return staticFile(request, response, pathname);
}

export const server = createServer((request, response) => {
  router(request, response).catch(error => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal server error.';
    if (!(error instanceof HttpError)) console.error(JSON.stringify({ level: 'error', message: error.message, stack: error.stack, at: new Date().toISOString() }));
    if (!response.headersSent) json(response, status, { error: message, ...(error.details ? { details: error.details } : {}) });
    else response.end();
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_started', host: config.host, port: config.port, version: VERSION, database: config.databasePath, mode: config.production ? 'production' : 'development' }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'server_stopping', signal }));
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  const timeout = setTimeout(() => process.exit(1), 8_000);
  timeout.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
