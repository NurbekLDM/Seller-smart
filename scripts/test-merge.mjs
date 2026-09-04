/* Tests for the workspace store's conflict merge.

   This is the code that decides what happens when two tills write the same
   key in the same moment — a sale each, or two sales of the same product.
   Getting it wrong loses money quietly, and it is not something to verify
   by trying it on a live shop, so it is exercised here instead.

   Run: node scripts/test-merge.mjs   (also part of `npm run check`) */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/* The store is a browser IIFE that captures Storage and localStorage as it
   loads. Give it just enough of a browser to reach the point where it
   publishes its API; nothing below touches storage or the network. */
function loadStore() {
  const store = new Map();
  class Storage {
    getItem(key) { return store.has(key) ? store.get(key) : null; }
    setItem(key, value) { store.set(key, String(value)); }
    removeItem(key) { store.delete(key); }
    key(index) { return [...store.keys()][index] ?? null; }
    get length() { return store.size; }
  }
  const localStorage = new Storage();
  const win = {
    location: { protocol: 'https:', search: '' },
    localStorage,
    Storage,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  win.window = win;

  const source = readFileSync(resolve(root, 'public/assets/workspace-store.js'), 'utf8');
  const context = {
    window: win, Storage, localStorage, sessionStorage: new Storage(),
    document: { addEventListener() {}, getElementById: () => null },
    console, Promise, Map, Set, Blob: class {}, JSON, Math, Date, Number, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  const names = Object.keys(context);
  // eslint-disable-next-line no-new-func
  new Function(...names, source)(...names.map((n) => context[n]));
  if (!win.smartRetailWorkspaceStore) throw new Error('store did not publish its API');
  return win.smartRetailWorkspaceStore;
}

const { threeWayMerge, listDiff } = loadStore();
let failures = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { console.log('  ok   ' + name); return; }
  failures += 1;
  console.log('  FAIL ' + name + '\n       expected ' + b + '\n       actual   ' + a);
}

const json = (v) => JSON.stringify(v);

console.log('workspace store — conflict merge');

/* The case that started all of this: two cashiers ring up a sale in the
   same second. Before revisions, the second write replaced the first and
   one sale vanished. */
{
  const base = json([{ id: 'S1', total: 100 }]);
  const mine = json([{ id: 'S1', total: 100 }, { id: 'A', total: 480 }]);
  const theirs = json([{ id: 'S1', total: 100 }, { id: 'B', total: 700 }]);
  check('two tills each append a sale — both survive',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'S1', total: 100 }, { id: 'B', total: 700 }, { id: 'A', total: 480 }]);
}

/* Both sold the SAME product, so both wrote qty 9 over a stock of 10.
   Taking either value leaves a unit on the shelf that is not there. */
{
  const base = json([{ id: 'P1', sku: '011840', qty: 10 }]);
  const mine = json([{ id: 'P1', sku: '011840', qty: 9 }]);
  const theirs = json([{ id: 'P1', sku: '011840', qty: 9 }]);
  check('two tills each sell one unit — both decrements applied',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'P1', sku: '011840', qty: 8 }]);
}

{
  const base = json([{ id: 'P1', qty: 10 }]);
  const mine = json([{ id: 'P1', qty: 7 }]);      // sold 3
  const theirs = json([{ id: 'P1', qty: 8 }]);    // sold 2
  check('unequal quantities — deltas add up',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'P1', qty: 5 }]);
}

{
  const base = json([{ id: 'P1', qty: 10, name: 'eski' }]);
  const mine = json([{ id: 'P1', qty: 10, name: 'yangi nom' }]);
  const theirs = json([{ id: 'P1', qty: 9, name: 'eski' }]);
  check('one renames while the other sells — both changes kept',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'P1', qty: 9, name: 'yangi nom' }]);
}

{
  const base = json([{ id: 'A' }, { id: 'B' }]);
  const mine = json([{ id: 'B' }]);                    // I deleted A
  const theirs = json([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);  // they added C
  check('a delete here and an add there — both respected',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'B' }, { id: 'C' }]);
}

