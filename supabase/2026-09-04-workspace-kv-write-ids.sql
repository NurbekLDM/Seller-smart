-- Migration 2026-09-04 — every write carries an id, so a retry can never be
-- merged against itself.
--
-- What happened. A terminal's write landed but the terminal did not learn
-- that it had (the acknowledgement was lost; or, in the store bug fixed the
-- same day, the batch was sent twice). It retried with the revision it had
-- started from, the server reported a conflict and handed back the current
-- value — which was the terminal's OWN write — and the client's merge
-- treated that value as another till's change. The merge rule for a number
-- both sides moved is theirs + (mine − base), which is right for two tills
-- each selling one unit and wrong for one till seeing its own edit twice:
-- a stock of 478 set to 200 became −78, then −356, and after 41 rounds
-- −11 198. The merge cannot tell the two apart from the values alone.
--
-- The server can. Each write now names itself (a random id the client
-- makes per key and per value), the row remembers the id of the write it
-- holds, and:
--
--   * a write whose id the row already holds is ACCEPTED, not conflicted —
--     it is the retry of a write that landed;
--   * a genuine conflict returns the id the row holds, so the client can
--     recognise an earlier write of its own that it never got the
--     acknowledgement for, rebase on it, and resend without merging.
--
-- Backward compatible in both directions: an old client sends no id and
-- gets the old behaviour; a new client against the old function sees no
-- id in the reply and falls back to comparing values byte for byte.
--
-- Safe to run on a live database. Re-runnable. The functions are dropped
-- and recreated because their return type gains a column, which
-- `create or replace` cannot do.

alter table public.workspace_kv
  add column if not exists write_id text;

drop function if exists public.save_workspace_kv(jsonb);

create function public.save_workspace_kv(entries jsonb)
returns table (key text, revision bigint, conflicted boolean, current_value jsonb, current_write_id text)
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
  wid text;
  existing_rev bigint;
  existing_val jsonb;
  existing_wid text;
  new_rev bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for entry in select * from jsonb_array_elements(entries) loop
    k := entry ->> 'key';
    v := entry -> 'value';
    expected := nullif(entry ->> 'expected', '')::bigint;
    wid := nullif(left(entry ->> 'write_id', 64), '');

    if k is null or k !~ '^srerp_[a-zA-Z0-9_-]{1,100}$' then
      continue;  -- not part of the synced key space; ignore rather than fail
    end if;

    /* Same guard the RLS write policies apply: ERP staff share their
       owner's workspace and must not reach the analytics state, which no
       ERP screen edits. Skipped silently so a till is never blocked. */
    if k = 'srerp_analytics_parent_state' and not owner then
      continue;
    end if;

    select w.revision, w.value, w.write_id into existing_rev, existing_val, existing_wid
      from public.workspace_kv w
     where w.workspace_id = uid and w.key = k;

    if existing_rev is null then
      if expected is not null then
        -- The client expected a row that is gone: let it decide.
        key := k; revision := null; conflicted := true; current_value := null; current_write_id := null;
        return next;
        continue;
      end if;
      insert into public.workspace_kv (workspace_id, key, value, write_id)
      values (uid, k, v, wid)
      returning workspace_kv.revision into new_rev;
      key := k; revision := new_rev; conflicted := false; current_value := null; current_write_id := null;
      return next;

    elsif wid is not null and existing_wid = wid then
      /* This very write is what the row holds: a retry of a write that
         landed. Accepting it is the whole point of the id — merging its
         own value onto itself is how stock went negative. */
      key := k; revision := existing_rev; conflicted := false; current_value := null; current_write_id := null;
      return next;

    elsif expected is not null and existing_rev = expected then
      update public.workspace_kv w
         set value = v, write_id = wid
       where w.workspace_id = uid and w.key = k and w.revision = expected
      returning w.revision into new_rev;
      key := k; revision := new_rev; conflicted := false; current_value := null; current_write_id := null;
      return next;

    else
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val; current_write_id := existing_wid;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.save_workspace_kv(jsonb) from public, anon;
grant execute on function public.save_workspace_kv(jsonb) to authenticated;

/* The element-level write gets the same treatment, so the two paths agree
   whenever delta writes are switched back on. */
drop function if exists public.save_workspace_kv_delta(jsonb);

create function public.save_workspace_kv_delta(entries jsonb)
returns table (key text, revision bigint, conflicted boolean, current_value jsonb, current_write_id text)
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
  wid text;
  changed jsonb;
  removed jsonb;
  existing_rev bigint;
  existing_val jsonb;
  existing_wid text;
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
    wid := nullif(left(entry ->> 'write_id', 64), '');
    changed := coalesce(entry -> 'changed', '[]'::jsonb);
    removed := coalesce(entry -> 'removed', '[]'::jsonb);

    if k is null or k !~ '^srerp_[a-zA-Z0-9_-]{1,100}$' then
      continue;
    end if;
    if k = 'srerp_analytics_parent_state' and not owner then
      continue;   -- same guard as the RLS write policies
    end if;

    select w.revision, w.value, w.write_id into existing_rev, existing_val, existing_wid
      from public.workspace_kv w
     where w.workspace_id = uid and w.key = k;

    -- A retry of a delta that already landed: accepted, nothing to apply.
    if existing_rev is not null and wid is not null and existing_wid = wid then
      key := k; revision := existing_rev; conflicted := false; current_value := null; current_write_id := null;
      return next;
      continue;
    end if;

    /* A delta only means anything against a known base. No row, or a base
       that has moved, is a conflict — the client re-reads and merges. */
    if existing_rev is null or expected is null or existing_rev <> expected then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val; current_write_id := existing_wid;
      return next;
      continue;
    end if;

    /* The stored value is the app's own JSON text, so it has to be parsed
       out of the string before it can be treated as a list. Anything that
       is not a list of objects is refused rather than guessed at. */
    begin
      list := (existing_val #>> '{}')::jsonb;
    exception when others then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val; current_write_id := existing_wid;
      return next;
      continue;
    end;

    if jsonb_typeof(list) <> 'array' then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val; current_write_id := existing_wid;
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
       set value = to_jsonb((rebuilt || appended)::text), write_id = wid
     where w.workspace_id = uid and w.key = k and w.revision = expected
    returning w.revision into new_rev;

    if new_rev is null then
      key := k; revision := existing_rev; conflicted := true; current_value := existing_val; current_write_id := existing_wid;
    else
      key := k; revision := new_rev; conflicted := false; current_value := null; current_write_id := null;
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.save_workspace_kv_delta(jsonb) from public, anon;
grant execute on function public.save_workspace_kv_delta(jsonb) to authenticated;
