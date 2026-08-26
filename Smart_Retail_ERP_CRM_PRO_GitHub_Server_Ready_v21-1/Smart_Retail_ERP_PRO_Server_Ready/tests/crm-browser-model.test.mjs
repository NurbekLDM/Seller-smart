import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function createBrowserModel() {
  const elements = new Map();
  const listeners = new Map();
  const values = new Map();
  const notices = [];
  const audit = [];
  let counter = 0;

  class Element {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.dataset = {};
      this.style = {};
      this._html = '';
      this.textContent = '';
      this.max = '';
      this.title = '';
      this.classNames = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this.classNames.add(name)),
        remove: (...names) => names.forEach(name => this.classNames.delete(name)),
        contains: name => this.classNames.has(name),
        toggle: (name, state) => state ? this.classNames.add(name) : this.classNames.delete(name)
      };
    }

    set innerHTML(markup) {
      this._html = markup;
      registerMarkup(markup);
    }

    get innerHTML() { return this._html; }
    insertAdjacentHTML(_position, markup) { registerMarkup(markup); }
    addEventListener(type, callback) { this[`on_${type}`] = callback; }
    removeEventListener() {}
    querySelector(selector) {
      if (selector === '.v11-customer-toolbar') return obtain('customerToolbar');
      if (selector === 'thead tr') return obtain('customerHeadings');
      if (selector === 'span:last-child') return obtain(`${this.id}-label`);
      return null;
    }
    querySelectorAll() { return []; }
    closest(selector) {
      if (selector === '.card-erp') return obtain(this.id === 'tblDebts' ? 'legacyDebtCard' : 'customerCard');
      if (selector === '.row') return obtain(`${this.id}-row`);
      if (selector === '.col-12') return obtain(`${this.id}-column`);
      return null;
    }
    focus() {}
    select() {}
    click() {}
  }

  function obtain(id) {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  }

  function registerMarkup(markup) {
    for (const match of String(markup || '').matchAll(/\bid=["']([^"']+)["']/g)) obtain(match[1]);
  }

  for (const id of [
    'view-crm', 'view-customers', 'view-finance', 'tblDebts', 'dbtCustomer', 'dbtTotal', 'dbtPaid',
    'v11CustomerRows', 'v11CustomerSearch', 'v11CustTotal', 'v11CustActive', 'v11CustDebt', 'v11CustOverLimit',
    'v11CustomerId', 'v11CustomerName', 'v11CustomerPhone', 'v11CustomerPhone2', 'v11CustomerType',
    'v11CustomerActive', 'v11CustomerLimit', 'v11CustomerAddress', 'v11CustomerTaxId', 'v11CustomerNote',
    'modalV11Customer', 'modalAddDebt', 'v7PosDebtNote', 'posCustomerSelect', 'paymentType',
    'v7PosDebtAmount', 'crmCustCount', 'crmDebtTotal', 'crmWarnCount', 'crmDangerCount'
  ]) obtain(id);
  obtain('view-crm').firstElementChild = obtain('oldCrmOverview');

  const storage = {
    get length() { return values.size; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    key(index) { return [...values.keys()][index] || null; }
  };

  const instances = new Map();
  class Modal {
    constructor(element) { this.element = element; instances.set(element.id, this); }
    show() { this.element.classList.add('show'); }
    hide() { this.element.classList.remove('show'); }
    static getInstance(element) { return instances.get(element.id) || null; }
  }

  const document = {
    title: '',
    body: obtain('body'),
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(event, handler) { listeners.set(event, [...(listeners.get(event) || []), handler]); },
    querySelector(selector) {
      if (selector === '#sidebar .brand .sub') return obtain('brandSubtitle');
      if (selector === '#view-customers .v11-customer-toolbar > .d-flex') return obtain('customerToolbar');
      return null;
    },
    createElement() { return new Element(`dynamic-${++counter}`); }
  };

  const context = {
    console, setTimeout: callback => { callback(); return 1; }, clearTimeout() {}, URL,
    Blob, Date, Math, Number, String, Object, Array, Set, Map, RegExp, JSON,
    localStorage: storage,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    bootstrap: { Modal },
    DB_KEYS: { customers: 'srerp_customers', debts: 'srerp_debts', sales: 'srerp_sales', creditSales: 'srerp_credit_sales_v7' },
    authCurrentUser: { role: 'ADMIN', username: 'Admin', fullName: 'Administrator', active: true },
    activeEmployeeName: 'Administrator',
    v11CustomerQuery: '',
    fmt: number => String(Math.round(Number(number) || 0)),
    uid: prefix => `${prefix}-${++counter}`,
    db_get: key => JSON.parse(storage.getItem(key) || '[]'),
    db_set: (key, value) => storage.setItem(key, JSON.stringify(value)),
    doLog: message => audit.push(message),
    showToast: message => notices.push(message),
    authRequireRole: roles => roles.includes(context.authCurrentUser.role),
    renderCrm() {},
    v11RenderCustomers() {},
    v11OpenCustomerModal(id = '') {
      const customer = context.db_get(context.DB_KEYS.customers).find(row => row.id === id);
      obtain('v11CustomerId').value = id;
      obtain('v11CustomerName').value = customer?.name || '';
      obtain('v11CustomerPhone').value = customer?.phone || '';
      obtain('v11CustomerLimit').value = String(customer?.limit || 0);
      obtain('v11CustomerType').value = customer?.type || 'Jismoniy shaxs';
      obtain('v11CustomerActive').value = String(customer?.active !== false);
      new Modal(obtain('modalV11Customer')).show();
    },
    v11SaveCustomer() {
      const rows = context.db_get(context.DB_KEYS.customers);
      const id = obtain('v11CustomerId').value;
      const name = obtain('v11CustomerName').value.trim();
      if (!name) return;
      const current = rows.find(row => row.id === id);
      const result = {
        id: id || context.uid('CUS'), code: 'CUS-MODEL', name, phone: obtain('v11CustomerPhone').value,
        limit: Number(obtain('v11CustomerLimit').value), active: obtain('v11CustomerActive').value !== 'false',
        type: obtain('v11CustomerType').value || 'Jismoniy shaxs', createdAt: new Date().toISOString()
      };
      if (current) Object.assign(current, result);
      else rows.unshift(result);
      context.db_set(context.DB_KEYS.customers, rows);
      Modal.getInstance(obtain('modalV11Customer'))?.hide();
    },
    v11DeleteCustomer(id) {
      context.db_set(context.DB_KEYS.customers, context.db_get(context.DB_KEYS.customers).filter(row => row.id !== id));
    },
    submitDebt() {},
    payDebt() {},
    posCheckout() {},
    renderAll() { context.renderCrm(); context.v11RenderCustomers(); },
    confirm: () => true,
    prompt: () => null
  };
  context.window = context;
  context.location = { protocol: 'file:', origin: 'null' };

  return { context: createContext(context), elements, listeners, storage, notices, audit, obtain };
}