{
  const base = json([{ id: 'A', v: 1 }]);
  const mine = json([{ id: 'A', v: 1 }]);
  const theirs = json([{ id: 'A', v: 2 }]);
  check('this terminal changed nothing — the other side stands',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    [{ id: 'A', v: 2 }]);
}

{
  const base = json({ taxRate: 12, currency: 'UZS' });
  const mine = json({ taxRate: 15, currency: 'UZS' });
  const theirs = json({ taxRate: 12, currency: 'USD' });
  check('settings object — each side keeps the field it changed',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    { taxRate: 15, currency: 'USD' });
}

/* Without an id there is no way to tell an edit from a delete-plus-insert,
   so the merge must decline rather than invent a result. */
{
  const base = json(['a', 'b']);
  const mine = json(['a', 'b', 'c']);
  const theirs = json(['a', 'b', 'd']);
  check('array without ids — declines to merge, keeps this write',
    JSON.parse(threeWayMerge(base, mine, theirs)),
    ['a', 'b', 'c']);
}

{
  check('non-JSON value — last writer wins',
    threeWayMerge('not json', 'mine', 'theirs'), 'mine');
}

{
  const mine = json([{ id: 'A' }]);
  const theirs = json([{ id: 'B' }]);
  check('no common base — this terminal adds onto the other side',
    JSON.parse(threeWayMerge(null, mine, theirs)),
    [{ id: 'B' }, { id: 'A' }]);
}


/* What a large list write actually sends. Getting this wrong does not
   corrupt one field — it drops warehouse cells. */
console.log('\nworkspace store — list diff');

{
  const base = json([{ id: 'A', qty: 1 }, { id: 'B', qty: 2 }]);
  const next = json([{ id: 'A', qty: 1 }, { id: 'B', qty: 9 }]);
  check('one element edited — only that element is sent',
    listDiff(base, next), { changed: [{ id: 'B', qty: 9 }], removed: [] });
}

{
  const base = json([{ id: 'A' }]);
  const next = json([{ id: 'A' }, { id: 'B' }]);
  check('one element added', listDiff(base, next), { changed: [{ id: 'B' }], removed: [] });
}

{
  const base = json([{ id: 'A' }, { id: 'B' }]);
  const next = json([{ id: 'A' }]);
  check('one element removed', listDiff(base, next), { changed: [], removed: ['B'] });
}

{
  const base = json([{ id: 'A', v: 1 }, { id: 'B' }, { id: 'C' }]);
  const next = json([{ id: 'A', v: 2 }, { id: 'C' }, { id: 'D' }]);
  check('mixed edit, remove and add',
    listDiff(base, next), { changed: [{ id: 'A', v: 2 }, { id: 'D' }], removed: ['B'] });
}

{
  const unchanged = json([{ id: 'A', v: 1 }]);
  check('nothing changed — nothing sent', listDiff(unchanged, unchanged), { changed: [], removed: [] });
}

/* Without a stable id there is no way to say which element moved, so the
   caller must fall back to sending the whole value. */
{
  check('elements without ids — refuses to diff', listDiff(json(['a']), json(['a', 'b'])), null);
}
{
  check('not a list — refuses to diff', listDiff(json({ a: 1 }), json({ a: 2 })), null);
}
{
  check('unparsable — refuses to diff', listDiff('not json', json([{ id: 'A' }])), null);
}

/* What a flush actually sends, against a fake database that implements
   save_workspace_kv's contract (accept when `expected` matches, otherwise
   conflict and hand back the current value).

   Measured on a live shop: a batch holding one small key and one large
   key sent the small key TWICE — the second time appended to the
   already-sent payload with a revision the first write had just moved
   past — so it conflicted against its own value and the merge's delta
   rule applied the edit again. A stock edit of −278 ran 41 rounds and
   left −11 198 units on the shelf. The rounds below must show one write
   per key, no conflicts, and the value the app wrote. */
