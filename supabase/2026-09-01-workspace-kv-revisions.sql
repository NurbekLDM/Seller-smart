-- Migration 2026-09-01 (d) — per-key revisions and conflict-aware writes.
--
-- Splitting the workspace into one row per key stopped two cashiers
-- colliding when they touched DIFFERENT things. It did nothing for two
-- cashiers touching the SAME thing, and every sale touches the same few
-- keys: srerp_sales, srerp_receipts_v13, srerp_products, srerp_cells.
--
-- Measured on 2026-09-01 against the live workspace: two terminals each
-- appending a sale at the same instant produced ONE row in the database.
-- The second write carried the whole array as that terminal had it —
-- without the first terminal's sale — and simply replaced it. The loss is
-- silent, and the window is roughly the Realtime round trip (~1.5 s) plus
-- the write debounce.
--
-- A blind upsert cannot fix that, because the client is sending a whole
-- array and the server has no way to tell an intentional removal from a
-- stale copy. So writes become conditional: the client says which revision
-- it based its value on, and a write whose base has moved is REFUSED and
-- handed the current value instead. The client then merges its own change
-- onto that value and retries — see threeWayMerge() in
-- assets/workspace-store.js.
--
-- Safe to run on a live database: adds one column with a default (no table
-- rewrite on PG 11+), redefines one trigger function, adds one function.
-- The existing plain upsert path keeps working throughout, so the SQL can
-- be applied before the client that uses it. Re-runnable.

alter table public.workspace_kv
  add column if not exists revision bigint not null default 1;

-- The trigger already stamped updated_at/updated_by; it now also owns the
-- revision, so a client cannot set or skip it.
create or replace function public.workspace_kv_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
  else
    new.revision := 1;
  end if;
  return new;
end;
$$;

/* Conditional batch write.

   `entries` is [{ "key": text, "value": jsonb, "expected": bigint|null }].
   `expected` is the revision the client's value was built on; null means
   "I believe this key does not exist yet".

   Returns one row per entry. `conflicted` = true means the write was NOT
   applied and `current_value` / `revision` describe what is actually
   stored, so the caller can merge and retry. Conflicts are a normal
   outcome here, not an error: raising would abort the whole batch and lose
   the writes that were fine. */
create or replace function public.save_workspace_kv(entries jsonb)
returns table (key text, revision bigint, conflicted boolean, current_value jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  owner boolean := public.is_workspace_owner();
  entry jsonb;
  k text;
  v jsonb;
  expected bigint;
  existing_rev bigint;
  existing_val jsonb;
  new_rev bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for entry in select * from jsonb_array_elements(entries) loop
    k := entry ->> 'key';
    v := entry -> 'value';
    expected := nullif(entry ->> 'expected', '')::bigint;

    if k is null or k !~ '^srerp_[a-zA-Z0-9_-]{1,100}$' then
      continue;  -- not part of the synced key space; ignore rather than fail
    end if;

    /* Same guard the RLS write policies apply: ERP staff share their
       owner's workspace and must not reach the analytics state, which no
       ERP screen edits. Skipped silently so a till is never blocked. */
    if k = 'srerp_analytics_parent_state' and not owner then
      continue;
    end if;

    select w.revision, w.value into existing_rev, existing_val
      from public.workspace_kv w
     where w.workspace_id = uid and w.key = k;

    if existing_rev is null then
      if expected is not null then
        -- The client expected a row that is gone: let it decide.
        key := k; revision := null; conflicted := true; current_value := null;
        return next;
        continue;
      end if;
      insert into public.workspace_kv (workspace_id, key, value)
      values (uid, k, v)
      returning workspace_kv.revision into new_rev;
      key := k; revision := new_rev; conflicted := false; current_value := null;
      return next;

    elsif expected is not null and existing_rev = expected then
      update public.workspace_kv w
         set value = v
       where w.workspace_id = uid and w.key = k and w.revision = expected
      returning w.revision into new_rev;
      key := k; revision := new_rev; conflicted := false; current_value := null;
      return next;

    else
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.save_workspace_kv(jsonb) from public, anon;
grant execute on function public.save_workspace_kv(jsonb) to authenticated;
