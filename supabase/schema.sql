-- Smart Retail ERP · Supabase schema (Phase 1)
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Design: the app keeps its offline-first localStorage model; every device
-- pushes/pulls one shared versioned snapshot ("app_state"). Users live in
-- Supabase Auth; each user gets a row in "profiles" with a role. Access is
-- enforced by Row Level Security, so permissions hold even if the client
-- code is bypassed.

-- ============================================================ profiles ====

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null default '',
  role text not null default 'VIEWER' check (role in ('ADMIN', 'POS', 'WMS', 'VIEWER')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every new auth user automatically gets a profile (default role VIEWER;
-- the owner promotes users explicitly).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(coalesce(new.email, new.id::text), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role lookup that bypasses RLS (avoids recursive policy lookups).
-- Returns null for missing or deactivated users.
create or replace function public.active_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and active;
$$;

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.active_user_role() = 'ADMIN');

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.active_user_role() = 'ADMIN')
  with check (public.active_user_role() = 'ADMIN');

-- =========================================================== app_state ====

create table if not exists public.app_state (
  id text primary key,
  version bigint not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

insert into public.app_state (id) values ('main') on conflict (id) do nothing;

alter table public.app_state enable row level security;

-- Any active user may read the shared state. Writing goes only through the
-- save_app_state() function below (no direct insert/update/delete policies).
drop policy if exists app_state_select_active on public.app_state;
create policy app_state_select_active on public.app_state
  for select to authenticated
  using (public.active_user_role() is not null);

-- Optimistic-concurrency save: fails with 'version_conflict' when another
-- device saved first, so data is never silently overwritten.
-- ====================================================== version history ===

create table if not exists public.app_state_history (
  id bigint generated always as identity primary key,
  state_id text not null default 'main',
  version bigint not null,
  snapshot jsonb not null,
  label text not null default '',  -- '' = automatic hourly snapshot
  created_at timestamptz not null default now(),
  created_by text not null default ''
);
create index if not exists app_state_history_time_idx
  on public.app_state_history (state_id, label, created_at desc);

alter table public.app_state_history enable row level security;
-- No direct policies: all access goes through the admin functions below.

-- ================================================= snapshot save + RPCs ===

create or replace function public.save_app_state(expected_version bigint, new_snapshot jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_name text;
  new_version bigint;
begin
  select role, username into caller_role, caller_name
  from public.profiles where id = auth.uid() and active;

  if caller_role is null or caller_role not in ('ADMIN', 'POS', 'WMS') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.app_state
  set version = version + 1,
      snapshot = new_snapshot,
      updated_at = now(),
      updated_by = coalesce(nullif(caller_name, ''), auth.uid()::text)
  where id = 'main' and version = expected_version
  returning version into new_version;

  if new_version is null then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  -- Automatic history: keep at most one snapshot per hour, pruned to the
  -- newest 72 automatic entries (~a working week). Named manual backups
  -- (label <> '') are never pruned.
  if not exists (
    select 1 from public.app_state_history
    where state_id = 'main' and label = '' and created_at > now() - interval '1 hour'
  ) then
    insert into public.app_state_history (state_id, version, snapshot, label, created_by)
    values ('main', new_version, new_snapshot, '', coalesce(nullif(caller_name, ''), auth.uid()::text));
    delete from public.app_state_history
    where state_id = 'main' and label = ''
      and id not in (
        select id from public.app_state_history
        where state_id = 'main' and label = ''
        order by created_at desc limit 72
      );
  end if;

  return new_version;
end;
$$;

-- List stored versions (metadata only, never the multi-MB snapshots).
create or replace function public.list_app_state_versions()
returns table (id bigint, version bigint, label text, created_at timestamptz, created_by text, size_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.active_user_role() is distinct from 'ADMIN' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select h.id, h.version, h.label, h.created_at, h.created_by, pg_column_size(h.snapshot)::bigint
    from public.app_state_history h
    where h.state_id = 'main'
    order by h.created_at desc
    limit 200;
end;
$$;

-- Save the current state as a named backup that is never auto-pruned.
create or replace function public.create_app_state_version(version_label text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_name text;
  new_id bigint;
begin
  if public.active_user_role() is distinct from 'ADMIN' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select username into caller_name from public.profiles where id = auth.uid();
  insert into public.app_state_history (state_id, version, snapshot, label, created_by)
  select 'main', s.version, s.snapshot,
         coalesce(nullif(trim(version_label), ''), 'backup'),
         coalesce(nullif(caller_name, ''), auth.uid()::text)
  from public.app_state s where s.id = 'main'
  returning id into new_id;
  return new_id;
end;
$$;

-- Restore a stored version. The pre-restore state is kept as a named
-- backup first, so a restore is always reversible.
create or replace function public.restore_app_state_version(history_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_name text;
  target record;
  new_version bigint;
begin
  if public.active_user_role() is distinct from 'ADMIN' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select username into caller_name from public.profiles where id = auth.uid();
  select * into target from public.app_state_history where id = history_id and state_id = 'main';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.app_state_history (state_id, version, snapshot, label, created_by)
  select 'main', s.version, s.snapshot, 'tiklashdan oldingi holat',
         coalesce(nullif(caller_name, ''), auth.uid()::text)
  from public.app_state s where s.id = 'main';
  update public.app_state
  set snapshot = target.snapshot,
      version = version + 1,
      updated_at = now(),
      updated_by = coalesce(nullif(caller_name, ''), auth.uid()::text)
  where id = 'main'
  returning version into new_version;
  return new_version;
end;
$$;

-- Delete a stored version (e.g. an old manual backup).
create or replace function public.delete_app_state_version(history_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.active_user_role() is distinct from 'ADMIN' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.app_state_history where id = history_id and state_id = 'main';
end;
$$;

revoke all on function public.save_app_state(bigint, jsonb) from public, anon;
grant execute on function public.save_app_state(bigint, jsonb) to authenticated;
revoke all on function public.list_app_state_versions() from public, anon;
grant execute on function public.list_app_state_versions() to authenticated;
revoke all on function public.create_app_state_version(text) from public, anon;
grant execute on function public.create_app_state_version(text) to authenticated;
revoke all on function public.restore_app_state_version(bigint) from public, anon;
grant execute on function public.restore_app_state_version(bigint) to authenticated;
revoke all on function public.delete_app_state_version(bigint) from public, anon;
grant execute on function public.delete_app_state_version(bigint) to authenticated;

revoke all on function public.active_user_role() from public, anon;
grant execute on function public.active_user_role() to authenticated;

-- ============================================================== notes =====
-- After creating your first user (Authentication -> Users -> Add user),
-- promote them to owner/admin by running:
--
--   update public.profiles set role = 'ADMIN' where id = 'PASTE-USER-UUID';
--
-- Roles: ADMIN (full access), POS / WMS (can save data), VIEWER (read-only).
-- Deactivate a user without deleting:  update public.profiles set active = false where id = '...';