console.log('\nworkspace store — flush against a fake database');

function fakeDatabase(initial) {
  const rows = new Map(Object.entries(initial).map(([k, v]) => [k, { value: v, revision: 1 }]));
  const log = [];
  let failNext = false;
  const builder = (result) => {
    const b = {};
    ['select', 'eq', 'neq', 'in'].forEach((m) => { b[m] = () => b; });
    b.range = async () => result;
    return b;
  };
  const client = {
    from: () => builder({ data: [...rows].map(([key, r]) => ({ key, value: r.value, revision: r.revision })), error: null }),
    rpc: async (name, args) => {
      if (name !== 'save_workspace_kv') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      const data = args.entries.map((entry) => {
        const row = rows.get(entry.key);
        log.push({ key: entry.key, expected: entry.expected, revision: row ? row.revision : null });
        if (!row) { rows.set(entry.key, { value: entry.value, revision: 1 }); return { key: entry.key, revision: 1, conflicted: false, current_value: null }; }
        if (entry.expected === row.revision) { row.value = entry.value; row.revision += 1; return { key: entry.key, revision: row.revision, conflicted: false, current_value: null }; }
        return { key: entry.key, revision: row.revision, conflicted: true, current_value: row.value };
      });
      if (failNext) { failNext = false; throw new Error('Failed to fetch'); }
      return { data, error: null };
    }
  };
  return { client, rows, log, loseNextAcknowledgement() { failNext = true; } };
}

const settle = (store, ms) => new Promise((resolve) => {
  const started = Date.now();
  (function tick() {
    const s = store.status();
    if ((s.unsent === 0 && !s.flushing) || Date.now() - started > ms) resolve(s);
    else setTimeout(tick, 25);
  })();
});

{
  const store = loadStore();
  const shim = store.shim();
  // A list large enough to take the delta path (>= 64 KB), like srerp_cells.
  const cells = Array.from({ length: 4000 }, (_, i) => ({ id: 'C-' + String(i).padStart(5, '0'), code: 'E5-R05-Y' + i, usedQty: 0 }));
  const db = fakeDatabase({
    srerp_products: json([{ id: 'P', sku: 'SPOR-00001', qty: 478 }]),
    srerp_cells: json(cells)
  });
  await store.start(db.client, 'ws-test', null, {});

  // The mobile warehouse screen: set the product to 200 and re-sync its cell.
  shim.setItem('srerp_products', json([{ id: 'P', sku: 'SPOR-00001', qty: 200 }]));
  cells[48].usedQty = 200;
  shim.setItem('srerp_cells', json(cells));
  const first = await settle(store, 5000);

  const productWrites = db.log.filter((e) => e.key === 'srerp_products');
  check('small key beside a large one — sent once, not twice', productWrites.length, 1);
  check('no write conflicted against its own value',
    db.log.filter((e) => e.expected !== e.revision).length, 0);
  check('the edit is applied once: 478 → 200, not 200 + (200 − 478)',
    JSON.parse(db.rows.get('srerp_products').value)[0].qty, 200);
  check('the large key arrived too', JSON.parse(db.rows.get('srerp_cells').value)[48].usedQty, 200);
  check('queue drained', first.unsent, 0);

  /* The write lands, the acknowledgement does not (a dropped response).
     The retry finds the database already holding exactly what it sent —
     an acceptance, not a conflict, and nothing to apply again. */
  db.loseNextAcknowledgement();
  shim.setItem('srerp_products', json([{ id: 'P', sku: 'SPOR-00001', qty: 150 }]));
  const second = await settle(store, 6000);
  check('lost acknowledgement — value stands at 150, not 150 + (150 − 200)',
    JSON.parse(db.rows.get('srerp_products').value)[0].qty, 150);
  check('queue drained after the retry', second.unsent, 0);
  store.forget();
}

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
