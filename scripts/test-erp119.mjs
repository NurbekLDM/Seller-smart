/* Tests for ERP 119.3 server storage: the three-way merge in erp119/sync.js
   and the in-memory patch of the vendor HTML in server/erp119.mjs (run
   against the real release file, so a new vendor build that moves the
   anchors fails here, not in production). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { patchErp119Html } from '../server/erp119.mjs';

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
const patched = patchErp119Html(vendor, { syncVersion: 't' });
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
assert.throws(() => patchErp119Html('<html></html>'), /loader script not found/);

console.log('test-erp119: merge and vendor patch OK');
