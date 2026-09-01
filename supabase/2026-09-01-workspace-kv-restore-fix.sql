-- Migration 2026-09-01 (e) — make restoring a version safe for live tills.
--
-- The first version of restore_workspace_kv_version() deleted every row
-- and re-inserted them. Realtime broadcast that intermediate empty state
-- to every connected terminal; each dropped the keys from memory, the ERP
-- read a key that was suddenly missing, found nothing, and wrote an empty
-- array back. Measured on 2026-09-01 against the live workspace: restoring
-- a 39-key version emptied srerp_cells (6 249 rows) within seconds, and
-- two open tabs then pushed their stale arrays over the restored data.
-- The button was disabled in the client the same day.
--
-- The fix is to stop deleting what is coming straight back. A restore is
-- now the diff between the stored version and the snapshot: update the
-- values that differ, insert the keys that are missing, and delete only
-- the keys the snapshot genuinely does not have — usually none. Terminals
-- see ordinary updates and converge on them, and never see a blank
-- workspace at any point.
--
-- The revision column does the rest: every touched key gets a new
-- revision, so a terminal holding an unsent write based on the old one
-- conflicts and merges rather than overwriting the restore.
--
-- Safe to run on a live database: redefines one function, touches no data.
-- Re-runnable.

create or replace function public.restore_workspace_kv_version(history_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  saved jsonb;
  touched integer := 0;
  removed integer := 0;
begin
  -- Owners only: a till must never be able to roll the shop back.
  if uid is null or not public.is_active_user() or not public.is_workspace_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select snapshot into saved
    from public.workspace_kv_history
   where id = history_id and workspace_id = uid;
  if saved is null then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;

  -- The state being replaced stays recoverable; the panel promises this.
  perform public.snapshot_workspace_kv('avto: tiklashdan oldin');

  /* Keys the snapshot does not have. Deleted FIRST and, in practice,
     almost never: a restore normally changes values, not the key set. A
     handful of deletes stays under the client's bulk-delete threshold, and
     anything larger trips it and makes terminals re-read — which is the
     right outcome for a change that big. */
  with dropped as (
    delete from public.workspace_kv k
     where k.workspace_id = uid
       and not (saved ? k.key)
    returning 1
  )
  select count(*) into removed from dropped;

  /* Everything the snapshot does have, written in place. `is distinct
     from` keeps untouched keys at their current revision, so terminals are
     not woken for values that did not actually change. */
  with applied as (
    insert into public.workspace_kv (workspace_id, key, value)
    select uid, entry.key, entry.value
      from jsonb_each(saved) as entry(key, value)
     where entry.key ~ '^srerp_[a-zA-Z0-9_-]{1,100}$'
    on conflict (workspace_id, key) do update
       set value = excluded.value
     where public.workspace_kv.value is distinct from excluded.value
    returning 1
  )
  select count(*) into touched from applied;

  return touched + removed;
end;
$$;

revoke all on function public.restore_workspace_kv_version(bigint) from public, anon;
grant execute on function public.restore_workspace_kv_version(bigint) to authenticated;
