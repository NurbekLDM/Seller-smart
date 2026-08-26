import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.env.NODE_ENV === 'production';
const databasePath = resolve(root, process.env.DATABASE_PATH || './data/smart-retail.sqlite');
const databaseDirectory = resolve(databasePath, '..');
mkdirSync(databaseDirectory, { recursive: true });

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : fallback;
}

const adminUsername = String(process.env.ADMIN_USERNAME || 'Admin').trim();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');

if (!adminUsername || adminUsername.length > 80) {
  throw new Error('ADMIN_USERNAME must contain between 1 and 80 characters.');
}
if (adminPassword.length < 10 || /^(change|replace|your|example)/i.test(adminPassword)) {
  throw new Error('ADMIN_PASSWORD is required and must be at least 10 characters. Set it in .env or the hosting environment.');
}

export const config = Object.freeze({
  root,
  production,
  host: process.env.HOST || '0.0.0.0',
  port: positiveInteger(process.env.PORT, 8080, 65535),
  databasePath,
  tenant: String(process.env.TENANT_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'default',
  appOrigin: String(process.env.APP_ORIGIN || '').replace(/\/$/, ''),
  sessionHours: positiveInteger(process.env.SESSION_HOURS, 12, 168),
  maxBodyBytes: positiveInteger(process.env.MAX_BODY_BYTES, 20 * 1024 * 1024, 80 * 1024 * 1024),
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: process.env.SECURE_COOKIES === '1' || (production && process.env.SECURE_COOKIES !== '0'),
  adminUsername,
  adminPassword,
  publicDirectory: resolve(root, './public')
});
