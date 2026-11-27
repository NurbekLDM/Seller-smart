/* Tests for ERP 119.3 server storage: the three-way merge in erp119/sync.js
   and the in-memory patch of the vendor HTML in server/erp119.mjs (run
   against the real release file, so a new vendor build that moves the
   anchors fails here, not in production). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { patchErp119Html, patchErp119Inner } from '../server/erp119.mjs';
import { chatCoreSource, loadChatCore, chatUsers, erpEmployeeFor, loginOf } from '../server/chat119.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// sync.js is a browser script; load it the way a CommonJS host would.
const mod = { exports: {} };
new Function('module', readFileSync(root + 'erp119/sync.js', 'utf8'))(mod);
const { merge3 } = mod.exports;

const J = JSON.stringify;
const P = JSON.parse;
const base = J([{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }]);

// Both sides add different records: both kept.
let m = P(merge3(base, J([...P(base), { id: 4 }]), J([...P(base), { id: 5 }])));
assert.deepEqual(m.map((r) => r.id).sort(), [1, 2, 3, 4, 5]);
// Each side edits a different record: both edits kept.
m = P(merge3(base, J([{ id: 1, n: 'A' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }]), J([{ id: 1, n: 'a' }, { id: 2, n: 'B' }, { id: 3, n: 'c' }])));
assert.deepEqual(m, [{ id: 1, n: 'A' }, { id: 2, n: 'B' }, { id: 3, n: 'c' }]);
// Untouched records deleted on either side stay deleted.
m = P(merge3(base, J([{ id: 1, n: 'a' }, { id: 3, n: 'c' }]), J([{ id: 1, n: 'a' }, { id: 2, n: 'b' }])));
assert.deepEqual(m, [{ id: 1, n: 'a' }]);
// Deleted there but edited here: kept.
m = P(merge3(base, J([{ id: 1, n: 'X' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }]), J([{ id: 2, n: 'b' }, { id: 3, n: 'c' }])));
assert.equal(m.find((r) => r.id === 1).n, 'X');
// Same record edited on both sides: this device wins.
m = P(merge3(base, J([{ id: 1, n: 'M' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }]), J([{ id: 1, n: 'T' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }])));
assert.equal(m[0].n, 'M');
// No base (offline edit across a reload): union.
m = P(merge3(null, J([{ id: 1 }, { id: 4 }]), J([{ id: 1 }, { id: 5 }])));
assert.deepEqual(m.map((r) => r.id).sort(), [1, 4, 5]);
// Not a record list: this device wins; one-sided changes pass through.
assert.equal(merge3('{"a":1}', '{"a":2}', '{"a":3}'), '{"a":2}');
assert.equal(merge3('x', 'x', 'y'), 'y');
assert.equal(merge3('x', 'z', 'x'), 'z');
assert.equal(merge3('x', null, 'y'), 'y');
assert.equal(merge3('x', 'm', null), 'm');
assert.equal(merge3('[1]', '[1,2]', '[1,3]'), '[1,2]');
assert.equal(merge3(null, J([{ id: 1 }, { id: 1 }]), J([{ id: 2 }])), J([{ id: 1 }, { id: 1 }]));

// Vendor HTML patch.
const vendor = readFileSync(root + 'releases/sellersmart-erp-119.3/SellerSmart_ERP_119_3.html', 'utf8');
const patched = patchErp119Html(vendor, { syncVersion: 't', inner: false });
const loaderAt = patched.lastIndexOf('<script id="portable-loader">');
const head = patched.slice(0, loaderAt);
assert.ok(head.endsWith('<script src="/erp119/sync.js?v=t"></script>\n'), 'adapter injected right before the loader');
assert.ok(head.includes('<script src="/assets/vendor/supabase.js"></script>'));
assert.ok(head.includes('<script src="/assets/app-config.js"></script>'), 'config placeholder present');
assert.ok(patched.slice(loaderAt).includes('await SRWriter101.ready;if(window.SRCloud119)await window.SRCloud119.ready;'), 'loader waits for the adapter');
assert.ok(patched.slice(loaderAt).includes('},180000);'), 'watchdog widened');
assert.equal(patched.length - vendor.length > 0, true);
assert.equal(patched.replace(/<script src="\/assets\/app-config\.js"><\/script>\n<script src="\/assets\/vendor\/supabase\.js"><\/script>\n<script src="\/erp119\/sync\.js\?v=t"><\/script>\n/, '')
  .replace('if(window.SRCloud119)await window.SRCloud119.ready;', '').replace('},180000);', '},30000);'), vendor, 'nothing else changed');
assert.throws(() => patchErp119Html('<html></html>', { inner: false }), /loader script not found/);
assert.throws(() => patchErp119Html('<html></html>'), /payload not found/);

// The ERP itself: identity and employee hooks, each anchor exactly once.
const TAG = '<script type="application/octet-stream" id="portable-payload">';
const unpack = (html) => {
  const at = html.lastIndexOf(TAG) + TAG.length;
  return gunzipSync(Buffer.from(html.slice(at, html.indexOf('</script>', at)).trim(), 'base64')).toString('utf8');
};
const inner = unpack(vendor);
const innerPatched = patchErp119Inner(inner);
assert.equal(innerPatched.split("sr119Hook('erpUserId')").length - 1, 1, 'identity hook');
assert.equal(innerPatched.split("sr119Hook('employeeSaved'").length - 1, 2, 'employee hooks');
assert.equal(innerPatched.split('function sr119Hook(').length - 1, 1);
assert.throws(() => patchErp119Inner(innerPatched), /found 0 times/, 'a patched ERP is not patched twice');
const full = patchErp119Html(vendor, { syncVersion: 't' });
assert.equal(unpack(full), innerPatched, 'served page carries the patched ERP');
assert.ok(unpack(full).startsWith('<!DOCTYPE html>') && unpack(full).includes('id="writer101"'), 'loader integrity check still passes');

// The ERP's chat core, as the chat server runs it.
const C = loadChatCore(chatCoreSource(vendor));
const employees = [
  { id: 'AUTH-ROOT-ADMIN', username: 'admin', fullName: 'Egasi', role: 'ADMIN', active: true },
  { id: 'E1', username: 'Kassir1', fullName: 'Ali', role: 'CUSTOM', active: true, access70: { views: ['pos', 'chat84'], actions: ['chat.send'], scope: { warehouses: ['*'], stores: ['*'] } } },
  { id: 'E2', username: 'old', fullName: 'Vali', role: 'CUSTOM', active: false, access70: { views: ['chat84'], actions: ['chat.send'] } },
  { id: 'E3', username: 'nochat', fullName: 'Gani', role: 'CUSTOM', active: true, access70: { views: ['pos'], actions: [] } }
];
assert.equal(erpEmployeeFor(employees, { owner: true }).id, 'AUTH-ROOT-ADMIN');
assert.equal(erpEmployeeFor(employees, { owner: false, login: 'kassir1' }).id, 'E1', 'login match ignores case');
assert.equal(erpEmployeeFor(employees, { owner: false, login: 'old' }), null, 'blocked employee does not open');
assert.equal(erpEmployeeFor(employees, { owner: false, login: 'admin2' }), null);
assert.equal(loginOf('Kassir1@staff.sellersmart.uz', 'staff.sellersmart.uz'), 'kassir1');
assert.equal(loginOf('a@b.uz', 'staff.sellersmart.uz'), 'a@b.uz');
const users = chatUsers(employees);
const [admin, ali, , gani] = users;
assert.equal(admin.role, 'admin');
assert.deepEqual(ali.permissions, ['chat.send']);
assert.deepEqual(gani.permissions, [], 'no chat view, no chat permission');
const state = C.empty();
const room = C.command(state, admin, users, { type: 'room.create', payload: { kind: 'group', title: 'Ombor', members: ['E1'] }, requestId: 'r1' });
const again = C.command(state, admin, users, { type: 'room.create', payload: { kind: 'group', title: 'Ombor', members: ['E1'] }, requestId: 'r1' });
assert.equal(again.id, room.id, 'same request id: same result (idempotent)');
assert.equal(state.rooms.length, 1);
C.command(state, ali, users, { type: 'message.send', payload: { roomId: room.id, text: 'Salom' }, requestId: 'm1' });
assert.equal(state.messages.length, 1);
assert.throws(() => C.command(state, gani, users, { type: 'message.send', payload: { roomId: room.id, text: 'x' }, requestId: 'm2' }), /ruxsat/i);
assert.equal(C.visible(state, gani).rooms.length, 0, 'a non-member sees no room');

console.log('test-erp119: merge, vendor patch, ERP hooks and chat core OK');
