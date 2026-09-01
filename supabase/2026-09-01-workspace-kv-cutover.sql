-- Migration 2026-09-01 (c) — cutover from the app_state snapshot to
-- workspace_kv.
--
-- migrate_app_state_to_kv() was written for the FIRST copy: it inserts
-- only keys that have no row yet, so that a terminal already writing
-- per-key data could never be overwritten by the older blob. That is the
-- right rule while both engines coexist, and the wrong one at cutover.
--
-- Between the first copy and go-live the shop keeps trading on the
-- snapshot engine, so app_state moves on and workspace_kv goes stale —
-- measured on 2026-09-01, the blob had 33 products while the kv copy
-- still had 4. Flipping the switch with that gap in place would silently
-- roll the shop back to the older copy.
--
-- This function closes the gap: it makes workspace_kv an exact mirror of
-- the snapshot, adding, overwriting and removing as needed. It is
-- therefore DESTRUCTIVE toward workspace_kv and must be run only at
-- cutover, with every terminal logged out, immediately before the build
-- with STORE_ENABLED = true goes live.
--
-- It takes a named history version first, so the pre-cutover kv state
-- stays recoverable.
--
-- Safe to run on a live database in the sense that it adds one function
-- and touches app_state not at all. Re-runnable.

create or replace function public.cutover_app_state_to_kv()
returns table (added integer, updated integer, removed integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  snap jsonb;
  n_added integer := 0;
  n_updated integer := 0;
  n_removed integer := 0;
begin
  -- Owners only: this replaces the whole key space.
  if uid is null or not public.is_active_user() or not public.is_workspace_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select s.snapshot into snap from public.app_state s where s.user_id = uid;
  if snap is null then
    raise exception 'no_snapshot_to_cut_over' using errcode = 'P0001';
  end if;

  -- Whatever workspace_kv holds right now stays recoverable.
  perform public.snapshot_workspace_kv('avto: cutover oldidan');

  -- Keys the snapshot no longer has.
  with doomed as (
    delete from public.workspace_kv k
     where k.workspace_id = uid
       and not (snap ? k.key)
    returning 1
  )
  select count(*) into n_removed from doomed;

  -- Keys whose value changed.
  with changed as (
    update public.workspace_kv k
       set value = entry.value
      from jsonb_each(snap) as entry(key, value)
     where k.workspace_id = uid
       and k.key = entry.key
       and k.value is distinct from entry.value
    returning 1
  )
  select count(*) into n_updated from changed;

  -- Keys the snapshot has and kv does not.
  with fresh as (
    insert into public.workspace_kv (workspace_id, key, value)
    select uid, entry.key, entry.value
      from jsonb_each(snap) as entry(key, value)
     where entry.key ~ '^srerp_[a-zA-Z0-9_-]{1,100}$'
    on conflict (workspace_id, key) do nothing
    returning 1
  )
  select count(*) into n_added from fresh;

  return query select n_added, n_updated, n_removed;
end;
$$;

revoke all on function public.cutover_app_state_to_kv() from public, anon;
grant execute on function public.cutover_app_state_to_kv() to authenticated;
