import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext, runInContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const file = pathname => readFileSync(new URL(pathname, root), 'utf8');

test('complete analytics application embeds the exact enhanced ERP payload', () => {
  const analytics = file('public/index.html');
  const erp = file('public/erp.html');
  const match = analytics.match(/const SMART_RETAIL_ERP_B64 = "([^"]+)";/);
  assert.ok(match, 'Embedded ERP base64 payload is required.');
  assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), erp);
  assert.match(analytics, /SMART_RETAIL_PARENT_SYNC_21_BEGIN/);
  assert.match(analytics, /Smart Retail ERP v21\.0/);
  assert.match(erp, /SMART_RETAIL_CRM_PRO_21_BEGIN/);
  assert.match(erp, /crm21ProfessionalModule/);
  assert.match(erp, /crm21ServerSync/);
  assert.match(erp, /SMART_RETAIL_OFFLINE_RUNTIME_21_BEGIN/);
});

test('CRM, receivables and synchronization assets contain valid JavaScript', () => {
  for (const pathname of ['public/assets/crm-pro.js', 'public/assets/offline-runtime.js', 'public/assets/server-sync.js', 'public/assets/analytics-sync.js']) {
    assert.doesNotThrow(() => new Script(file(pathname), { filename: pathname }));
  }
});

test('production deployment files exclude secrets and include CI/CD controls', () => {
  const ignore = file('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /\*\.sqlite/);
  assert.match(file('docker-compose.yml'), /no-new-privileges:true/);
  assert.match(file('.github/workflows/deploy.yml'), /StrictHostKeyChecking=yes/);
  assert.match(file('server/schema.sql'), /FOREIGN KEY \(tenant_id, customer_id\)/);
});

test('offline fallback provides working modal, table and chart interfaces', () => {
  const styles = [];
  const listeners = new Map();
  const classNames = new Set();
  const element = {
    id: 'example-modal',
    style: {},
    classList: {
      add: value => classNames.add(value),
      remove: value => classNames.delete(value),
      contains: value => classNames.has(value)
    },
    setAttribute() {},
    removeAttribute() {},
    dispatchEvent() {}
  };
  const document = {
    head: { appendChild: node => styles.push(node) },
    body: { classList: { add() {}, remove() {} } },
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: (event, handler) => listeners.set(event, handler),
    querySelector: selector => selector === '.modal.show' && classNames.has('show') ? element : null,
    querySelectorAll: () => []
  };
  const context = { document, Event, WeakMap, Array, Math, Number, Error };
  context.window = context;
  runInContext(file('public/assets/offline-runtime.js'), createContext(context));
  assert.equal(typeof context.$, 'function');
  assert.equal(typeof context.$('#test').DataTable().destroy, 'function');
  assert.equal(typeof context.Chart, 'function');
  const dialog = new context.bootstrap.Modal(element);
  dialog.show();
  assert.equal(classNames.has('show'), true);
  assert.equal(context.bootstrap.Modal.getInstance(element), dialog);
  dialog.hide();
  assert.equal(classNames.has('show'), false);
  assert.equal(styles[0].id, 'smartRetailOfflineBootstrap');
});

test('parent synchronization combines analytics and ERP without uploading credentials', async () => {
  const pending = [];
  const requests = [];
  const values = new Map([
    ['srerp_customers', JSON.stringify([{ id: 'CUS-1', name: 'Mijoz' }])],
    ['srerp_debts', '[]'],
    ['srerp_auth_users_v6', JSON.stringify([{ username: 'Admin', password: 'do-not-upload' }])]
  ]);
  const storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] || null,
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const response = data => ({ ok: true, status: 200, json: async () => data });
  const context = {
    console, JSON, Map, Set, Object, String, Number,
    localStorage: storage,
    location: { protocol: 'https:', origin: 'https://erp.example.uz' },
    document: { readyState: 'complete', getElementById: () => null },
    cloneState: () => ({ datasets: { sales: [{ sku: 'SKU-001', revenue: 150000 }] }, settings: { theme: 'dark' } }),
    saveState: async () => {},
    setTimeout: callback => { pending.push(callback); return pending.length; },
    clearTimeout() {},
    addEventListener() {},
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === '/api/v1/auth/me') return response({ csrfToken: 'csrf-test', user: { username: 'Admin' } });
      if (path === '/api/v1/state' && options.method === 'PUT') return response({ version: 1 });
      return response({ version: 0, snapshot: {} });
    }
  };
  context.window = context;
  runInContext(file('public/assets/analytics-sync.js'), createContext(context));
  await pending.shift()();
  await pending.shift()();
  const write = requests.find(request => request.options.method === 'PUT');
  assert.ok(write, 'A first-run state synchronization should be sent.');
  const payload = JSON.parse(write.options.body);
  assert.equal(payload.expectedVersion, 0);
  assert.equal(JSON.parse(payload.snapshot.srerp_analytics_parent_state).datasets.sales[0].sku, 'SKU-001');
  assert.equal(JSON.parse(payload.snapshot.srerp_customers)[0].name, 'Mijoz');
  assert.equal('srerp_auth_users_v6' in payload.snapshot, false);
  assert.equal(write.options.headers['X-CSRF-Token'], 'csrf-test');
});
