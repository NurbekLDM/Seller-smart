-- Migration 2026-09-01 (b) — version history for workspace_kv.
--
-- The snapshot engine got this for free: save_app_state() wrote an hourly
-- copy of the whole blob into app_state_history, and the owner's
-- "Versiyalar" panel listed, created, restored and deleted those. Per-key
-- writes have no single moment to hang that off, and app_state_history
-- freezes at whatever the blob last held — so without this, turning the
-- store on silently removes the ability to restore a backup.
--
-- Automatic versions are taken by the client (once at sign-in, then
-- hourly); snapshot_workspace_kv() itself enforces at most one automatic
-- version per hour and prunes to the newest 72, so calling it more often
-- is harmless.
--
-- Safe to run on a live database: adds one table and four functions,
-- touches no existing data. Re-runnable.

create table if not exists public.workspace_kv_history (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references auth.users (id) on delete cascade,
  snapshot jsonb not null,
  label text not null default '',   -- '' = automatic hourly version
  created_at timestamptz not null default now()
);

create index if not exists workspace_kv_history_idx
  on public.workspace_kv_history (workspace_id, label, created_at desc);

alter table public.workspace_kv_history enable row level security;
-- No policies on purpose: every path goes through the functions below,
-- which check workspace membership themselves.

-- --------------------------------------------------------- take a copy ----

create or replace function public.snapshot_workspace_kv(version_label text default '')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  clean_label text := coalesce(nullif(btrim(version_label), ''), '');
  taken bigint;
begin
  if uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- An automatic version is worth taking at most once an hour. A named
  -- one is an explicit act and is always taken.
  if clean_label = '' and exists (
    select 1 from public.workspace_kv_history
    where workspace_id = uid and label = '' and created_at > now() - interval '1 hour'
  ) then
    return null;
  end if;

  insert into public.workspace_kv_history (workspace_id, snapshot, label)
  select uid, coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb), clean_label
    from public.workspace_kv k
   where k.workspace_id = uid
  returning id into taken;

  if clean_label = '' then
    delete from public.workspace_kv_history
     where workspace_id = uid and label = ''
       and id not in (
         select id from public.workspace_kv_history
          where workspace_id = uid and label = ''
          order by created_at desc limit 72
       );
  end if;

  return taken;
end;
$$;

-- ------------------------------------------------------------- listing ----

create or replace function public.list_workspace_kv_versions()
returns table (id bigint, label text, created_at timestamptz, size_bytes bigint, keys integer)
language sql
security definer
stable
set search_path = public
as $$
  select h.id, h.label, h.created_at,
         pg_column_size(h.snapshot)::bigint as size_bytes,
         (select count(*) from jsonb_object_keys(h.snapshot))::integer as keys
    from public.workspace_kv_history h
   where h.workspace_id = public.workspace_of()
     and public.is_active_user()
   order by h.created_at desc
   limit 200;
$$;

-- ------------------------------------------------------------- restore ----

/* Restoring replaces the whole key space, so the state being replaced is
   copied first — the panel promises exactly that, and after a restore
   there is otherwise no way back. Owners only: a till must never be able
   to roll the shop back. */
create or replace function public.restore_workspace_kv_version(history_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  saved jsonb;
  restored integer;
begin
  if uid is null or not public.is_active_user() or not public.is_workspace_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select snapshot into saved
    from public.workspace_kv_history
   where id = history_id and workspace_id = uid;
  if saved is null then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;

  perform public.snapshot_workspace_kv('avto: tiklashdan oldin');

  delete from public.workspace_kv where workspace_id = uid;

  insert into public.workspace_kv (workspace_id, key, value)
  select uid, entry.key, entry.value
    from jsonb_each(saved) as entry(key, value)
   where entry.key ~ '^srerp_[a-zA-Z0-9_-]{1,100}$';

  get diagnostics restored = row_count;
  return restored;
end;
$$;

-- -------------------------------------------------------------- delete ----

create or replace function public.delete_workspace_kv_version(history_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
begin
  if uid is null or not public.is_active_user() or not public.is_workspace_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Automatic versions are the safety net and are pruned on a schedule of
  -- their own; only named backups may be removed by hand.
  delete from public.workspace_kv_history
   where id = history_id and workspace_id = uid and label <> '';
  return found;
end;
$$;

-- --------------------------------------------------------------- grants ---

revoke all on function public.snapshot_workspace_kv(text) from public, anon;
grant execute on function public.snapshot_workspace_kv(text) to authenticated;
revoke all on function public.list_workspace_kv_versions() from public, anon;
grant execute on function public.list_workspace_kv_versions() to authenticated;
revoke all on function public.restore_workspace_kv_version(bigint) from public, anon;
grant execute on function public.restore_workspace_kv_version(bigint) to authenticated;
revoke all on function public.delete_workspace_kv_version(bigint) from public, anon;
grant execute on function public.delete_workspace_kv_version(bigint) to authenticated;
