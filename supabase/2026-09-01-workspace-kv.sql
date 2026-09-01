-- Migration 2026-09-01 — per-key workspace storage (phase 1 of dropping
-- the app_state blob).
--
-- Why: app_state stores the whole workspace as ONE jsonb snapshot, so
-- every save uploads everything. On a live shop that snapshot is ~3.7 MB
-- (srerp_analytics_parent_state 2.37 MB + srerp_cells 1.34 MB), which is
-- what a single added sale costs to persist. It also means two people on
-- one account collide on the snapshot's version even when they touched
-- completely different things, and one side's work is discarded.
--
-- workspace_kv replaces that with one row per key, written through plain
-- PostgREST upserts/deletes. A sale becomes a ~1 KB write, two terminals
-- editing different keys never conflict at all, and Realtime can push a
-- single changed row instead of the client polling for a new version.
--
-- Safe to run on a live database: it only ADDS a table, its policies and
-- one migration function. app_state and app_state_history are left
-- untouched and keep working, so this is fully reversible — drop the
-- table and the old path is still there. Re-runnable.

-- ------------------------------------------------------ workspace_kv ------

create table if not exists public.workspace_kv (
  workspace_id uuid not null default public.workspace_of()
    references auth.users (id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid(),
  primary key (workspace_id, key),
  -- Mirrors the client's permitted() predicate. The synced key space is
  -- srerp_* only; anything else is a client bug, not data.
  constraint workspace_kv_key_format check (key ~ '^srerp_[a-zA-Z0-9_-]{1,100}$')
);

create index if not exists workspace_kv_updated_idx
  on public.workspace_kv (workspace_id, updated_at desc);

alter table public.workspace_kv enable row level security;

-- Keep the audit columns honest: a client may send whatever it likes for
-- updated_at/updated_by, and on upsert the DEFAULTs do not re-fire.
create or replace function public.workspace_kv_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists workspace_kv_touch_trg on public.workspace_kv;
create trigger workspace_kv_touch_trg
  before insert or update on public.workspace_kv
  for each row execute function public.workspace_kv_touch();

-- ----------------------------------------------------------- policies -----

-- Read: every active member of the workspace sees the whole key space,
-- exactly as they see the whole snapshot today.
drop policy if exists workspace_kv_select on public.workspace_kv;
create policy workspace_kv_select on public.workspace_kv
  for select to authenticated
  using (workspace_id = public.workspace_of() and public.is_active_user());

/* Write: same workspace, plus the guard that 2026-08-30 had to implement
   by overriding the snapshot inside save_app_state(). ERP staff write
   into their OWNER's workspace and the ERP's permission model lives in
   the terminal's own localStorage, so it is not a security boundary: a
   tampered till must not be able to reach the owner's Uzum Analytics
   state, which no ERP screen ever edits.

   Per-key rows let the database say this directly instead of silently
   rewriting a submitted snapshot — and because the till no longer sends
   that key at all, blocking it can never fail a shop-floor sale. */
drop policy if exists workspace_kv_insert on public.workspace_kv;
create policy workspace_kv_insert on public.workspace_kv
  for insert to authenticated
  with check (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
  );

drop policy if exists workspace_kv_update on public.workspace_kv;
create policy workspace_kv_update on public.workspace_kv
  for update to authenticated
  using (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
  )
  with check (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
  );

drop policy if exists workspace_kv_delete on public.workspace_kv;
create policy workspace_kv_delete on public.workspace_kv
  for delete to authenticated
  using (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
  );

-- ----------------------------------------------------------- realtime -----

/* Publish the table so other terminals learn about a changed key the
   moment it is written, instead of discovering it on the next poll.
   DELETE events carry the primary key under the default replica identity,
   which is (workspace_id, key) — exactly what a subscriber needs to drop
   the key locally. */
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'workspace_kv'
     ) then
    execute 'alter publication supabase_realtime add table public.workspace_kv';
  end if;
end
$$;

-- ---------------------------------------------------------- migration -----

/* One-shot copy of the existing snapshot into per-key rows.
   Deliberately does NOT overwrite a key that already has a row: by the
   time this runs a terminal may already have written fresher data, and
   the stale blob must never win. Returns how many keys it inserted, so
   running it twice reports 0 rather than silently doing damage. */
create or replace function public.migrate_app_state_to_kv()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  inserted integer;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.workspace_kv (workspace_id, key, value)
  select uid, entry.key, entry.value
    from public.app_state s,
         lateral jsonb_each(s.snapshot) as entry(key, value)
   where s.user_id = uid
     and entry.key ~ '^srerp_[a-zA-Z0-9_-]{1,100}$'
  on conflict (workspace_id, key) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.migrate_app_state_to_kv() from public, anon;
grant execute on function public.migrate_app_state_to_kv() to authenticated;
revoke all on function public.workspace_kv_touch() from public, anon;