test('CRM browser model: customer lifecycle, debt schedule and payment ledger', async t => {
  const model = createBrowserModel();
  const code = readFileSync(new URL('../public/assets/crm-pro.js', import.meta.url), 'utf8');
  runInContext(code, model.context, { filename: 'crm-pro.js' });
  for (const handler of model.listeners.get('DOMContentLoaded') || []) handler();

  await t.test('professional CRM interface installs into the legacy ERP', () => {
    assert.ok(model.obtain('crm21Root'));
    assert.ok(model.obtain('crm21PaymentModal'));
    assert.ok(model.obtain('crm21CustomerSegment'));
    assert.equal(model.obtain('legacyDebtCard').style.display, 'none');
    assert.match(model.context.document.title, /Professional CRM/);
  });

  await t.test('new customer keeps professional profile fields', () => {
    model.context.v11OpenCustomerModal();
    model.obtain('v11CustomerName').value = 'Aziza Rasulova';
    model.obtain('v11CustomerPhone').value = '+998 90 555 66 77';
    model.obtain('v11CustomerLimit').value = '1000000';
    model.obtain('v11CustomerActive').value = 'true';
    model.obtain('crm21CustomerSegment').value = 'VIP';
    model.obtain('crm21CustomerTelegram').value = '@aziza';
    model.obtain('crm21CustomerCreditDays').value = '21';
    model.obtain('crm21CustomerEmail').value = 'aziza@example.uz';
    model.context.v11SaveCustomer();
    const customer = model.context.crm21Data().customers[0];
    assert.equal(customer.name, 'Aziza Rasulova');
    assert.equal(customer.segment, 'VIP');
    assert.equal(customer.creditDays, 21);
    assert.equal(customer.telegram, '@aziza');
  });

  await t.test('manual receivable records due date and initial payment', () => {
    const customer = model.context.crm21Data().customers[0];
    model.obtain('dbtCustomer').value = customer.id;
    model.obtain('dbtTotal').value = '800000';
    model.obtain('dbtPaid').value = '100000';
    model.obtain('crm21DebtDueDate').value = '2026-09-15';
    model.obtain('crm21DebtInvoice').value = 'INV-MODEL-001';
    model.obtain('crm21DebtNote').value = 'Mijoz bilan kelishuv';
    model.context.submitDebt();
    const data = model.context.crm21Data();
    assert.equal(data.debts.length, 1);
    assert.equal(data.debts[0].remaining, 700000);
    assert.equal(data.debts[0].dueDate, '2026-09-15');
    assert.equal(data.payments[0].amount, 100000);
    assert.equal(data.payments[0].source, 'initial');
  });

  await t.test('partial payment preserves amount, method and actor', () => {
    const debt = model.context.crm21Data().debts[0];
    model.context.crm21OpenPayment(debt.id);
    model.obtain('crm21PaymentAmount').value = '250000';
    model.obtain('crm21PaymentMethod').value = 'Click';
    model.obtain('crm21PaymentReference').value = 'TX-MODEL-01';
    model.context.crm21SavePayment();
    const data = model.context.crm21Data();
    assert.equal(data.debts[0].remaining, 450000);
    assert.equal(data.payments[0].method, 'Click');
    assert.equal(data.payments[0].actor, 'Administrator');
  });

  await t.test('overpayments are rejected by the browser module', () => {
    const debt = model.context.crm21Data().debts[0];
    model.context.crm21OpenPayment(debt.id);
    model.obtain('crm21PaymentAmount').value = '450001';
    model.context.crm21SavePayment();
    assert.equal(model.context.crm21Data().debts[0].remaining, 450000);
  });

  await t.test('administrators can reverse a normal payment', () => {
    const payment = model.context.crm21Data().payments.find(row => row.source === 'payment');
    model.context.crm21ReversePayment(payment.id);
    const data = model.context.crm21Data();
    assert.equal(data.debts[0].remaining, 700000);
    assert.ok(data.payments.find(row => row.id === payment.id).reversedAt);
  });

  await t.test('customer profile records notes and displays its timeline', () => {
    const customer = model.context.crm21Data().customers[0];
    model.context.crm21OpenProfile(customer.id);
    model.obtain('crm21NewNote').value = 'Juma kuni to‘lashga va’da berdi.';
    model.context.crm21AddNote();
    assert.equal(model.context.crm21Data().notes.length, 1);
    assert.match(model.context.crm21Data().notes[0].text, /Juma kuni/);
    assert.match(model.obtain('crm21ProfileBody').innerHTML, /Aziza Rasulova/);
  });

  await t.test('customer financial history cannot be deleted from the browser', () => {
    const customer = model.context.crm21Data().customers[0];
    model.context.v11DeleteCustomer(customer.id);
    assert.equal(model.context.crm21Data().customers.length, 1);
    assert.ok(model.notices.some(message => /moliyaviy tarix/.test(message)));
  });

  await t.test('cashiers cannot exceed the cumulative credit limit', () => {
    const customer = model.context.crm21Data().customers[0];
    model.context.authCurrentUser = { role: 'POS', username: 'Cashier', fullName: 'Kassir', active: true };
    model.obtain('dbtCustomer').value = customer.id;
    model.obtain('dbtTotal').value = '500000';
    model.obtain('dbtPaid').value = '0';
    model.obtain('crm21DebtDueDate').value = '2026-10-01';
    model.context.submitDebt();
    assert.equal(model.context.crm21Data().debts.length, 1);
    assert.ok(model.notices.some(message => /Administrator ruxsati/.test(message)));
  });

  await t.test('invalid Uzbekistan phone numbers prevent customer creation', () => {
    model.context.authCurrentUser = { role: 'ADMIN', username: 'Admin', fullName: 'Administrator', active: true };
    model.context.v11OpenCustomerModal();
    model.obtain('v11CustomerName').value = 'Invalid number';
    model.obtain('v11CustomerPhone').value = '123';
    model.obtain('crm21CustomerCreditDays').value = '30';
    model.obtain('crm21CustomerEmail').value = '';
    model.context.v11SaveCustomer();
    assert.equal(model.context.crm21Data().customers.length, 1);
  });
});
