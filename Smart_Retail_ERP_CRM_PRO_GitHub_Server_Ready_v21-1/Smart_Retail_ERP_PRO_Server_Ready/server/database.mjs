import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const database = new DatabaseSync(config.databasePath);
database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const now = () => new Date().toISOString();
const money = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0;
};
const clean = (value, maximum = 500) => String(value ?? '').trim().slice(0, maximum);
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : now().slice(0, 10);
const number = (value, fallback, minimum, maximum) => {
  const result = Number(value);
  return Number.isFinite(result) ? Math.max(minimum, Math.min(maximum, Math.floor(result))) : fallback;
};
const phone = value => clean(value, 40).replace(/\D/g, '');
const clone = value => JSON.parse(JSON.stringify(value));
const tokenHash = value => createHash('sha256').update(value).digest('hex');

function transaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 }).toString('hex');
}

function bootstrapAdministrator() {
  const current = database.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUsername);
  if (current) return;
  const salt = randomBytes(32).toString('hex');
  const timestamp = now();
  database.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`USR-${randomUUID()}`, config.adminUsername, passwordHash(config.adminPassword, salt), salt, 'ADMIN', 1, timestamp, timestamp);
}

bootstrapAdministrator();

export function verifyUser(username, password) {
  const user = database.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(clean(username, 80));
  if (!user) {
    // Keep timing relatively similar for existing and missing usernames.
    passwordHash(String(password || ''), 'missing-user-placeholder-salt');
    return null;
  }
  const expected = Buffer.from(user.password_hash, 'hex');
  const actual = Buffer.from(passwordHash(String(password || ''), user.password_salt), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

export function createSession(user) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + config.sessionHours * 3_600_000).toISOString();
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(createdAt);
  database.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash(token), user.id, csrfToken, createdAt, expiresAt, createdAt);
  return { token, csrfToken, expiresAt };
}

export function findSession(token) {
  if (!token || token.length > 200) return null;
  const result = database.prepare(`
    SELECT sessions.token_hash, sessions.csrf_token, sessions.expires_at,
           users.id, users.username, users.role, users.active
      FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1
  `).get(tokenHash(token), now());
  if (!result) return null;
  database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), result.token_hash);
  return { tokenHash: result.token_hash, csrfToken: result.csrf_token, expiresAt: result.expires_at, user: { id: result.id, username: result.username, role: result.role } };
}

