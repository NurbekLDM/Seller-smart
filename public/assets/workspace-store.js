/* Workspace store — the ERP's data layer, backed by Postgres instead of
   localStorage (see supabase/2026-09-01-workspace-kv.sql).

   THE PROBLEM THIS SOLVES
   The ERP keeps everything in localStorage through db_get()/db_set() plus
   ~77 direct localStorage.setItem calls, and Supabase was bolted on as a
   wrapper that serialised that whole key space into ONE jsonb snapshot.
   On a live shop that snapshot is ~3.7 MB, so adding a single sale cost
   3.7 MB to persist, and two people on one account collided on the
   snapshot's version even when they had touched entirely different
   things — one side's work was then discarded.

   WHY A localStorage SHIM RATHER THAN A REWRITE
   db_get() is synchronous and the ERP's render path is built on that:
   `const rows = db_get('srerp_sales')` returns immediately, everywhere.
   A REST call is asynchronous, so converting the data layer honestly
   would mean rewriting all ~230 call sites and every render function
   that depends on them, inside a 2.3 MB single-file application.

   Instead this module replaces window.localStorage itself with an
   in-memory Storage whose contents come from Postgres and whose writes
   are queued straight back to Postgres, per key. Every existing call site
   keeps its synchronous semantics and keeps working untouched, while
   localStorage stops being where the data lives. Real localStorage is
   still used for what it is actually good for: the Supabase auth token
   and this module's own crash-safety outbox.

   WHAT THIS BUYS
   - a sale is a ~1 KB upsert of one row, not a 3.7 MB snapshot
   - two terminals writing different keys never conflict at all
   - Realtime delivers a changed row immediately instead of polling
   - the analytics blob stops riding along on every unrelated save */
