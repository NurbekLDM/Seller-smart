-- Migration 2026-08-30 — server-side guard for ERP staff writes.
--
-- ERP staff share their owner's app_state row, and the ERP's permission
-- model lives in the terminal's own localStorage, so it is not a security
-- boundary: a tampered till could replace the whole workspace, including
-- the owner's Uzum Analytics state that no ERP screen ever edits.
-- This replaces save_app_state() so a staff write always keeps that entry
-- at its stored value. It OVERRIDES rather than rejects, so a staff save
-- can never fail on this and a shop-floor terminal is never blocked.
--
-- Safe to run on a live database: it only redefines one function, touches
-- no table and no data. Re-runnable.

create or replace function public.save_app_state(expected_version bigint, new_snapshot jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  new_version bigint;
  owner_analytics jsonb;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.app_state (user_id) values (uid) on conflict (user_id) do nothing;

  -- ERP staff write into their OWNER's workspace row, so a tampered or
  -- stolen till could otherwise replace the entire workspace — including
  -- the owner's Uzum Analytics state, which no ERP screen ever edits. The
  -- ERP client already carries that entry through untouched; enforce it
  -- here too, because the client-side permission model (a permissions
  -- array in the terminal's own localStorage) is not a security boundary.
  -- Overridden rather than rejected: a staff save can never fail on this,
  -- so a shop floor terminal is never blocked from recording a sale.
  if not public.is_workspace_owner() then
    select snapshot -> 'srerp_analytics_parent_state' into owner_analytics
      from public.app_state where user_id = uid;
    if owner_analytics is null then
      new_snapshot := new_snapshot - 'srerp_analytics_parent_state';
    else
      new_snapshot := jsonb_set(new_snapshot, '{srerp_analytics_parent_state}', owner_analytics);
    end if;
  end if;

  update public.app_state
  set version = version + 1,
      snapshot = new_snapshot,
      updated_at = now()
  where user_id = uid and version = expected_version
  returning version into new_version;

  if new_version is null then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.app_state_history
    where user_id = uid and label = '' and created_at > now() - interval '1 hour'
  ) then
    insert into public.app_state_history (user_id, version, snapshot, label)
    values (uid, new_version, new_snapshot, '');
    delete from public.app_state_history
    where user_id = uid and label = ''
      and id not in (
        select id from public.app_state_history
        where user_id = uid and label = ''
        order by created_at desc limit 72
      );
  end if;

  return new_version;
end;
$$;