export function destroySession(token) {
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function recordAudit(actor, eventType, entityType, entityId, description, metadata = {}, ipAddress = '') {
  database.prepare('INSERT INTO audit_events (tenant_id, actor, event_type, entity_type, entity_id, description, metadata_json, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(config.tenant, clean(actor, 120), clean(eventType, 80), clean(entityType, 80), clean(entityId, 120), clean(description, 1000), JSON.stringify(metadata || {}), clean(ipAddress, 80), now());
}

function parseArray(snapshot, key, maximum = 100_000) {
  const raw = snapshot[key];
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new HttpError(422, `Snapshot value for ${key} must be a JSON string.`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { throw new HttpError(422, `Snapshot value for ${key} is not valid JSON.`); }
  if (!Array.isArray(parsed)) throw new HttpError(422, `Snapshot value for ${key} must be a JSON array.`);
  if (parsed.length > maximum) throw new HttpError(422, `${key} exceeds the maximum supported record count.`);
  return parsed;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new HttpError(422, 'Snapshot must be a JSON object.');
  const entries = Object.entries(snapshot);
  if (entries.length > 250) throw new HttpError(422, 'Snapshot contains too many keys.');
  for (const [key, value] of entries) {
    if (!/^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new HttpError(422, `Unsupported snapshot key: ${key}`);
    if (/password|secret|credential|session|token|pin|auth_users/i.test(key)) throw new HttpError(422, `Sensitive key cannot be synchronized: ${key}`);
    if (typeof value !== 'string') throw new HttpError(422, `Snapshot value must be a string: ${key}`);
  }
}

function customerPayload(row) {
  if (!row || typeof row !== 'object') throw new HttpError(422, 'Every customer must be an object.');
  const id = clean(row.id, 100);
  const name = clean(row.name, 180);
  if (!id || !name) throw new HttpError(422, 'Customers require both id and name.');
  return {
    id, tenant: config.tenant, code: clean(row.code || id, 100), name,
    type: clean(row.type || 'Jismoniy shaxs', 80), phone: clean(row.phone, 40), phoneNormalized: phone(row.phone),
    phone2: clean(row.phone2, 40), address: clean(row.address, 300), taxId: clean(row.taxId, 40),
    creditLimit: money(row.limit), creditDays: number(row.creditDays, 30, 1, 365), active: row.active === false ? 0 : 1,
    segment: clean(row.segment || 'Yangi', 60), telegram: clean(row.telegram, 80), email: clean(row.email, 160),
    birthday: clean(row.birthday, 10), note: clean(row.note, 1000), bonusPoints: number(row.bonusPoints, 0, 0, 100_000_000),
    metadata: JSON.stringify(row), createdAt: clean(row.createdAt || now(), 40), updatedAt: clean(row.updatedAt || now(), 40)
  };
}

function debtPayload(row, customerMap) {
  if (!row || typeof row !== 'object') throw new HttpError(422, 'Every debt must be an object.');
  const id = clean(row.id, 100);
  const customerId = clean(row.customerId, 100);
  const customer = customerMap.get(customerId);
  if (!id || !customer) throw new HttpError(422, `Debt ${id || '(unknown)'} references a missing customer.`);
  const total = money(row.total);
  const paid = Math.min(total, money(row.paid));
  const cancelled = row.status === 'Bekor qilingan' || Boolean(row.cancelledAt);
  const remaining = cancelled ? 0 : Math.max(0, total - paid);
  const issueDate = date(row.date);
  return {
    id, tenant: config.tenant, customerId, customerName: clean(customer.name, 180),
    invoiceNo: clean(row.invoiceNo || row.id, 100), total, paid, remaining,
    issueDate, dueDate: date(row.dueDate || issueDate), status: clean(row.status || (remaining ? 'Nazorat' : 'Yopilgan'), 60),
    orderId: clean(row.saleOrderId, 100), note: clean(row.note, 1000), currency: clean(row.currency || 'UZS', 8),
    createdBy: clean(row.createdBy, 120), cancelledAt: row.cancelledAt ? clean(row.cancelledAt, 40) : null,
    metadata: JSON.stringify({ ...row, total, paid, remaining, customer: customer.name }),
    createdAt: clean(row.createdAt || now(), 40), updatedAt: clean(row.updatedAt || now(), 40)
  };
}

function paymentPayload(row, debtMap) {
  if (!row || typeof row !== 'object') throw new HttpError(422, 'Every payment must be an object.');
  const id = clean(row.id, 100);
  const debtId = clean(row.debtId, 100);
  const debt = debtMap.get(debtId);
  const paymentAmount = money(row.amount);
  if (!id || !debt || !paymentAmount) throw new HttpError(422, `Payment ${id || '(unknown)'} is missing an amount or references a missing debt.`);
  return {
    id, tenant: config.tenant, debtId, customerId: debt.customerId, customerName: debt.customerName,
    amount: paymentAmount, paymentDate: date(row.date), method: clean(row.method || 'Naqd', 80),
    reference: clean(row.reference, 100), note: clean(row.note, 1000), source: clean(row.source || 'payment', 40),
    actor: clean(row.actor || 'Tizim', 120), reversedAt: row.reversedAt ? clean(row.reversedAt, 40) : null,
    reversedBy: row.reversedBy ? clean(row.reversedBy, 120) : null, createdAt: clean(row.createdAt || now(), 40)
  };
}

const insertCustomer = database.prepare(`
  INSERT INTO customers (id, tenant_id, code, name, type, phone, phone_normalized, phone2, address, tax_id,
    credit_limit, credit_days, active, segment, telegram, email, birthday, note, bonus_points, metadata_json, created_at, updated_at)
  VALUES (@id, @tenant, @code, @name, @type, @phone, @phoneNormalized, @phone2, @address, @taxId,
    @creditLimit, @creditDays, @active, @segment, @telegram, @email, @birthday, @note, @bonusPoints, @metadata, @createdAt, @updatedAt)
`);
const insertDebt = database.prepare(`
  INSERT INTO debts (id, tenant_id, customer_id, customer_name, invoice_no, total, paid, remaining, issue_date,
    due_date, status, order_id, note, currency, created_by, cancelled_at, metadata_json, created_at, updated_at)
  VALUES (@id, @tenant, @customerId, @customerName, @invoiceNo, @total, @paid, @remaining, @issueDate,
    @dueDate, @status, @orderId, @note, @currency, @createdBy, @cancelledAt, @metadata, @createdAt, @updatedAt)
`);
const insertPayment = database.prepare(`
  INSERT INTO payments (id, tenant_id, debt_id, customer_id, customer_name, amount, payment_date, method,
    reference, note, source, actor, reversed_at, reversed_by, created_at)
  VALUES (@id, @tenant, @debtId, @customerId, @customerName, @amount, @paymentDate, @method,
    @reference, @note, @source, @actor, @reversedAt, @reversedBy, @createdAt)
`);

function rebuildNormalizedTables(snapshot) {
  const customerRows = parseArray(snapshot, 'srerp_customers');
  const debtRows = parseArray(snapshot, 'srerp_debts');
  const paymentRows = parseArray(snapshot, 'srerp_debt_payments_v21');
  database.prepare('DELETE FROM payments WHERE tenant_id = ?').run(config.tenant);
  database.prepare('DELETE FROM debts WHERE tenant_id = ?').run(config.tenant);
  database.prepare('DELETE FROM customers WHERE tenant_id = ?').run(config.tenant);

  const customerMap = new Map();
  for (const row of customerRows) {
    const payload = customerPayload(row);
    if (customerMap.has(payload.id)) throw new HttpError(422, `Duplicate customer ID: ${payload.id}`);
    customerMap.set(payload.id, row);
    try { insertCustomer.run(payload); }
    catch (error) {
      if (/customers_phone_unique|customers\.tenant_id, customers\.phone_normalized/.test(String(error.message))) {
        throw new HttpError(409, `Duplicate customer telephone number: ${payload.phone}`);
      }
      throw error;
    }
  }

  const debtMap = new Map();
  for (const row of debtRows) {
    const payload = debtPayload(row, customerMap);
    if (debtMap.has(payload.id)) throw new HttpError(422, `Duplicate debt ID: ${payload.id}`);
    debtMap.set(payload.id, payload);
    insertDebt.run(payload);
  }
  const paymentIds = new Set();
  for (const row of paymentRows) {
    const payload = paymentPayload(row, debtMap);
    if (paymentIds.has(payload.id)) throw new HttpError(422, `Duplicate payment ID: ${payload.id}`);
    paymentIds.add(payload.id);
    insertPayment.run(payload);
  }
  return { customers: customerRows.length, debts: debtRows.length, payments: paymentRows.length };
}

export function readState() {
  const row = database.prepare('SELECT version, snapshot_json, updated_at, updated_by FROM app_state WHERE tenant_id = ?').get(config.tenant);
  return row ? { version: row.version, snapshot: JSON.parse(row.snapshot_json), updatedAt: row.updated_at, updatedBy: row.updated_by }
    : { version: 0, snapshot: {}, updatedAt: null, updatedBy: null };
}

export function saveState(snapshot, expectedVersion, actor, ipAddress = '') {
  validateSnapshot(snapshot);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new HttpError(422, 'expectedVersion must be a non-negative integer.');
  return transaction(() => {
    const current = readState();
    if (current.version !== expectedVersion) {
      throw new HttpError(409, 'Another device updated the data. Reload the server state before saving.', { currentVersion: current.version, updatedAt: current.updatedAt });
    }
    const statistics = rebuildNormalizedTables(snapshot);
    const version = current.version + 1;
    const timestamp = now();
    database.prepare(`
      INSERT INTO app_state (tenant_id, version, snapshot_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(config.tenant, version, JSON.stringify(snapshot), timestamp, actor);
    recordAudit(actor, 'STATE_SYNC', 'state', config.tenant, `State synchronized to revision ${version}.`, statistics, ipAddress);
    return { version, updatedAt: timestamp, statistics };
  });
}

function mutateSnapshot(callback, actor, eventType, description, ipAddress = '') {
  return transaction(() => {
    const current = readState();
    const snapshot = clone(current.snapshot);
    const result = callback(snapshot);
    validateSnapshot(snapshot);
    const statistics = rebuildNormalizedTables(snapshot);
    const version = current.version + 1;
    const timestamp = now();
    database.prepare(`
      INSERT INTO app_state (tenant_id, version, snapshot_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(config.tenant, version, JSON.stringify(snapshot), timestamp, actor);
    recordAudit(actor, eventType, eventType.startsWith('CUSTOMER') ? 'customer' : eventType.startsWith('PAYMENT') ? 'payment' : 'debt', result?.id || '', description, statistics, ipAddress);
    return { ...result, version };
  });
}

function snapshotArray(snapshot, key) {
  return parseArray(snapshot, key);
}

function writeArray(snapshot, key, rows) {
  snapshot[key] = JSON.stringify(rows);
}

export function listCustomers(query = {}) {
  const search = clean(query.search, 150);
  const filters = ['tenant_id = ?'];
  const parameters = [config.tenant];
  if (search) { filters.push('(name LIKE ? OR phone LIKE ? OR code LIKE ?)'); parameters.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (query.active === 'true' || query.active === 'false') { filters.push('active = ?'); parameters.push(query.active === 'true' ? 1 : 0); }
  if (query.segment) { filters.push('segment = ?'); parameters.push(clean(query.segment, 60)); }
  const limit = number(query.limit, 100, 1, 1000);
  const offset = number(query.offset, 0, 0, 1_000_000);
  const rows = database.prepare(`
    SELECT customers.*, COALESCE((SELECT SUM(remaining) FROM debts WHERE debts.tenant_id = customers.tenant_id
      AND debts.customer_id = customers.id AND debts.status <> 'Bekor qilingan'), 0) AS outstanding
      FROM customers WHERE ${filters.join(' AND ')} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?
  `).all(...parameters, limit, offset);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM customers WHERE ${filters.join(' AND ')}`).get(...parameters).count;
  return { total, limit, offset, items: rows.map(row => ({ ...JSON.parse(row.metadata_json), outstanding: row.outstanding })) };
}

export function getCustomer(id) {
  const row = database.prepare(`
    SELECT customers.*, COALESCE((SELECT SUM(remaining) FROM debts WHERE debts.tenant_id = customers.tenant_id
      AND debts.customer_id = customers.id AND debts.status <> 'Bekor qilingan'), 0) AS outstanding
      FROM customers WHERE tenant_id = ? AND id = ?
  `).get(config.tenant, id);
  if (!row) throw new HttpError(404, 'Customer not found.');
  return { ...JSON.parse(row.metadata_json), outstanding: row.outstanding };
}

export function createCustomer(input, actor, ipAddress = '') {
  const timestamp = now();
  const row = {
    ...input, id: clean(input.id, 100) || `CUS-${randomUUID()}`, code: clean(input.code, 100) || `CUS-${Date.now()}`,
    name: clean(input.name, 180), limit: money(input.limit), creditDays: number(input.creditDays, 30, 1, 365),
    active: input.active !== false, segment: clean(input.segment || 'Yangi', 60), createdAt: timestamp, updatedAt: timestamp
  };
  if (!row.name) throw new HttpError(422, 'Customer name is required.');
  return mutateSnapshot(snapshot => {
    const rows = snapshotArray(snapshot, 'srerp_customers');
    if (phone(row.phone) && rows.some(item => phone(item.phone) === phone(row.phone))) throw new HttpError(409, 'A customer with that telephone number already exists.');
    rows.unshift(row);
    writeArray(snapshot, 'srerp_customers', rows);
    return { id: row.id, customer: row };
  }, actor, 'CUSTOMER_CREATE', `Customer created: ${row.name}`, ipAddress);
}

export function updateCustomer(id, input, actor, ipAddress = '') {
  return mutateSnapshot(snapshot => {
    const rows = snapshotArray(snapshot, 'srerp_customers');
    const customer = rows.find(row => row.id === id);
    if (!customer) throw new HttpError(404, 'Customer not found.');
    const next = { ...customer, ...input, id: customer.id, code: customer.code, createdAt: customer.createdAt, updatedAt: now() };
    next.name = clean(next.name, 180);
    next.limit = money(next.limit);
    next.creditDays = number(next.creditDays, 30, 1, 365);
    if (!next.name) throw new HttpError(422, 'Customer name is required.');
    if (phone(next.phone) && rows.some(row => row.id !== id && phone(row.phone) === phone(next.phone))) throw new HttpError(409, 'A customer with that telephone number already exists.');
    Object.assign(customer, next);
    writeArray(snapshot, 'srerp_customers', rows);
    const debtRows = snapshotArray(snapshot, 'srerp_debts');
    debtRows.filter(debt => debt.customerId === id).forEach(debt => { debt.customer = next.name; debt.updatedAt = now(); });
    if (debtRows.length || snapshot.srerp_debts) writeArray(snapshot, 'srerp_debts', debtRows);
    return { id, customer: next };
  }, actor, 'CUSTOMER_UPDATE', `Customer updated: ${id}`, ipAddress);
}

export function deleteCustomer(id, actor, ipAddress = '') {
  return mutateSnapshot(snapshot => {
    const rows = snapshotArray(snapshot, 'srerp_customers');
    const customer = rows.find(row => row.id === id);
    if (!customer) throw new HttpError(404, 'Customer not found.');
    const customerDebts = snapshotArray(snapshot, 'srerp_debts').filter(debt => debt.customerId === id);
    if (customerDebts.length) throw new HttpError(409, 'Customer has financial history and cannot be deleted. Mark the customer inactive instead.');
    writeArray(snapshot, 'srerp_customers', rows.filter(row => row.id !== id));
    return { id, deleted: true };
  }, actor, 'CUSTOMER_DELETE', `Customer deleted: ${id}`, ipAddress);
}

export function listDebts(query = {}) {
  const conditions = ['tenant_id = ?'];
  const parameters = [config.tenant];
  if (query.customerId) { conditions.push('customer_id = ?'); parameters.push(clean(query.customerId, 100)); }
  if (query.search) { conditions.push('(customer_name LIKE ? OR invoice_no LIKE ? OR note LIKE ?)'); parameters.push(`%${clean(query.search, 150)}%`, `%${clean(query.search, 150)}%`, `%${clean(query.search, 150)}%`); }
  if (query.status === 'open') conditions.push("remaining > 0 AND status <> 'Bekor qilingan'");
  if (query.status === 'paid') conditions.push("remaining = 0 AND status <> 'Bekor qilingan'");
  if (query.status === 'overdue') { conditions.push("remaining > 0 AND due_date < ? AND status <> 'Bekor qilingan'"); parameters.push(now().slice(0, 10)); }
  if (query.from) { conditions.push('issue_date >= ?'); parameters.push(date(query.from)); }
  if (query.to) { conditions.push('issue_date <= ?'); parameters.push(date(query.to)); }
  const limit = number(query.limit, 100, 1, 1000);
  const offset = number(query.offset, 0, 0, 1_000_000);
  const where = conditions.join(' AND ');
  const rows = database.prepare(`SELECT * FROM debts WHERE ${where} ORDER BY due_date ASC, created_at DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM debts WHERE ${where}`).get(...parameters).count;
  return { total, limit, offset, items: rows.map(row => JSON.parse(row.metadata_json)) };
}

export function createDebt(input, actor, role, ipAddress = '') {
  const timestamp = now();
  const total = money(input.total);
  const paid = money(input.paid);
  if (!total || paid > total) throw new HttpError(422, 'Debt total must be positive and the initial payment cannot exceed it.');
  const customer = getCustomer(clean(input.customerId, 100));
  if (customer.active === false) throw new HttpError(409, 'Inactive customers cannot receive credit.');
  const remaining = total - paid;
  const exposure = money(customer.outstanding) + remaining;
  if (remaining && (money(customer.limit) === 0 || exposure > money(customer.limit)) && !(role === 'ADMIN' && input.overrideLimit === true)) {
    throw new HttpError(409, 'Customer credit limit would be exceeded. An administrator must explicitly approve the override.', { creditLimit: money(customer.limit), outstanding: money(customer.outstanding), requested: remaining });
  }
  const row = {
    id: `DEBT-${randomUUID()}`, customerId: customer.id, customer: customer.name, total, paid, remaining,
    date: date(input.date), dueDate: date(input.dueDate), invoiceNo: clean(input.invoiceNo, 100) || `INV-${Date.now()}`,
    note: clean(input.note, 1000), status: remaining ? exposure > money(customer.limit) ? 'Muammo' : 'Nazorat' : 'Yopilgan',
    currency: 'UZS', createdBy: actor, createdAt: timestamp, updatedAt: timestamp
  };
  return mutateSnapshot(snapshot => {
    const rows = snapshotArray(snapshot, 'srerp_debts');
    rows.unshift(row);
    writeArray(snapshot, 'srerp_debts', rows);
    if (paid) {
      const entries = snapshotArray(snapshot, 'srerp_debt_payments_v21');
      entries.unshift({ id: `PAY-${randomUUID()}`, debtId: row.id, customerId: customer.id, customer: customer.name, amount: paid, date: row.date, method: 'Boshlang‘ich to‘lov', reference: '', note: '', source: 'initial', actor, createdAt: timestamp, reversedAt: null });
      writeArray(snapshot, 'srerp_debt_payments_v21', entries);
    }
    return { id: row.id, debt: row };
  }, actor, 'DEBT_CREATE', `Debt created for ${customer.name}: ${remaining}`, ipAddress);
}

export function updateDebt(id, input, actor, ipAddress = '') {
  return mutateSnapshot(snapshot => {
    const rows = snapshotArray(snapshot, 'srerp_debts');
    const debt = rows.find(row => row.id === id);
    if (!debt) throw new HttpError(404, 'Debt not found.');
    if (input.dueDate !== undefined) debt.dueDate = date(input.dueDate);
    if (input.invoiceNo !== undefined) debt.invoiceNo = clean(input.invoiceNo, 100) || debt.invoiceNo;
    if (input.note !== undefined) debt.note = clean(input.note, 1000);
    debt.updatedAt = now();
    writeArray(snapshot, 'srerp_debts', rows);
    return { id, debt };
  }, actor, 'DEBT_UPDATE', `Debt updated: ${id}`, ipAddress);
}

export function createPayment(debtId, input, actor, ipAddress = '') {
  const paymentAmount = money(input.amount);
  if (!paymentAmount) throw new HttpError(422, 'Payment amount must be greater than zero.');
  return mutateSnapshot(snapshot => {
    const debtRows = snapshotArray(snapshot, 'srerp_debts');
    const debt = debtRows.find(row => row.id === debtId);
    if (!debt || debt.status === 'Bekor qilingan') throw new HttpError(404, 'Open debt not found.');
    if (paymentAmount > money(debt.remaining)) throw new HttpError(422, 'Payment exceeds the outstanding debt balance.');
    const timestamp = now();
    debt.paid = money(debt.paid) + paymentAmount;
    debt.remaining = Math.max(0, money(debt.total) - money(debt.paid));
    debt.status = debt.remaining ? 'Nazorat' : 'Yopilgan';
    debt.updatedAt = timestamp;
    debt.lastPaymentAt = timestamp;
    writeArray(snapshot, 'srerp_debts', debtRows);
    const payment = { id: `PAY-${randomUUID()}`, debtId, customerId: debt.customerId, customer: debt.customer, amount: paymentAmount, date: date(input.date), method: clean(input.method || 'Naqd', 80), reference: clean(input.reference, 100), note: clean(input.note, 1000), source: 'payment', actor, createdAt: timestamp, reversedAt: null };
    const entries = snapshotArray(snapshot, 'srerp_debt_payments_v21');
    entries.unshift(payment);
    writeArray(snapshot, 'srerp_debt_payments_v21', entries);
    if (snapshot.srerp_credit_sales_v7) {
      const credit = snapshotArray(snapshot, 'srerp_credit_sales_v7');
      const sale = credit.find(row => row.debtId === debtId || row.orderId === debt.saleOrderId);
      if (sale) { Object.assign(sale, { remaining: debt.remaining, status: debt.status, updatedAt: timestamp }); writeArray(snapshot, 'srerp_credit_sales_v7', credit); }
    }
    return { id: payment.id, payment, debt };
  }, actor, 'PAYMENT_CREATE', `Payment recorded against ${debtId}: ${paymentAmount}`, ipAddress);
}

export function listPayments(query = {}) {
  const conditions = ['tenant_id = ?'];
  const parameters = [config.tenant];
  if (query.customerId) { conditions.push('customer_id = ?'); parameters.push(clean(query.customerId, 100)); }
  if (query.debtId) { conditions.push('debt_id = ?'); parameters.push(clean(query.debtId, 100)); }
  if (query.from) { conditions.push('payment_date >= ?'); parameters.push(date(query.from)); }
  if (query.to) { conditions.push('payment_date <= ?'); parameters.push(date(query.to)); }
  const limit = number(query.limit, 100, 1, 1000);
  const offset = number(query.offset, 0, 0, 1_000_000);
  const where = conditions.join(' AND ');
  const rows = database.prepare(`SELECT * FROM payments WHERE ${where} ORDER BY payment_date DESC, created_at DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM payments WHERE ${where}`).get(...parameters).count;
  return { total, limit, offset, items: rows.map(row => ({ id: row.id, debtId: row.debt_id, customerId: row.customer_id, customer: row.customer_name, amount: row.amount, date: row.payment_date, method: row.method, reference: row.reference, note: row.note, source: row.source, actor: row.actor, reversedAt: row.reversed_at, reversedBy: row.reversed_by, createdAt: row.created_at })) };
}

export function dashboard() {
  const currentDate = now().slice(0, 10);
  const month = currentDate.slice(0, 7);
  const stats = database.prepare(`
    SELECT COUNT(*) AS debt_count,
      COALESCE(SUM(CASE WHEN status <> 'Bekor qilingan' THEN remaining ELSE 0 END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN remaining > 0 AND due_date < ? AND status <> 'Bekor qilingan' THEN remaining ELSE 0 END), 0) AS overdue,
      SUM(CASE WHEN remaining > 0 AND due_date < ? AND status <> 'Bekor qilingan' THEN 1 ELSE 0 END) AS overdue_count,
      COALESCE(SUM(CASE WHEN remaining > 0 AND due_date = ? AND status <> 'Bekor qilingan' THEN remaining ELSE 0 END), 0) AS due_today
    FROM debts WHERE tenant_id = ?
  `).get(currentDate, currentDate, currentDate, config.tenant);
  const customerStats = database.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM customers WHERE tenant_id = ?').get(config.tenant);
  const paymentStats = database.prepare("SELECT COALESCE(SUM(CASE WHEN payment_date = ? THEN amount ELSE 0 END), 0) AS today, COALESCE(SUM(CASE WHEN substr(payment_date, 1, 7) = ? THEN amount ELSE 0 END), 0) AS month FROM payments WHERE tenant_id = ? AND reversed_at IS NULL").get(currentDate, month, config.tenant);
  return { customers: { total: customerStats.total, active: customerStats.active || 0 }, debt: { count: stats.debt_count, outstanding: stats.outstanding, overdue: stats.overdue, overdueCount: stats.overdue_count || 0, dueToday: stats.due_today }, collections: { today: paymentStats.today, month: paymentStats.month }, generatedAt: now() };
}

export function listAudit(query = {}) {
  const limit = number(query.limit, 100, 1, 500);
  const rows = database.prepare('SELECT id, actor, event_type, entity_type, entity_id, description, metadata_json, created_at FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(config.tenant, limit);
  return { items: rows.map(row => ({ id: row.id, actor: row.actor, eventType: row.event_type, entityType: row.entity_type, entityId: row.entity_id, description: row.description, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at })) };
}

export function closeDatabase() {
  database.close();
}
