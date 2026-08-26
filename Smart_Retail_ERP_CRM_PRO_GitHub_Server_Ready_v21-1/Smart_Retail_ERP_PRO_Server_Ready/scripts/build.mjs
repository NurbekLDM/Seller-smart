import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const analyticsFile = resolve(root, 'public/index.html');
const erpFile = resolve(root, 'public/erp.html');
const crmStyle = resolve(root, 'public/assets/crm-pro.css');
const crmScript = resolve(root, 'public/assets/crm-pro.js');
const offlineRuntime = resolve(root, 'public/assets/offline-runtime.js');
const serverScript = resolve(root, 'public/assets/server-sync.js');
const analyticsScript = resolve(root, 'public/assets/analytics-sync.js');

for (const file of [analyticsFile, erpFile, crmStyle, crmScript, offlineRuntime, serverScript, analyticsScript]) {
  if (!existsSync(file)) throw new Error(`Required build source is missing: ${file}`);
}

function removeBlock(source, start, finish) {
  const beginning = source.indexOf(start);
  if (beginning < 0) return source;
  const ending = source.indexOf(finish, beginning);
  if (ending < 0) throw new Error(`Build block ${start} is missing its closing marker.`);
  const before = source.slice(0, beginning).replace(/\n+$/, '');
  const after = source.slice(ending + finish.length).replace(/^\n+/, '');
  return `${before}\n${after}`;
}

function insertBeforeFinalBody(source, block) {
  const closingBody = source.toLowerCase().lastIndexOf('</body>');
  if (closingBody < 0) throw new Error('HTML source is missing its final closing body tag.');
  return `${source.slice(0, closingBody).replace(/\n+$/, '')}\n${block.trim()}\n${source.slice(closingBody)}`;
}

let erp = readFileSync(erpFile, 'utf8');
erp = removeBlock(erp, '<!-- SMART_RETAIL_CRM_PRO_21_BEGIN -->', '<!-- SMART_RETAIL_CRM_PRO_21_END -->');
erp = removeBlock(erp, '<!-- SMART_RETAIL_OFFLINE_RUNTIME_21_BEGIN -->', '<!-- SMART_RETAIL_OFFLINE_RUNTIME_21_END -->');
const runtimeAnchor = '<script src="https://cdn.datatables.net/1.13.8/js/dataTables.bootstrap5.min.js"></script>';
if (!erp.includes(runtimeAnchor)) throw new Error('ERP runtime dependency anchor was not found.');
const runtimeBlock = `\n<!-- SMART_RETAIL_OFFLINE_RUNTIME_21_BEGIN -->\n<script id="smartRetailOfflineRuntime">\n${readFileSync(offlineRuntime, 'utf8')}\n</script>\n<!-- SMART_RETAIL_OFFLINE_RUNTIME_21_END -->\n`;
erp = erp.replace(runtimeAnchor, runtimeAnchor + runtimeBlock);
const erpBlock = `\n<!-- SMART_RETAIL_CRM_PRO_21_BEGIN -->\n<style id="crm21Styles">\n${readFileSync(crmStyle, 'utf8')}\n</style>\n<script id="crm21ProfessionalModule">\n${readFileSync(crmScript, 'utf8')}\n</script>\n<script id="crm21ServerSync">\n${readFileSync(serverScript, 'utf8')}\n</script>\n<!-- SMART_RETAIL_CRM_PRO_21_END -->\n`;
erp = insertBeforeFinalBody(erp, erpBlock);
writeFileSync(erpFile, erp);

let analytics = readFileSync(analyticsFile, 'utf8');
analytics = removeBlock(analytics, '<!-- SMART_RETAIL_PARENT_SYNC_21_BEGIN -->', '<!-- SMART_RETAIL_PARENT_SYNC_21_END -->');
const encoded = Buffer.from(erp, 'utf8').toString('base64');
const pattern = /const SMART_RETAIL_ERP_B64 = "[^"]+";/;
if (!pattern.test(analytics)) throw new Error('Embedded Smart Retail ERP payload was not found in the parent application.');
analytics = analytics.replace(pattern, `const SMART_RETAIL_ERP_B64 = "${encoded}";`);
analytics = analytics.replace('<title>Uzum Analytics 2026 — MERGED PRO</title>', '<title>Uzum Analytics + Smart Retail ERP 21 — CRM PRO</title>');
analytics = analytics.replace('<h3>Smart Retail ERP v20.1</h3>', '<h3>Smart Retail ERP v21.0 — CRM PRO</h3>');
analytics = analytics.replace('WMS, POS, CRM, Finance, inventarizatsiya, QR/Barcode va to‘liq Excel/HTML backup.', 'WMS, POS, professional mijozlar bazasi, qarzdorlik, to‘lov tarixi va himoyalangan server sinxronizatsiyasi.');
analytics = analytics.replace('Ma’lumotlar qurilmangizdagi IndexedDB bazasida saqlanadi. Serverga yuborilmaydi.', 'Mustaqil faylda ma’lumotlar qurilmada saqlanadi. Server versiyasida ERP va analitika himoyalangan bazaga sinxronlanadi.');
const parentBlock = `\n<!-- SMART_RETAIL_PARENT_SYNC_21_BEGIN -->\n<script id="smartRetailParentServerSync">\n${readFileSync(analyticsScript, 'utf8')}\n</script>\n<!-- SMART_RETAIL_PARENT_SYNC_21_END -->\n`;
analytics = insertBeforeFinalBody(analytics, parentBlock);
writeFileSync(analyticsFile, analytics);

console.log(JSON.stringify({
  event: 'build_complete',
  version: '21.0.0',
  erpBytes: Buffer.byteLength(erp),
  analyticsBytes: Buffer.byteLength(analytics),
  embeddedErpBytes: encoded.length
}));