(function smartRetailWorkspaceStore() {
  'use strict';

  if (!/^https?:$/.test(window.location.protocol)) return;

  /* THE switch for the whole Postgres-backed data layer.

     It lives here, in the one file every page loads, because three
     separate things have to agree on it and must never drift apart:
     erp-page.js and supabase-sync.js decide which engine to run, and
     scripts/build.mjs greps this very line to decide whether to mark the
     ERP's inline scripts inert. A build that defers those scripts while
     the runtime declines to execute them produces a blank till. */
  var STORE_ENABLED = true;

  var TABLE = 'workspace_kv';

  /* The outbox is per TAB, not per browser.

     It used to be one shared key. Two tabs each wrote their own dirty map
     into it, so the later writer erased the earlier one's queue — and a
     successful flush in either tab REMOVED the key outright, taking the
     other tab's unsent work with it. Under the snapshot engine that only
     lost a marker, because the data itself still sat in localStorage; here
     the queue is the only copy of an unsent write, so losing it loses the
     work. sessionStorage is per tab, which is exactly the scope needed. */
  var OUTBOX_PREFIX = 'sr-kv-outbox';
  var TAB_ID = (function () {
    try {
      var id = sessionStorage.getItem('sr-kv-tab');
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('sr-kv-tab', id);
      }
      return id;
    } catch (_) { return 'single'; }
  })();
  var OUTBOX_KEY = OUTBOX_PREFIX + '-' + TAB_ID;
  var WRITE_DEBOUNCE_MS = 400;
  var RETRY_BASE_MS = 2000;
  var RETRY_MAX_MS = 30000;

  /* The synced key space, identical to the predicate the snapshot engine
     used. Everything outside it — the sb-* auth token, this module's own
     sr-* bookkeeping, per-device preferences — stays in real localStorage
     and never reaches the database. */
  var DEVICE_PREFERENCE = /^srerp_interface_language_v\d+$/;

  function synced(key) {
    return typeof key === 'string'
      && /^srerp_[a-zA-Z0-9_-]{1,100}$/.test(key)
      && !key.startsWith('srerp_embedded_applied_')
      && !DEVICE_PREFERENCE.test(key)
      && !/password|secret|credential|session|token|pin|auth_users|initialized|seeded/i.test(key);
  }

  /* The real Storage, captured before anything can shadow it. Every access
     below goes through these, never through window.localStorage, which is
     about to stop meaning what it says. */
  var real = window.localStorage;
  var realGet = Storage.prototype.getItem;
  var realSet = Storage.prototype.setItem;
  var realRemove = Storage.prototype.removeItem;
  var realKey = Storage.prototype.key;
  var realLength = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');

  function rawGet(key) { try { return realGet.call(real, key); } catch (_) { return null; } }
  function rawSet(key, value) { try { realSet.call(real, key, value); } catch (_) { /* quota/private mode */ } }
  function rawRemove(key) { try { realRemove.call(real, key); } catch (_) { /* ignore */ } }
  function rawCount() { try { return realLength.get.call(real); } catch (_) { return 0; } }
  function rawKeyAt(index) { try { return realKey.call(real, index); } catch (_) { return null; } }

  var memory = new Map();     // key -> raw string, exactly as the app wrote it
  var dirty = new Map();      // key -> 'set' | 'delete', not yet accepted by the database
  var client = null;
  var workspaceId = null;
  var hydrated = false;
  var online = false;
  var flushing = false;
  var writeTimer = null;
  var retryDelay = RETRY_BASE_MS;
  var subscribers = new Set();
  var channel = null;
  var excluded = [];   // keys this page never needs and must not download

  /* Keys this page DOES need but not at boot. Measured against the live
     workspace, srerp_cells is 1 548 KB of the till's 1 614 KB: fetching it
     up front is 96% of the wait for a screen most cashiers never open.

     A deferred key is not the same as an absent one. Until it arrives the
     store holds no value for it, and if the ERP were allowed to write in
     that state it would persist an empty array over the real rows — the
     first way this shop was destroyed. So a deferred key is registered in
     `seen` the moment the store learns it exists, which makes the guard in
     setItem() refuse exactly those writes until the value is really here. */
  var deferred = [];
  var pendingDeferred = new Set();

  /* Every synced key this session has ever held. The gap between `seen`
     and `memory` is what makes a write dangerous — see the guard in
     setItem(). A key leaves `seen` only when this terminal deletes it on
     purpose. */
  var seen = new Set();

  /* What the database held when this terminal last agreed with it:
     key -> { value: string, revision: number }. A write says which
     revision it was built on, and the merge below needs the value that
     went with it. */
  var base = new Map();

  /* Whether this database has the revisions migration. Flipped off by the
     first flush that finds save_workspace_kv missing. */
  var conditionalWrites = true;

  // Remote DELETEs arriving in a burst: a bulk server-side operation, not
  // the app deleting keys. See the realtime handler.
  var recentDeletes = [];

  /* Resolves the first time the workspace has been fetched. Anything that
     must not run against an empty store waits on this — the platform's ERP
     iframe above all, since it boots the whole ERP the moment its srcdoc
     is assigned. */
  var announceReady;
  var readyPromise = new Promise(function (resolve) { announceReady = resolve; });
  var onRemote = null;   // the page's re-render hook, reused by resync()

  function announce(state, label) {
    subscribers.forEach(function (subscriber) {
      try { subscriber(state, label); } catch (_) { /* a subscriber must not stop persistence */ }
    });
  }

  /* ------------------------------- outbox -------------------------------
     Unsent writes, mirrored to real localStorage so a crash, a closed lid
     or a killed tab cannot lose the shift's last minutes. This is the ONLY
     thing the browser stores on the app's behalf, and it is a queue, not a
     source of truth: hydrate() replays it on top of the server rows and
     deletes it as soon as the database has accepted the writes. */
  function persistOutbox() {
    if (!dirty.size) { rawRemove(OUTBOX_KEY); return; }
    var payload = { w: workspaceId, entries: [] };
    dirty.forEach(function (op, key) {
      payload.entries.push(op === 'delete' ? { k: key, d: 1 } : { k: key, v: memory.get(key) });
    });
    try { rawSet(OUTBOX_KEY, JSON.stringify(payload)); } catch (_) { /* best effort */ }
  }

  /* Collect every tab's leftovers, not just this tab's: a tab that was
     killed with unsent work leaves an outbox nobody else would ever read.
     Whoever hydrates next adopts it and clears the key. */
  function readOutbox() {
    var entries = [];
    var doomed = [];
    for (var index = 0; index < rawCount(); index += 1) {
      var key = rawKeyAt(index);
      if (!key || key.indexOf(OUTBOX_PREFIX) !== 0) continue;
      try {
        var parsed = JSON.parse(rawGet(key) || 'null');
        if (!parsed || !Array.isArray(parsed.entries)) { doomed.push(key); continue; }
        // Left by a different account on this terminal: not ours to send.
        if (String(parsed.w || '') !== String(workspaceId || '')) continue;
        entries = entries.concat(parsed.entries);
        if (key !== OUTBOX_KEY) doomed.push(key); // adopted from a dead tab
      } catch (_) { doomed.push(key); }
    }
    doomed.forEach(function (key) { rawRemove(key); });
    return entries.length ? entries : null;
  }

  /* --------------------------- conflict merge ---------------------------
     Two terminals sent a value for the same key, each built on the same
     older one. The database kept the first; this merges the second onto
     it rather than letting either overwrite the other.

     Everything the ERP stores under a synced key is either an array of
     objects with an `id`, or a plain settings object, so identity is
     available in the cases that matter. Anything else falls back to
     last-writer-wins, which is what the code did everywhere before. */

  function parse(text) {
    try { return { ok: true, value: JSON.parse(text) }; } catch (_) { return { ok: false }; }
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function idOf(item) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.id === 'string' || typeof item.id === 'number') return String(item.id);
    return null;
  }
  function indexById(list) {
    var map = new Map();
    for (var i = 0; i < list.length; i += 1) {
      var id = idOf(list[i]);
      if (id === null) return null;   // no stable identity: not mergeable
      map.set(id, list[i]);
    }
    return map;
  }

  /* One record both sides edited. Field by field: whoever actually moved a
     field wins it, and if BOTH moved the same number, this terminal's
     delta is applied on top of the other's result.

     That last rule is the one that matters for money. Two cashiers each
     sell one unit of a product with 10 in stock: both write 9. Taking
     either value leaves 9 on the shelf when 8 is the truth. Applying the
     delta gives 9 + (9 - 10) = 8. */
  function mergeRecord(baseItem, mine, theirs) {
    if (!isPlainObject(baseItem) || !isPlainObject(mine) || !isPlainObject(theirs)) return mine;
    if (same(mine, baseItem)) return theirs;
    if (same(theirs, baseItem)) return mine;
    var out = {};
    var fields = new Set(Object.keys(baseItem).concat(Object.keys(mine), Object.keys(theirs)));
    fields.forEach(function (field) {
      var was = baseItem[field], ours = mine[field], others = theirs[field];
      if (same(ours, was)) { out[field] = others; return; }
      if (same(others, was)) { out[field] = ours; return; }
      if (typeof was === 'number' && typeof ours === 'number' && typeof others === 'number') {
        out[field] = others + (ours - was);
        return;
      }
      out[field] = ours;
    });
    return out;
  }

  function mergeLists(baseList, mine, theirs) {
    var b = indexById(baseList), m = indexById(mine), t = indexById(theirs);
    if (!b || !m || !t) return null;
    var result = theirs.slice();
    var at = new Map();
    result.forEach(function (item, index) { at.set(idOf(item), index); });

    // Records this terminal removed.
    b.forEach(function (_item, id) {
      if (!m.has(id) && at.has(id)) { result[at.get(id)] = null; }
    });
    // Records this terminal changed.
    m.forEach(function (item, id) {
      if (!b.has(id) || !at.has(id)) return;
      result[at.get(id)] = mergeRecord(b.get(id), item, result[at.get(id)]);
    });
    // Records this terminal added — the common case: a new sale, a receipt.
    m.forEach(function (item, id) {
      if (b.has(id) || at.has(id)) return;
      result.push(item);
    });
    return result.filter(function (item) { return item !== null; });
  }

  function mergeObjects(baseObject, mine, theirs) {
    var out = {};
    var fields = new Set(Object.keys(baseObject).concat(Object.keys(mine), Object.keys(theirs)));
    fields.forEach(function (field) {
      var was = baseObject[field], ours = mine[field], others = theirs[field];
      if (same(ours, was)) { out[field] = others; return; }
      if (same(others, was)) { out[field] = ours; return; }
      out[field] = ours;
    });
    return out;
  }

  function threeWayMerge(baseText, mineText, theirsText) {
    var b = parse(typeof baseText === 'string' ? baseText : 'null');
    var m = parse(mineText);
    var t = parse(theirsText);
    if (!m.ok || !t.ok) return mineText;
    var baseValue = b.ok ? b.value : null;
    if (Array.isArray(m.value) && Array.isArray(t.value)) {
      var merged = mergeLists(Array.isArray(baseValue) ? baseValue : [], m.value, t.value);
      if (merged) return JSON.stringify(merged);
      return mineText;
    }
    if (isPlainObject(m.value) && isPlainObject(t.value)) {
      return JSON.stringify(mergeObjects(isPlainObject(baseValue) ? baseValue : {}, m.value, t.value));
    }
    return mineText;
  }

  /* ------------------------------- writes ------------------------------- */

  function queue(key, op) {
    dirty.set(key, op);
    persistOutbox();
    if (!online) return;
    window.clearTimeout(writeTimer);
    writeTimer = window.setTimeout(flush, WRITE_DEBOUNCE_MS);
  }

  async function flush() {
    if (!online || flushing || !dirty.size) return;
    flushing = true;
    // Snapshot the batch: writes that arrive mid-request must stay queued
    // rather than being marked clean by this round trip.
    var batch = new Map(dirty);
    var upserts = [];
    var deletes = [];
    batch.forEach(function (op, key) {
      if (op === 'delete') deletes.push(key);
      else upserts.push({ workspace_id: workspaceId, key: key, value: memory.get(key) });
    });
    announce('syncing', 'Saqlanmoqda...');
    try {
      if (upserts.length) {
        /* Conditional write: each entry carries the revision its value was
           built on. The server refuses any whose base has moved and hands
           back what is actually stored, so a second terminal's change is
           merged rather than overwritten. */
        var payload = upserts.map(function (row) {
          var known = base.get(row.key);
          return { key: row.key, value: row.value, expected: known ? known.revision : null };
        });
        var written = conditionalWrites
          ? await client.rpc('save_workspace_kv', { entries: payload })
          : { data: null, error: { code: 'PGRST202' } };

        /* The revisions migration has not been applied to this database
           yet. Rather than leave a till unable to save anything, fall back
           to the plain upsert this file used before — last writer wins,
           which is exactly where things stood a moment ago — and stop
           asking for the RPC. The next reload picks it up once the SQL is
           in place. */
        if (written.error && (written.error.code === 'PGRST202'
            || /Could not find the function/i.test(written.error.message || ''))) {
          if (conditionalWrites) {
            conditionalWrites = false;
            console.warn('Workspace store: save_workspace_kv is missing; '
              + 'falling back to unconditional writes until the revisions migration is applied.');
          }
          var plain = await client.from(TABLE).upsert(upserts, { onConflict: 'workspace_id,key' });
          if (plain.error) throw decorate(plain.error);
          upserts.forEach(function (row) {
            if (dirty.get(row.key) === 'set') dirty.delete(row.key);
          });
          written = { data: [], error: null };
        }
        if (written.error) throw decorate(written.error);

        var conflicts = [];
        (written.data || []).forEach(function (result) {
          if (result.conflicted) { conflicts.push(result); return; }
          // Accepted: this is now the agreed state for that key.
          base.set(result.key, { value: memory.get(result.key), revision: result.revision });
          if (dirty.get(result.key) === 'set') dirty.delete(result.key);
        });

        if (conflicts.length) {
          conflicts.forEach(function (result) {
            var known = base.get(result.key);
            var theirs = typeof result.current_value === 'string'
              ? result.current_value : JSON.stringify(result.current_value);
            var mine = memory.get(result.key);
            if (mine === undefined) { dirty.delete(result.key); return; }
            var merged = threeWayMerge(known ? known.value : null, mine, theirs);
            memory.set(result.key, merged);
            seen.add(result.key);
            // Rebase onto what the database actually holds, then retry.
            base.set(result.key, { value: theirs, revision: result.revision });
            dirty.set(result.key, 'set');
          });
          persistOutbox();
          announce('syncing', 'Boshqa kassa bilan birlashtirilmoqda...');
          if (typeof onRemote === 'function') onRemote(null);
          // Retry promptly; a bounded backoff keeps a hot key from spinning.
          window.clearTimeout(writeTimer);
          writeTimer = window.setTimeout(flush, 250);
        }
      }
      if (deletes.length) {
        var removed = await client.from(TABLE).delete()
          .eq('workspace_id', workspaceId).in('key', deletes);
        if (removed.error) throw decorate(removed.error);
        deletes.forEach(function (key) {
          if (dirty.get(key) === 'delete') dirty.delete(key);
          base.delete(key);
        });
      }
      persistOutbox();
      retryDelay = RETRY_BASE_MS;
      announce(dirty.size ? 'syncing' : 'online', dirty.size ? 'Saqlanmoqda...' : 'Saqlandi');
    } catch (error) {
      var message = String(error.message || '');
      if (error.code === '42501' || message.indexOf('forbidden') !== -1) {
        // RLS refused. Retrying cannot help; keep the data queued so it is
        // still recoverable, and say so rather than looping silently.
        online = false;
        announce('error', 'Saqlash uchun ruxsat yo‘q');
      } else {
        announce('error', 'Ulanish uzildi — qayta uriniladi');
        window.setTimeout(flush, retryDelay);
        retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
      }
    } finally {
      flushing = false;
      if (online && dirty.size && !writeTimer) {
        writeTimer = window.setTimeout(flush, WRITE_DEBOUNCE_MS);
      }
    }
  }

  function decorate(error) {
    var wrapped = new Error(error.message || 'workspace_kv write failed');
    wrapped.code = error.code;
    return wrapped;
  }

  /* ------------------------------ hydration ----------------------------- */

  /* `trusted` says whether the result may be believed about ABSENCE.

     A normal boot, or a re-read prompted by one missing key, tells the
     truth: whatever did not come back is genuinely gone, and `seen` is
     rebuilt from it — otherwise a key that really was deleted could never
     be created again on this terminal without a reload.

     A re-read prompted by a burst of DELETEs is different: it may well
     land in the middle of a bulk operation and see a workspace that is
     briefly empty. Believing that would hand the ERP a blank slate to
     write empty arrays over, which is the exact failure this guard
     exists to stop, so `seen` is left alone. */
  async function hydrate(trusted) {
    var rows = [];
    var from = 0;
    var PAGE = 500;
    // PostgREST caps a response; page through so a big workspace (the
    // 6 249-row cell map lives in one of these values) arrives complete.
    for (;;) {
      var query = client.from(TABLE)
        .select('key, value, revision')
        .eq('workspace_id', workspaceId);
      /* Excluded server-side, not filtered after the fact: the whole point
         is not to transfer the bytes. The till excludes the owner's
         analytics state this way — 2.37 MB of the workspace's 3.7 MB that
         no ERP screen ever reads — and defers the cell map, which is
         another 1.5 MB. */
      excluded.forEach(function (key) { query = query.neq('key', key); });
      deferred.forEach(function (key) { query = query.neq('key', key); });
      var page = await query
        .range(from, from + PAGE - 1);
      if (page.error) throw decorate(page.error);
      rows = rows.concat(page.data || []);
      if (!page.data || page.data.length < PAGE) break;
      from += PAGE;
    }

    /* The shim is installed before the ERP's own scripts parse, so it is
       necessarily empty while they run — and the ERP's first-run
       initialisers, finding an empty store, seed their defaults into it.
       Those writes are not the user's work and must never be sent: they
       would overwrite the real workspace with a freshly initialised one.
       Nothing is sent before this point (`online` is still false), so the
       whole pre-hydration queue is simply discarded here.

       Only on the FIRST hydration. A later re-hydration (a reconnect)
       happens with real unsent work in the queue, which must survive. */
    if (!hydrated) dirty.clear();

    /* A re-read fetches everything EXCEPT the deferred keys, so clearing
       outright would drop the cell map on every resync and leave the
       warehouse screens blank until something happened to fetch it again.
       Carry the last known values across; loadDeferred() refreshes them. */
    var carried = new Map();
    deferred.forEach(function (key) {
      if (memory.has(key)) carried.set(key, { value: memory.get(key), was: base.get(key) });
    });

    memory.clear();
    base.clear();
    rows.forEach(function (row) {
      // `value` is a jsonb string holding the app's own serialisation,
      // so it round-trips byte for byte through the database.
      var text = typeof row.value === 'string' ? row.value
        : (row.value === null || row.value === undefined ? null : JSON.stringify(row.value));
      if (text === null) return;
      memory.set(row.key, text);
      base.set(row.key, { value: text, revision: Number(row.revision) || 1 });
    });

    /* Replay anything this terminal wrote but never managed to send. It is
       newer than what the server returned by definition, so it goes on
       top — this is what stops a dropped connection from costing a shift
       its last sales. */
    var queued = readOutbox();
    if (queued) {
      queued.forEach(function (entry) {
        if (entry.d) { memory.delete(entry.k); dirty.set(entry.k, 'delete'); }
        else { memory.set(entry.k, entry.v); dirty.set(entry.k, 'set'); }
      });
    }

    if (trusted === false) {
      memory.forEach(function (_value, key) { seen.add(key); });
    } else {
      seen = new Set(memory.keys());
    }

    carried.forEach(function (entry, key) {
      memory.set(key, entry.value);
      if (entry.was) base.set(key, entry.was);
    });

    /* Find out which deferred keys the workspace actually has — the key
       names only, a few bytes. Registering them in `seen` is what makes
       setItem() refuse to write them while their value is still in
       flight; without this the ERP would read nothing and persist an
       empty array over the real rows. */
    pendingDeferred.clear();
    if (deferred.length) {
      var names = await client.from(TABLE)
        .select('key')
        .eq('workspace_id', workspaceId)
        .in('key', deferred);
      if (!names.error) {
        (names.data || []).forEach(function (row) {
          // Carried over above: the value is present, so it is not pending
          // and the guard must not treat it as a stale view.
          if (memory.has(row.key)) { seen.add(row.key); return; }
          pendingDeferred.add(row.key);
          seen.add(row.key);
        });
      }
    }
    hydrated = true;
    announceReady();
    return memory.size;
  }

  /* Re-read the workspace and put the app back in front of the truth.
     Used by the stale-view guard and by the bulk-delete detector; both mean
     "this terminal's view can no longer be trusted". */
  var resyncing = false;
  function resync(trusted) {
    if (resyncing || !online) return;
    resyncing = true;
    Promise.resolve()
      .then(function () { return hydrate(trusted); })
      .then(function () {
        announce('online', 'Bazadan qayta yuklandi');
        if (typeof onRemote === 'function') onRemote(null);
        // hydrate() skips the deferred keys by design; nothing else would
        // refresh them after a resync.
        return loadDeferred();
      })
      .catch(function (error) {
        console.warn('Workspace store: resync failed:', error.message);
      })
      .finally(function () { resyncing = false; });
  }

  /* Fetch what boot deliberately skipped. Called after the caller has the
     app on screen, so the cost lands on a page the user can already read
     rather than on a spinner. Screens that need these keys show nothing
     until it resolves — and, because of the guard, cannot save over them
     in the meantime. */
  async function loadDeferred() {
    if (!pendingDeferred.size || !online) return 0;
    var wanted = Array.from(pendingDeferred);
    try {
      var result = await client.from(TABLE)
        .select('key, value, revision')
        .eq('workspace_id', workspaceId)
        .in('key', wanted);
      if (result.error) throw decorate(result.error);
      (result.data || []).forEach(function (row) {
        var text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
        // A write that landed while this was in flight is newer than the
        // database row it raced; never overwrite it.
        if (dirty.has(row.key)) { pendingDeferred.delete(row.key); return; }
        memory.set(row.key, text);
        base.set(row.key, { value: text, revision: Number(row.revision) || 1 });
        seen.add(row.key);
        pendingDeferred.delete(row.key);
      });
      if (typeof onRemote === 'function') onRemote(null);
      return result.data ? result.data.length : 0;
    } catch (error) {
      console.warn('Workspace store: deferred keys unavailable:', error.message);
      window.setTimeout(loadDeferred, 4000);
      return 0;
    }
  }

  /* ------------------------------ realtime ------------------------------ */

  function listen(onRemoteChange) {
    if (!client.channel) return; // vendored client without realtime support
    /* Deliberately NOT using a server-side `filter: workspace_id=eq.…`:
       measured against the live database, a filtered subscription reports
       SUBSCRIBED and then silently delivers nothing, while the same
       subscription without the filter delivers immediately. The filter is
       redundant anyway — Supabase applies this table's RLS to
       postgres_changes, so a subscriber only ever receives rows it could
       have selected — and the workspace is re-checked below regardless. */
    channel = client.channel('workspace_kv:' + workspaceId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: TABLE
      }, function (payload) {
        var row = payload.new && payload.new.key ? payload.new : payload.old;
        var key = row && row.key;
        if (!key) return;
        // A key this page deliberately did not download must not arrive
        // through the back door either.
        if (excluded.indexOf(key) !== -1) return;
        // Belt and braces: RLS should already make this impossible.
        if (row.workspace_id && row.workspace_id !== workspaceId) return;
        /* This terminal's own unsent edit is newer than anything the
           database can tell us about that key — never let an echo of an
           older value overwrite work still sitting in the queue. */
        if (dirty.has(key)) return;
        if (payload.eventType === 'DELETE') {
          /* The app never deletes the workspace key by key, so a burst of
             remote DELETEs is a bulk server-side operation — a restore, a
             cutover, maintenance. Applying them one at a time leaves the
             terminal looking at an empty workspace, which is precisely the
             state the ERP turns into empty arrays. Re-read instead. */
          var now = Date.now();
          recentDeletes = recentDeletes.filter(function (t) { return now - t < 2000; });
          recentDeletes.push(now);
          if (recentDeletes.length > 3) {
            recentDeletes = [];
            resync(false);   // may be mid-bulk-operation: do not trust absence
            return;
          }
          if (!memory.has(key)) return;
          memory.delete(key);
          base.delete(key);
        } else {
          var value = payload.new ? payload.new.value : null;
          var next = typeof value === 'string' ? value : JSON.stringify(value);
          // Keep the agreed state current even when the value is unchanged,
          // or the next write would be sent with a stale expected revision
          // and conflict for no reason.
          base.set(key, { value: next, revision: Number(payload.new && payload.new.revision) || 1 });
          if (memory.get(key) === next) return; // our own write coming back
          memory.set(key, next);
          seen.add(key);
        }
        if (typeof onRemoteChange === 'function') onRemoteChange(key);
      })
      .subscribe();
  }

  /* -------------------------- the localStorage shim ---------------------
     A Storage-shaped object whose synced keys live in `memory` (and thus
     in Postgres) and whose everything-else passes straight through to the
     real one. Installed over window.localStorage so the ERP's existing
     synchronous call sites need no changes at all. */
  function buildShim() {
    var shim = {
      getItem: function (key) {
        if (synced(key)) return memory.has(key) ? memory.get(key) : null;
        return rawGet(key);
      },
      setItem: function (key, value) {
        var text = String(value);
        if (!synced(key)) { rawSet(key, text); return; }

        /* The workspace has held this key, and right now the store does
           not. The app is therefore writing from a view we KNOW is stale —
           it read the key, got nothing, and is about to persist whatever it
           made of that, which in practice is an empty array.

           This is how the shop has been destroyed twice: once when the ERP
           booted before hydration, and once when a restore deleted every
           row and the resulting DELETE broadcast blanked the terminals.
           Refuse the write, pull the truth back, and re-render. Losing one
           user action is recoverable; overwriting the workspace with [] is
           not. */
        if (seen.has(key) && !memory.has(key)) {
          console.error('Workspace store: refused a write to ' + key +
            ' — the key is missing locally but known to the workspace. Re-reading.');
          announce('error', 'Ma’lumot yangilanmoqda — o‘zgarishni qayta kiriting');
          resync();
          return;
        }

        if (memory.get(key) === text) return; // no-op write, no round trip
        memory.set(key, text);
        seen.add(key);
        queue(key, 'set');
      },
      removeItem: function (key) {
        if (!synced(key)) { rawRemove(key); return; }
        if (!memory.has(key)) return;
        memory.delete(key);
        // A deliberate local delete: the key is genuinely gone, so a later
        // re-create must not trip the stale-view guard above.
        seen.delete(key);
        queue(key, 'delete');
      },
      clear: function () {
        memory.forEach(function (_value, key) { dirty.set(key, 'delete'); });
        memory.clear();
        persistOutbox();
        if (online) flush();
        // Non-synced keys (auth token included) are the real store's
        // business; clear() there is never what the ERP means.
      },
      key: function (index) {
        var position = Number(index) || 0;
        var keys = Array.from(memory.keys());
        if (position < keys.length) return keys[position];
        var offset = position - keys.length;
        var seen = 0;
        for (var i = 0; i < rawCount(); i += 1) {
          var candidate = rawKeyAt(i);
          if (synced(candidate)) continue; // owned by `memory`, not the real store
          if (seen === offset) return candidate;
          seen += 1;
        }
        return null;
      }
    };
    Object.defineProperty(shim, 'length', {
      get: function () {
        var count = 0;
        for (var i = 0; i < rawCount(); i += 1) {
          if (!synced(rawKeyAt(i))) count += 1;
        }
        return memory.size + count;
      }
    });
    return shim;
  }

  var shim = null;

  function install() {
    if (shim) return shim;
    shim = buildShim();
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { return shim; }
      });
    } catch (error) {
      console.error('Workspace store: localStorage could not be replaced.', error.message);
      shim = null;
    }
    return shim;
  }

  /* --------------------------------- api -------------------------------- */

  window.smartRetailWorkspaceStore = {
    /* Whether the Postgres data layer is live at all. See STORE_ENABLED. */
    enabled: STORE_ENABLED,

    /* Install the shim as early as possible — before the ERP's own scripts
       parse — so no call site ever sees the real store. It starts empty;
       start() fills it. */
    install: install,

    /* The Storage-shaped object itself, for a frame that needs it.

       The platform runs the ERP inside a srcdoc iframe. That iframe is a
       SEPARATE realm: defining window.localStorage in the parent does
       nothing to it, so without this it would read and write the real
       browser store and never touch the database at all. The parent
       prepends a one-line bootstrap to the srcdoc that points the frame's
       window.localStorage at this object — the frame then shares the
       parent's already-hydrated memory and its write queue. */
    shim: function () { return install(); },

    /* Bring the store up: hydrate from Postgres, replay the outbox, then
       subscribe for other terminals' changes. `onRemoteChange` is called
       with a key whenever another terminal changed it, so the caller can
       re-render. */
    start: async function (supabaseClient, workspace, onRemoteChange, options) {
      client = supabaseClient;
      workspaceId = workspace;
      excluded = (options && Array.isArray(options.exclude)) ? options.exclude.slice() : [];
      deferred = (options && Array.isArray(options.defer)) ? options.defer.slice() : [];
      onRemote = onRemoteChange;
      install();
      announce('syncing', 'Bazadan yuklanmoqda...');
      var count = await hydrate();
      online = true;
      listen(onRemoteChange);
      if (dirty.size) flush();
      announce('online', 'Bazaga ulangan');
      return count;
    },

    flush: flush,
    hydrate: hydrate,
    /* Fetch the keys start() was told to defer. The caller decides when —
       after the app is on screen, not before. */
    loadDeferred: loadDeferred,
    /* True while a deferred key is still on its way, so a screen that
       needs it can wait rather than render an empty one. */
    isPending: function (key) { return pendingDeferred.has(key); },

    /* Exposed so the merge can be exercised directly — it decides what
       happens to a sale when two tills write the same key at the same
       moment, which is not something to verify by trying it on a shop.
       See scripts/test-merge.mjs. Pure: no state, no I/O. */
    threeWayMerge: threeWayMerge,
    /* Resolves once the workspace has been fetched at least once. */
    ready: function () { return readyPromise; },
    synced: synced,
    subscribe: function (callback) {
      if (typeof callback !== 'function') return function () {};
      subscribers.add(callback);
      return function () { subscribers.delete(callback); };
    },
    status: function () {
      return {
        online: online,
        hydrated: hydrated,
        keys: memory.size,
        unsent: dirty.size,
        flushing: flushing
      };
    },
    /* Stop writing for good — logout calls this before it clears the
       terminal, so a wipe is never mistaken for the user deleting their
       workspace and pushed to the database. */
    suspend: function () {
      online = false;
      window.clearTimeout(writeTimer);
      writeTimer = null;
      try { if (channel) client.removeChannel(channel); } catch (_) { /* ignore */ }
      channel = null;
    },
    /* Everything the database has accepted is safe to forget locally. */
    clearOutbox: function () { dirty.clear(); rawRemove(OUTBOX_KEY); },

    /* Drop this workspace from this DEVICE without touching the database.

       This distinction did not exist while the data lived in the browser:
       "clear the terminal" and "delete the data" were the same operation,
       so logout and the account-switch guard simply removed the keys. With
       the shim in place those same calls would go through removeItem and
       queue a delete of every key — a cashier logging out would wipe the
       shop. Anything that means "this terminal should stop holding the
       previous session's data" must call this instead. */
    forget: function () {
      online = false;
      window.clearTimeout(writeTimer);
      writeTimer = null;
      dirty.clear();
      memory.clear();
      seen.clear();
      base.clear();
      pendingDeferred.clear();
      hydrated = false;
      rawRemove(OUTBOX_KEY);
      try { if (channel) client.removeChannel(channel); } catch (_) { /* ignore */ }
      channel = null;
    },

    /* The genuine browser store, reachable after the shim has taken over
       window.localStorage. Callers that must operate on the DEVICE rather
       than the workspace — the account-switch wipe, the foreign-project
       fence — go through this so they cannot reach the database. */
    raw: {
      getItem: rawGet,
      setItem: rawSet,
      removeItem: rawRemove,
      key: rawKeyAt,
      count: rawCount
    }
  };
})();
