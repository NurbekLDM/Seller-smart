-- Smart Retail ERP · Supabase schema v2 — fully isolated per-user workspaces
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run. If the v1 shared-workspace schema is present, it is
-- migrated automatically: the shared snapshot moves into the workspace of
-- the first ADMIN user; the old shared version history is discarded.
--
-- Model: every authenticated user owns exactly one private workspace —
-- their own versioned snapshot and version history. There are no roles and
-- no sharing: Row Level Security scopes every row to auth.uid(), so no one
-- (including other admins) can read or write another user's data.

-- ------------------------------------------- 1. remove the v1 schema ------

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists app_state_select_active on public.app_state;

drop function if exists public.save_app_state(bigint, jsonb);
drop function if exists public.list_app_state_versions();
drop function if exists public.create_app_state_version(text);
drop function if exists public.restore_app_state_version(bigint);
drop function if exists public.delete_app_state_version(bigint);
drop function if exists public.active_user_role();

do $$
declare
  old_snapshot jsonb;
  old_version bigint;
  target uuid;
begin
  -- v1 app_state had a text "id" column with one shared row 'main'.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_state' and column_name = 'id') then
    execute 'select snapshot, version from public.app_state where id = ''main''' into old_snapshot, old_version;
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'profiles' and column_name = 'role') then
      execute 'select id from public.profiles where role = ''ADMIN'' order by created_at limit 1' into target;
    end if;
    drop table public.app_state cascade;
    create table public.app_state (
      user_id uuid primary key references auth.users (id) on delete cascade,
      version bigint not null default 0,
      snapshot jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    if target is not null and old_snapshot is not null then
      insert into public.app_state (user_id, version, snapshot)
      values (target, coalesce(old_version, 0), old_snapshot);
    end if;
  end if;
  -- v1 history was keyed by the shared state id; it cannot be mapped to
  -- individual users, so it is dropped.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_state_history' and column_name = 'state_id') then
    drop table public.app_state_history cascade;
  end if;
end $$;

alter table if exists public.profiles drop column if exists role;

-- ---------------------------------------------------------- profiles ------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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

-- True while the caller's account exists and is not deactivated.
create or replace function public.is_active_user()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- --------------------------------------------------------- app_state ------

create table if not exists public.app_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  version bigint not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- Users read only their own workspace; writes go through save_app_state().
drop policy if exists app_state_select_own on public.app_state;
create policy app_state_select_own on public.app_state
  for select to authenticated
  using (user_id = auth.uid() and public.is_active_user());

-- --------------------------------------------------- version history ------

create table if not exists public.app_state_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version bigint not null,
  snapshot jsonb not null,
  label text not null default '',  -- '' = automatic hourly snapshot
  created_at timestamptz not null default now()
);
create index if not exists app_state_history_user_idx
  on public.app_state_history (user_id, label, created_at desc);

alter table public.app_state_history enable row level security;
-- No direct policies: all access goes through the functions below.

-- ------------------------------------------- snapshot save + version RPCs -

-- Optimistic-concurrency save into the caller's own workspace. Keeps at
-- most one automatic history snapshot per hour, pruned to the newest 72.
create or replace function public.save_app_state(expected_version bigint, new_snapshot jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_version bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.app_state (user_id) values (uid) on conflict (user_id) do nothing;

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

-- List the caller's stored versions (metadata only, never the snapshots).
create or replace function public.list_app_state_versions()
returns table (id bigint, version bigint, label text, created_at timestamptz, size_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select h.id, h.version, h.label, h.created_at, pg_column_size(h.snapshot)::bigint
    from public.app_state_history h
    where h.user_id = auth.uid()
    order by h.created_at desc
    limit 200;
end;
$$;

-- Save the caller's current state as a named backup (never auto-pruned).
create or replace function public.create_app_state_version(version_label text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id bigint;
begin
  if not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.app_state_history (user_id, version, snapshot, label)
  select s.user_id, s.version, s.snapshot, coalesce(nullif(trim(version_label), ''), 'backup')
  from public.app_state s where s.user_id = auth.uid()
  returning id into new_id;
  if new_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return new_id;
end;
$$;

-- Restore one of the caller's versions. The pre-restore state is kept as a
-- named backup first, so a restore is always reversible.
create or replace function public.restore_app_state_version(history_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  target record;
  new_version bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into target from public.app_state_history where id = history_id and user_id = uid;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.app_state_history (user_id, version, snapshot, label)
  select s.user_id, s.version, s.snapshot, 'tiklashdan oldingi holat'
  from public.app_state s where s.user_id = uid;
  update public.app_state
  set snapshot = target.snapshot,
      version = version + 1,
      updated_at = now()
  where user_id = uid
  returning version into new_version;
  return new_version;
end;
$$;

-- Delete one of the caller's stored versions.
create or replace function public.delete_app_state_version(history_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.app_state_history where id = history_id and user_id = auth.uid();
end;
$$;

revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;
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

-- ------------------------------------------------------------ notes -------
-- Accounts are created in the dashboard (Authentication -> Users -> Add
-- user, "Auto Confirm User" checked). Every account is a fully private
-- workspace with all features; there are no roles.
-- Block an account without deleting its data:
--   update public.profiles set active = false where id = '...';
