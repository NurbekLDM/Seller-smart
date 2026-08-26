import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(directory, port) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DATABASE_PATH: join(directory, 'smart-retail.sqlite'),
      ADMIN_USERNAME: 'Admin', ADMIN_PASSWORD: 'TestServerPassword!2026',
      SECURE_COOKIES: '0', TRUST_PROXY: '0', TENANT_ID: 'test_store'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Server startup timeout. ${diagnostics}`)), 7000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Server exited with code ${code}: ${diagnostics}`)); });
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('server_started')) { clearTimeout(deadline); resolve(); }
    });
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('production API: authentication, CRM, receivables, synchronization and persistence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-retail-test-'));
  const port = await availablePort();
  const root = `http://127.0.0.1:${port}`;
  let child = await startServer(directory, port);
  let cookie = '';
  let csrfToken = '';
  let customerId = '';
  let debtId = '';

  t.after(async () => {
    await stopServer(child);
    await rm(directory, { recursive: true, force: true });
  });

  async function request(path, { method = 'GET', body, authenticated = true, csrf = true, headers = {}, redirect = 'follow' } = {}) {
    const requestHeaders = { ...headers };
    if (authenticated && cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (csrf && csrfToken && !['GET', 'HEAD'].includes(method)) requestHeaders['X-CSRF-Token'] = csrfToken;
    const response = await fetch(root + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : await response.text();
    return { response, payload };
  }

  await t.test('public health endpoint exposes no private information', async () => {
    const { response, payload } = await request('/api/health', { authenticated: false });
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, service: 'smart-retail-erp', version: '21.0.0' });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('private APIs reject unauthenticated requests', async () => {
    const { response } = await request('/api/v1/state', { authenticated: false });
    assert.equal(response.status, 401);
  });

  await t.test('private pages redirect unauthenticated visitors to login', async () => {
    const { response } = await request('/', { authenticated: false, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  });

  await t.test('login page is accessible without a session', async () => {
    const { response, payload } = await request('/login', { authenticated: false });
    assert.equal(response.status, 200);
    assert.match(payload, /Smart Retail ERP/);
  });

  await t.test('incorrect credentials are rejected', async () => {
    const { response } = await request('/api/v1/auth/login', { method: 'POST', authenticated: false, body: { username: 'Admin', password: 'wrong' } });
    assert.equal(response.status, 401);
  });

  await t.test('login creates HttpOnly SameSite session and CSRF token', async () => {
    const { response, payload } = await request('/api/v1/auth/login', { method: 'POST', authenticated: false, body: { username: 'Admin', password: 'TestServerPassword!2026' } });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0];
    csrfToken = payload.csrfToken;
    assert.equal(payload.user.role, 'ADMIN');
  });

  await t.test('authenticated users receive the complete application', async () => {
    const { response, payload } = await request('/');
    assert.equal(response.status, 200);
    assert.match(payload, /SMART_RETAIL_PARENT_SYNC_21_BEGIN/);
  });

  await t.test('mutations reject missing CSRF token', async () => {
    const { response } = await request('/api/v1/customers', { method: 'POST', csrf: false, body: { name: 'Blocked' } });
    assert.equal(response.status, 403);
  });

  await t.test('mutations reject foreign origins', async () => {
    const { response } = await request('/api/v1/customers', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: { name: 'Blocked' } });
    assert.equal(response.status, 403);
  });

  await t.test('customers require valid names', async () => {
    const { response } = await request('/api/v1/customers', { method: 'POST', body: { name: '' } });
    assert.equal(response.status, 422);
  });

  await t.test('customer creation persists the extended CRM profile', async () => {
    const { response, payload } = await request('/api/v1/customers', { method: 'POST', body: { name: 'Dilnoza Yusupova', phone: '+998 90 123 45 67', limit: 1_000_000, creditDays: 20, segment: 'VIP', telegram: '@dilnoza', email: 'dilnoza@example.uz' } });
    assert.equal(response.status, 201);
    assert.equal(payload.customer.segment, 'VIP');
    assert.equal(payload.version, 1);
    customerId = payload.id;
  });

  await t.test('duplicate customer phone numbers are blocked', async () => {
    const { response } = await request('/api/v1/customers', { method: 'POST', body: { name: 'Duplicate', phone: '998901234567' } });
    assert.equal(response.status, 409);
  });

  await t.test('customer list supports indexed search', async () => {
    const { response, payload } = await request('/api/v1/customers?search=Dilnoza');
    assert.equal(response.status, 200);
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0].id, customerId);
  });

  await t.test('credit-limit breaches require explicit administrator approval', async () => {
    const { response } = await request('/api/v1/debts', { method: 'POST', body: { customerId, total: 1_500_000, paid: 0, dueDate: '2026-09-01' } });
    assert.equal(response.status, 409);
  });

  await t.test('debt creation records the initial payment', async () => {
    const { response, payload } = await request('/api/v1/debts', { method: 'POST', body: { customerId, total: 900_000, paid: 100_000, dueDate: '2026-09-01', invoiceNo: 'INV-TEST-001', note: 'Test nasiya' } });
    assert.equal(response.status, 201);
    assert.equal(payload.debt.remaining, 800_000);
    assert.equal(payload.debt.invoiceNo, 'INV-TEST-001');
    debtId = payload.id;
    const { payload: paymentList } = await request('/api/v1/payments');
    assert.equal(paymentList.total, 1);
    assert.equal(paymentList.items[0].source, 'initial');
  });

  await t.test('partial payment reduces the outstanding balance', async () => {
    const { response, payload } = await request(`/api/v1/debts/${encodeURIComponent(debtId)}/payments`, { method: 'POST', body: { amount: 300_000, method: 'Click', reference: 'TX-001', note: 'Birinchi to‘lov' } });
    assert.equal(response.status, 201);
    assert.equal(payload.debt.remaining, 500_000);
    assert.equal(payload.payment.method, 'Click');
  });

  await t.test('overpayments are rejected without changing financial records', async () => {
    const before = await request('/api/v1/payments');
    const { response } = await request(`/api/v1/debts/${encodeURIComponent(debtId)}/payments`, { method: 'POST', body: { amount: 500_001 } });
    assert.equal(response.status, 422);
    const after = await request('/api/v1/payments');
    assert.equal(after.payload.total, before.payload.total);
  });

  await t.test('customer name changes propagate into debt records', async () => {
    const { response, payload } = await request(`/api/v1/customers/${encodeURIComponent(customerId)}`, { method: 'PATCH', body: { name: 'Dilnoza Karimova', limit: 1_200_000 } });
    assert.equal(response.status, 200);
    assert.equal(payload.customer.name, 'Dilnoza Karimova');
    const { payload: list } = await request('/api/v1/debts');
    assert.equal(list.items[0].customer, 'Dilnoza Karimova');
  });

  await t.test('debt due dates and notes can be updated safely', async () => {
    const { response, payload } = await request(`/api/v1/debts/${encodeURIComponent(debtId)}`, { method: 'PATCH', body: { dueDate: '2026-10-01', note: 'Muddat uzaytirildi' } });
    assert.equal(response.status, 200);
    assert.equal(payload.debt.dueDate, '2026-10-01');
  });

  await t.test('dashboard aggregates customers, debt and collections', async () => {
    const { response, payload } = await request('/api/v1/dashboard');
    assert.equal(response.status, 200);
    assert.equal(payload.customers.total, 1);
    assert.equal(payload.debt.outstanding, 500_000);
    assert.equal(payload.collections.today, 400_000);
  });

  await t.test('financial history prevents customer deletion', async () => {
    const { response } = await request(`/api/v1/customers/${encodeURIComponent(customerId)}`, { method: 'DELETE' });
    assert.equal(response.status, 409);
  });

  await t.test('optimistic concurrency prevents silent overwrite', async () => {
    const { payload: current } = await request('/api/v1/state');
    const { response, payload } = await request('/api/v1/state', { method: 'PUT', body: { expectedVersion: current.version - 1, snapshot: current.snapshot } });
    assert.equal(response.status, 409);
    assert.equal(payload.details.currentVersion, current.version);
  });

  await t.test('analytics and ERP state persist together in one server snapshot', async () => {
    const { payload: current } = await request('/api/v1/state');
    const analytics = { datasets: { sales: [{ sku: 'UZUM-001', revenue: 250000 }] }, settings: { theme: 'dark' } };
    const snapshot = { ...current.snapshot, srerp_analytics_parent_state: JSON.stringify(analytics) };
    const { response } = await request('/api/v1/state', { method: 'PUT', body: { expectedVersion: current.version, snapshot } });
    assert.equal(response.status, 200);
    const { payload: restored } = await request('/api/v1/state');
    assert.equal(JSON.parse(restored.snapshot.srerp_analytics_parent_state).datasets.sales[0].sku, 'UZUM-001');
    assert.equal(JSON.parse(restored.snapshot.srerp_customers)[0].name, 'Dilnoza Karimova');
  });

  await t.test('password and token keys cannot be synchronized', async () => {
    const { payload: current } = await request('/api/v1/state');
    const { response } = await request('/api/v1/state', { method: 'PUT', body: { expectedVersion: current.version, snapshot: { ...current.snapshot, srerp_auth_users_v6: '[]' } } });
    assert.equal(response.status, 422);
  });

  await t.test('invalid references roll back the complete transaction', async () => {
    const { payload: before } = await request('/api/v1/state');
    const snapshot = { ...before.snapshot, srerp_debts: JSON.stringify([{ id: 'BROKEN', customerId: 'missing', total: 1, paid: 0 }]) };
    const { response } = await request('/api/v1/state', { method: 'PUT', body: { expectedVersion: before.version, snapshot } });
    assert.equal(response.status, 422);
    const { payload: after } = await request('/api/v1/state');
    assert.equal(after.version, before.version);
  });

  await t.test('final payment closes the receivable', async () => {
    const { response, payload } = await request(`/api/v1/debts/${encodeURIComponent(debtId)}/payments`, { method: 'POST', body: { amount: 500_000, method: 'Bank o‘tkazmasi' } });
    assert.equal(response.status, 201);
    assert.equal(payload.debt.remaining, 0);
    assert.equal(payload.debt.status, 'Yopilgan');
  });

  await t.test('administrator can inspect financial audit events', async () => {
    const { response, payload } = await request('/api/v1/audit');
    assert.equal(response.status, 200);
    assert.ok(payload.items.some(event => event.eventType === 'PAYMENT_CREATE'));
    assert.ok(payload.items.some(event => event.eventType === 'CUSTOMER_CREATE'));
  });

  await t.test('SQLite database is durable across process restart', async () => {
    await stopServer(child);
    assert.ok((await stat(join(directory, 'smart-retail.sqlite'))).size > 0);
    child = await startServer(directory, port);
    const { response, payload } = await request('/api/v1/customers');
    assert.equal(response.status, 200);
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0].name, 'Dilnoza Karimova');
  });

  await t.test('logout destroys the authenticated session', async () => {
    const { response } = await request('/api/v1/auth/logout', { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    const blocked = await request('/api/v1/state');
    assert.equal(blocked.response.status, 401);
  });
});
