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
  var OUTBOX_KEY = 'sr-kv-outbox';
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

  /* Resolves the first time the workspace has been fetched. Anything that
     must not run against an empty store waits on this — the platform's ERP
     iframe above all, since it boots the whole ERP the moment its srcdoc
     is assigned. */
  var announceReady;
  var readyPromise = new Promise(function (resolve) { announceReady = resolve; });

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

  function readOutbox() {
    try {
      var parsed = JSON.parse(rawGet(OUTBOX_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.entries)) return null;
      // Written by a different account on this terminal: not ours to send.
      if (String(parsed.w || '') !== String(workspaceId || '')) return null;
      return parsed.entries;
    } catch (_) { return null; }
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
        var written = await client.from(TABLE).upsert(upserts, { onConflict: 'workspace_id,key' });
        if (written.error) throw decorate(written.error);
      }
      if (deletes.length) {
        var removed = await client.from(TABLE).delete()
          .eq('workspace_id', workspaceId).in('key', deletes);
        if (removed.error) throw decorate(removed.error);
      }
      // Only clear what this round trip actually covered.
      batch.forEach(function (op, key) { if (dirty.get(key) === op) dirty.delete(key); });
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

  async function hydrate() {
    var rows = [];
    var from = 0;
    var PAGE = 500;
    // PostgREST caps a response; page through so a big workspace (the
    // 6 249-row cell map lives in one of these values) arrives complete.
    for (;;) {
      var query = client.from(TABLE)
        .select('key, value')
        .eq('workspace_id', workspaceId);
      /* Excluded server-side, not filtered after the fact: the whole point
         is not to transfer the bytes. The till excludes the owner's
         analytics state this way — 2.37 MB of the workspace's 3.7 MB that
         no ERP screen ever reads. */
      excluded.forEach(function (key) { query = query.neq('key', key); });
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

    memory.clear();
    rows.forEach(function (row) {
      // `value` is a jsonb string holding the app's own serialisation,
      // so it round-trips byte for byte through the database.
      if (typeof row.value === 'string') memory.set(row.key, row.value);
      else if (row.value !== null && row.value !== undefined) memory.set(row.key, JSON.stringify(row.value));
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

    hydrated = true;
    announceReady();
    return memory.size;
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
          if (!memory.has(key)) return;
          memory.delete(key);
        } else {
          var value = payload.new ? payload.new.value : null;
          var next = typeof value === 'string' ? value : JSON.stringify(value);
          if (memory.get(key) === next) return; // our own write coming back
          memory.set(key, next);
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
        if (memory.get(key) === text) return; // no-op write, no round trip
        memory.set(key, text);
        queue(key, 'set');
      },
      removeItem: function (key) {
        if (!synced(key)) { rawRemove(key); return; }
        if (!memory.has(key)) return;
        memory.delete(key);
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
