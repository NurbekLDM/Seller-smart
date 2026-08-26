PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'POS', 'WMS', 'VIEWER')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_state (
  tenant_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Jismoniy shaxs',
  phone TEXT NOT NULL DEFAULT '',
  phone_normalized TEXT NOT NULL DEFAULT '',
  phone2 TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  credit_limit REAL NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_days INTEGER NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 1 AND 365),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  segment TEXT NOT NULL DEFAULT 'Yangi',
  telegram TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  birthday TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  bonus_points INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers(tenant_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_unique
  ON customers(tenant_id, phone_normalized)
  WHERE phone_normalized <> '';

CREATE TABLE IF NOT EXISTS debts (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  invoice_no TEXT NOT NULL,
  total REAL NOT NULL CHECK (total >= 0),
  paid REAL NOT NULL DEFAULT 0 CHECK (paid >= 0),
  remaining REAL NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'UZS',
  created_by TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CHECK (paid <= total),
  CHECK (remaining <= total)
);
CREATE INDEX IF NOT EXISTS debts_customer_idx ON debts(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS debts_due_idx ON debts(tenant_id, due_date, remaining);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  debt_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  payment_date TEXT NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'payment',
  actor TEXT NOT NULL,
  reversed_at TEXT,
  reversed_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, debt_id) REFERENCES debts(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payments_debt_idx ON payments(tenant_id, debt_id);
CREATE INDEX IF NOT EXISTS payments_date_idx ON payments(tenant_id, payment_date);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant_time_idx ON audit_events(tenant_id, created_at DESC);
