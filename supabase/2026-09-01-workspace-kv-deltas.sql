-- Migration 2026-09-01 (f) — element-level writes for large list keys.
--
-- The ERP stores each list as one value: srerp_cells is a single 1.27 MB
-- JSON array of 6 249 warehouse cells. It has no concept of writing one
-- cell, so moving a single item rewrites the whole array — and the store
-- faithfully uploads 1.27 MB for it. A warehouse worker placing fifty
-- items sends about 63 MB.
--
-- Loading it lazily was tried first and reverted: the ERP reads and writes
-- the cell map during boot, so anything not present is written back as an
-- empty array. The transfer at boot is gzipped and costs about 0.6 s
-- anyway. The writes are the real cost.
--
-- So the client sends what changed instead of the whole list, and this
-- applies it. Elements are matched by `id`, edits land in place so display
-- order is preserved, and genuinely new elements are appended — which is
-- how the app adds rows.
--
-- Same optimistic concurrency as save_workspace_kv: a delta whose base has
-- moved is refused with the current value, and the client merges and
-- retries.
--
-- Safe to run on a live database: adds one function. Re-runnable.

/* `entries` is
     [{ "key": text,
        "expected": bigint,
        "changed": [ {...}, ... ],   -- elements to insert or replace, by id
        "removed": [ "id", ... ] }]

   Returns one row per entry, shaped like save_workspace_kv so the client
   can treat both the same way. */
create or replace function public.save_workspace_kv_delta(entries jsonb)
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
  expected bigint;
  changed jsonb;
  removed jsonb;
  existing_rev bigint;
  existing_val jsonb;
  list jsonb;
  changed_by_id jsonb;
  rebuilt jsonb;
  appended jsonb;
  new_rev bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for entry in select * from jsonb_array_elements(entries) loop
    k := entry ->> 'key';
    expected := nullif(entry ->> 'expected', '')::bigint;
    changed := coalesce(entry -> 'changed', '[]'::jsonb);
    removed := coalesce(entry -> 'removed', '[]'::jsonb);

    if k is null or k !~ '^srerp_[a-zA-Z0-9_-]{1,100}$' then
      continue;
    end if;
    if k = 'srerp_analytics_parent_state' and not owner then
      continue;   -- same guard as the RLS write policies
    end if;

    select w.revision, w.value into existing_rev, existing_val
      from public.workspace_kv w
     where w.workspace_id = uid and w.key = k;

    /* A delta only means anything against a known base. No row, or a base
       that has moved, is a conflict — the client re-reads and merges. */
    if existing_rev is null or expected is null or existing_rev <> expected then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val;
      return next;
      continue;
    end if;

    /* The stored value is the app's own JSON text, so it has to be parsed
       out of the string before it can be treated as a list. Anything that
       is not a list of objects is refused rather than guessed at. */
    begin
      list := (existing_val #>> '{}')::jsonb;
    exception when others then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val;
      return next;
      continue;
    end;

    if jsonb_typeof(list) <> 'array' then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val;
      return next;
      continue;
    end if;

    -- id -> element, for the replacements
    select coalesce(jsonb_object_agg(e ->> 'id', e), '{}'::jsonb)
      into changed_by_id
      from jsonb_array_elements(changed) e
     where e ? 'id';

    -- Existing elements: dropped if removed, replaced in place if changed.
    select coalesce(jsonb_agg(item order by ord), '[]'::jsonb)
      into rebuilt
      from (
        select case when changed_by_id ? (elem ->> 'id')
                    then changed_by_id -> (elem ->> 'id')
                    else elem end as item,
               ord
          from jsonb_array_elements(list) with ordinality as t(elem, ord)
         where not (removed @> to_jsonb(elem ->> 'id'))
      ) kept;

    -- Elements the list did not have yet, in the order they were sent.
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
      into appended
      from jsonb_array_elements(changed) with ordinality as t(e, ord)
     where e ? 'id'
       and not exists (
         select 1 from jsonb_array_elements(list) old
          where old ->> 'id' = e ->> 'id'
       );

    update public.workspace_kv w
       set value = to_jsonb((rebuilt || appended)::text)
     where w.workspace_id = uid and w.key = k and w.revision = expected
    returning w.revision into new_rev;

    if new_rev is null then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val;
    else
      key := k; revision := new_rev; conflicted := false; current_value := null;
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.save_workspace_kv_delta(jsonb) from public, anon;
grant execute on function public.save_workspace_kv_delta(jsonb) to authenticated;
