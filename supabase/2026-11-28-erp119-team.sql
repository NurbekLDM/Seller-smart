-- Migration 2026-11-28 — SellerSmart team features (the technical
-- presentation, topics 1–3), on top of 2026-11-27-erp119-kv.sql.
--
--   1. Services: the four products (ERP, Uzum Analitika, Diet Seller,
--      Kartochka Studio) each get their own grant per account — start date,
--      end date, block switch — managed on /admin. service_allowed() is the
--      one check every product uses.
--   2. Audit: audit_events, written by the server (admin and staff actions)
--      and by the restore function below. Readable only through the
--      service role (the /admin API).
--   3. ERP 119.3 staff: erp119_put() refuses the employee list and field
--      permissions from anyone but the workspace owner, and lets staff only
--      ADD to the employee audit log, never rewrite it.
--   4. ERP 119.3 online chat: one authoritative chat state per workspace and
--      its attachments, written only by the server (server/chat119.mjs runs
--      the ERP's own chat rules); erp119_chat_head tells devices to refresh.
--   5. ERP 119.3 restore from a ZIP backup onto the server: the backup is
--      uploaded to a staging area, verified, then swapped in one
--      transaction. The previous data is archived, not deleted, and the
--      workspace "epoch" goes up so every device reloads from the server.
--
-- Re-runnable. Run as supabase_admin (see deploy/SERVER.md).

-- ============================================================ services ===

create table if not exists public.service_grants (
  user_id uuid not null references auth.users (id) on delete cascade,
  service text not null,
  starts_at timestamptz,
  expires_at timestamptz,
  blocked boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (user_id, service),
  constraint service_grants_known check (service in ('erp', 'analytics', 'diet', 'kartochka'))
);

alter table public.service_grants enable row level security;

drop policy if exists service_grants_select_own on public.service_grants;
create policy service_grants_select_own on public.service_grants
  for select to authenticated
  using (user_id = public.workspace_of());

revoke insert, update, delete on public.service_grants from anon, authenticated;
grant select on public.service_grants to authenticated;

/* Whether an account may use a service right now. Staff use their owner's
   grant. Without a grant row the older rule still holds, so nothing that
   works today stops working: ERP and Analitika follow profiles.products,
   Diet and Kartochka need a grant. Administrators always have every
   service. The account itself must be active (is_active_user rules). */
create or replace function public.service_allowed(p_user uuid, p_service text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  with me as (
    select p.id, coalesce(p.workspace_owner, p.id) as ws
    from public.profiles p
    where p.id = p_user
      and p.active
      and (p.expires_at is null or p.expires_at > now())
  )
  select coalesce((
    select case
      when exists (select 1 from public.admins a where a.user_id in (me.id, me.ws)) then true
      when g.user_id is not null then
        not g.blocked
        and (g.starts_at is null or g.starts_at <= now())
        and (g.expires_at is null or g.expires_at > now())
      when p_service in ('erp', 'analytics') then
        o.products is null or p_service = any (o.products)
      else false
    end
    from me
    join public.profiles o on o.id = me.ws
                          and o.active
                          and (o.expires_at is null or o.expires_at > now())
    left join public.service_grants g on g.user_id = me.ws and g.service = p_service
  ), false);
$$;

-- The caller's four services, for the "Mening servislarim" page.
create or replace function public.my_services()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  with me as (
    select p.id, coalesce(p.workspace_owner, p.id) as ws, p.workspace_owner is not null as staff
    from public.profiles p where p.id = auth.uid()
  ), svc(service, ord) as (
    values ('erp', 1), ('analytics', 2), ('diet', 3), ('kartochka', 4)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'service', svc.service,
      'allowed', public.service_allowed(me.id, svc.service),
      'status', case
        when public.service_allowed(me.id, svc.service) then 'active'
        when g.blocked then 'blocked'
        when g.starts_at is not null and g.starts_at > now() then 'not_started'
        when g.expires_at is not null and g.expires_at <= now() then 'expired'
        else 'none' end,
      'starts_at', g.starts_at,
      'expires_at', g.expires_at,
      'staff', me.staff
    ) order by svc.ord), '[]'::jsonb)
  from me cross join svc
  left join public.service_grants g on g.user_id = me.ws and g.service = svc.service;
$$;

-- Server-side only (the /api handlers and the chat server use the service role).
revoke all on function public.service_allowed(uuid, text) from public, anon, authenticated;
grant execute on function public.service_allowed(uuid, text) to service_role;
revoke all on function public.my_services() from public, anon;
grant execute on function public.my_services() to authenticated;

-- =============================================================== audit ===

create table if not exists public.audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  action text not null,
  target_id uuid,
  target_email text,
  service text,
  details jsonb not null default '{}'::jsonb,
  ip text
);

create index if not exists audit_events_at_idx on public.audit_events (at desc);
create index if not exists audit_events_target_idx on public.audit_events (target_id, at desc);

alter table public.audit_events enable row level security;
revoke all on public.audit_events from anon, authenticated;

-- ============================================== ERP 119.3: access rules ===

alter table public.erp119_workspace add column if not exists epoch bigint not null default 0;

-- ERP 119.3 is the 'erp' service.
create or replace function public.erp119_access()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_active_user() and public.service_allowed(auth.uid(), 'erp');
$$;
revoke all on function public.erp119_access() from public, anon, authenticated;

create or replace function public.erp119_status()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'workspace_id', public.workspace_of(),
    'active', public.erp119_access(),
    'owner', public.is_workspace_owner(),
    'seeded', exists (select 1 from public.erp119_workspace w
                      where w.workspace_id = public.workspace_of()
                        and w.seeded_at is not null),
    'epoch', coalesce((select w.epoch from public.erp119_workspace w
                       where w.workspace_id = public.workspace_of()), 0),
    'keys', (select count(*) from public.erp119_kv k
             where k.workspace_id = public.workspace_of()),
    'revision', (select coalesce(max(revision), 0) from public.erp119_kv k
                 where k.workspace_id = public.workspace_of())
  );
$$;

/* The employee audit log may only grow when staff write it: every record
   already there (but the oldest ones the ERP trims at 5000) must still be
   there, unchanged. */
create or replace function public.erp119_audit_appended(p_old text, p_new text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  o jsonb;
  n jsonb;
begin
  if p_new is null then return false; end if;
  if p_old is null then return true; end if;
  begin
    o := p_old::jsonb;
    n := p_new::jsonb;
  exception when others then
    return false;
  end;
  if jsonb_typeof(o) <> 'array' then return true; end if;
  if jsonb_typeof(n) <> 'array' then return false; end if;
  return not exists (
    select 1
    from jsonb_array_elements(o) with ordinality as t(e, ord)
    where t.ord <= 4900
      and not exists (select 1 from jsonb_array_elements(n) x where x = t.e)
  );
end;
$$;
revoke all on function public.erp119_audit_appended(text, text) from public, anon, authenticated;

drop function if exists public.erp119_put(jsonb, text);

create or replace function public.erp119_put(p_entries jsonb, p_device text default null, p_epoch bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.workspace_of();
  me uuid := auth.uid();
  is_owner boolean := public.is_workspace_owner();
  cur_epoch bigint;
  entry jsonb;
  k text;
  v text;
  base bigint;
  cur_rev bigint;
  cur_val text;
  new_rev bigint;
  results jsonb := '[]'::jsonb;
  dev text := left(coalesce(p_device, ''), 64);
begin
  if ws is null or me is null or not public.erp119_access() then
    raise exception 'erp119: account is not active' using errcode = '42501';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'erp119: entries must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 500 then
    raise exception 'erp119: too many entries' using errcode = '22023';
  end if;

  insert into public.erp119_workspace (workspace_id) values (ws)
  on conflict (workspace_id) do nothing;

  -- A device that loaded the workspace before a restore must not write its
  -- old data into the restored one. Shared lock: a restore waits for us.
  select epoch into cur_epoch from public.erp119_workspace
  where workspace_id = ws for share;
  if p_epoch is not null and p_epoch is distinct from cur_epoch then
    raise exception 'erp119: workspace was restored (epoch %)', cur_epoch using errcode = 'P0001', hint = 'erp119-epoch';
  end if;

  for entry in select * from jsonb_array_elements(p_entries) loop
    k := entry ->> 'key';
    if k is null or char_length(k) < 1 or char_length(k) > 1000 then
      raise exception 'erp119: bad key' using errcode = '22023';
    end if;
    v := case when entry ? 'value' and jsonb_typeof(entry -> 'value') = 'string'
              then entry ->> 'value' end;
    base := case when jsonb_typeof(entry -> 'base') = 'number'
                 then (entry ->> 'base')::bigint end;

    -- Staff never write the owner's Uzum Analytics state, the employee
    -- list or the field permissions: only the owner manages people.
    if not is_owner and k in ('srerp_analytics_parent_state', 'srerp_auth_users_v6',
                              'srerp_warehouse_field_access_v66') then
      results := results || jsonb_build_array(jsonb_build_object(
        'key', k, 'status', 'forbidden'));
      continue;
    end if;

    select revision, value into cur_rev, cur_val
    from public.erp119_kv
    where workspace_id = ws and key = k
    for update;

    if base is distinct from cur_rev then
      results := results || jsonb_build_array(jsonb_build_object(
        'key', k, 'status', 'conflict', 'revision', cur_rev, 'value', cur_val));
      continue;
    end if;

    if not is_owner and k = 'srerp_employee_audit_v70'
       and not public.erp119_audit_appended(cur_val, v) then
      results := results || jsonb_build_array(jsonb_build_object(
        'key', k, 'status', 'forbidden'));
      continue;
    end if;

    if v is null then
      if cur_rev is not null then
        delete from public.erp119_kv where workspace_id = ws and key = k;
        new_rev := nextval('public.erp119_revision_seq');
        insert into public.erp119_head (workspace_id, key, revision, deleted, updated_by, device)
        values (ws, k, new_rev, true, me, dev)
        on conflict (workspace_id, key) do update
          set revision = excluded.revision, deleted = true, updated_at = now(),
              updated_by = excluded.updated_by, device = excluded.device;
      end if;
      results := results || jsonb_build_array(jsonb_build_object(
        'key', k, 'status', 'ok', 'revision', null));
      continue;
    end if;

    if cur_val is not distinct from v then
      results := results || jsonb_build_array(jsonb_build_object(
        'key', k, 'status', 'ok', 'revision', cur_rev));
      continue;
    end if;

    new_rev := nextval('public.erp119_revision_seq');
    insert into public.erp119_kv (workspace_id, key, value, revision, updated_by, device)
    values (ws, k, v, new_rev, me, dev)
    on conflict (workspace_id, key) do update
      set value = excluded.value, revision = excluded.revision, updated_at = now(),
          updated_by = excluded.updated_by, device = excluded.device;
    insert into public.erp119_head (workspace_id, key, revision, deleted, updated_by, device)
    values (ws, k, new_rev, false, me, dev)
    on conflict (workspace_id, key) do update
      set revision = excluded.revision, deleted = false, updated_at = now(),
          updated_by = excluded.updated_by, device = excluded.device;

    results := results || jsonb_build_array(jsonb_build_object(
      'key', k, 'status', 'ok', 'revision', new_rev));
  end loop;

  return results;
end;
$$;

revoke all on function public.erp119_put(jsonb, text, bigint) from public, anon;
grant execute on function public.erp119_put(jsonb, text, bigint) to authenticated;
revoke all on function public.erp119_status() from public, anon;
grant execute on function public.erp119_status() to authenticated;

-- ======================================================= ERP 119.3 chat ===

create table if not exists public.erp119_chat_state (
  workspace_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.erp119_chat_files (
  workspace_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  room_id text not null,
  name text not null,
  mime text not null,
  size integer not null,
  data text not null,               -- base64
  created_by text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

create table if not exists public.erp119_chat_head (
  workspace_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.erp119_chat_state enable row level security;
alter table public.erp119_chat_files enable row level security;
alter table public.erp119_chat_head enable row level security;

drop policy if exists erp119_chat_head_select on public.erp119_chat_head;
create policy erp119_chat_head_select on public.erp119_chat_head
  for select to authenticated
  using (workspace_id = public.workspace_of() and public.is_active_user());

revoke all on public.erp119_chat_state, public.erp119_chat_files from anon, authenticated;
revoke insert, update, delete on public.erp119_chat_head from anon, authenticated;
grant select on public.erp119_chat_head to authenticated;

-- ==================================================== ERP 119.3 restore ===

create table if not exists public.erp119_restore (
  stage_id uuid primary key,
  workspace_id uuid not null references auth.users (id) on delete cascade,
  operation_id text not null,
  state text not null default 'staging',   -- staging | staged | committed | aborted
  expected integer not null,
  received integer not null default 0,
  epoch bigint,
  created_by uuid,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  constraint erp119_restore_state check (state in ('staging', 'staged', 'committed', 'aborted'))
);
create index if not exists erp119_restore_op_idx on public.erp119_restore (workspace_id, operation_id);

create table if not exists public.erp119_restore_rows (
  stage_id uuid not null references public.erp119_restore (stage_id) on delete cascade,
  key text not null,
  value text not null,
  primary key (stage_id, key)
);

create table if not exists public.erp119_kv_archive (
  workspace_id uuid not null references auth.users (id) on delete cascade,
  epoch bigint not null,
  key text not null,
  value text not null,
  revision bigint not null,
  archived_at timestamptz not null default now(),
  primary key (workspace_id, epoch, key)
);

alter table public.erp119_restore enable row level security;
alter table public.erp119_restore_rows enable row level security;
alter table public.erp119_kv_archive enable row level security;
revoke all on public.erp119_restore, public.erp119_restore_rows, public.erp119_kv_archive
  from anon, authenticated;

create or replace function public.erp119_restore_owner()
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  ws uuid := public.workspace_of();
begin
  if ws is null or not public.erp119_access() or not public.is_workspace_owner() then
    raise exception 'erp119: only the workspace owner restores a backup' using errcode = '42501';
  end if;
  return ws;
end;
$$;
revoke all on function public.erp119_restore_owner() from public, anon, authenticated;

create or replace function public.erp119_restore_begin(p_stage uuid, p_operation text, p_expected integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
begin
  if p_expected is null or p_expected < 1 or p_expected > 20000 then
    raise exception 'erp119: bad backup size' using errcode = '22023';
  end if;
  -- Abandoned uploads of this workspace go.
  delete from public.erp119_restore
  where workspace_id = ws and state in ('staging', 'staged') and created_at < now() - interval '1 day';
  insert into public.erp119_restore (stage_id, workspace_id, operation_id, expected, created_by)
  values (p_stage, ws, left(p_operation, 100), p_expected, auth.uid());
  return jsonb_build_object('stage_id', p_stage);
end;
$$;

create or replace function public.erp119_restore_rows(p_stage uuid, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
  n integer;
begin
  if not exists (select 1 from public.erp119_restore
                 where stage_id = p_stage and workspace_id = ws and state = 'staging') then
    raise exception 'erp119: no such upload' using errcode = '22023';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) > 500 then
    raise exception 'erp119: bad entries' using errcode = '22023';
  end if;
  insert into public.erp119_restore_rows (stage_id, key, value)
  select p_stage, e ->> 'key', e ->> 'value'
  from jsonb_array_elements(p_entries) e
  where char_length(coalesce(e ->> 'key', '')) between 1 and 1000
    and jsonb_typeof(e -> 'value') = 'string'
  on conflict (stage_id, key) do update set value = excluded.value;
  select count(*) into n from public.erp119_restore_rows where stage_id = p_stage;
  update public.erp119_restore set received = n where stage_id = p_stage;
  return jsonb_build_object('received', n);
end;
$$;

create or replace function public.erp119_restore_verify(p_stage uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
  r public.erp119_restore;
begin
  select * into r from public.erp119_restore where stage_id = p_stage and workspace_id = ws for update;
  if r.stage_id is null then
    raise exception 'erp119: no such upload' using errcode = '22023';
  end if;
  if r.state = 'staging' and r.received = r.expected then
    update public.erp119_restore set state = 'staged' where stage_id = p_stage;
    r.state := 'staged';
  end if;
  return jsonb_build_object('verified', r.state = 'staged', 'received', r.received, 'expected', r.expected);
end;
$$;

create or replace function public.erp119_restore_commit(p_stage uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
  r public.erp119_restore;
  old_epoch bigint;
  dev text := 'restore';
begin
  select * into r from public.erp119_restore where stage_id = p_stage and workspace_id = ws for update;
  if r.stage_id is null or r.state <> 'staged' then
    raise exception 'erp119: backup is not verified' using errcode = '22023';
  end if;

  insert into public.erp119_workspace (workspace_id) values (ws) on conflict do nothing;
  -- Exclusive: no erp119_put runs while the data is swapped.
  select epoch into old_epoch from public.erp119_workspace where workspace_id = ws for update;

  insert into public.erp119_kv_archive (workspace_id, epoch, key, value, revision)
  select workspace_id, old_epoch, key, value, revision from public.erp119_kv where workspace_id = ws
  on conflict (workspace_id, epoch, key) do update set value = excluded.value, revision = excluded.revision;

  -- Keys the backup does not have are gone from the restored workspace.
  with gone as (
    delete from public.erp119_kv k
    where k.workspace_id = ws
      and not exists (select 1 from public.erp119_restore_rows s where s.stage_id = p_stage and s.key = k.key)
    returning k.key
  )
  insert into public.erp119_head (workspace_id, key, revision, deleted, updated_by, device)
  select ws, gone.key, nextval('public.erp119_revision_seq'), true, auth.uid(), dev from gone
  on conflict (workspace_id, key) do update
    set revision = excluded.revision, deleted = true, updated_at = now(),
        updated_by = excluded.updated_by, device = excluded.device;

  with put as (
    insert into public.erp119_kv (workspace_id, key, value, revision, updated_by, device)
    select ws, s.key, s.value, nextval('public.erp119_revision_seq'), auth.uid(), dev
    from public.erp119_restore_rows s where s.stage_id = p_stage
    on conflict (workspace_id, key) do update
      set value = excluded.value, revision = excluded.revision, updated_at = now(),
          updated_by = excluded.updated_by, device = excluded.device
    returning key, revision
  )
  insert into public.erp119_head (workspace_id, key, revision, deleted, updated_by, device)
  select ws, put.key, put.revision, false, auth.uid(), dev from put
  on conflict (workspace_id, key) do update
    set revision = excluded.revision, deleted = false, updated_at = now(),
        updated_by = excluded.updated_by, device = excluded.device;

  update public.erp119_workspace set epoch = old_epoch + 1, seeded_at = coalesce(seeded_at, now())
  where workspace_id = ws;
  update public.erp119_restore set state = 'committed', committed_at = now(), epoch = old_epoch + 1
  where stage_id = p_stage;
  delete from public.erp119_restore_rows where stage_id = p_stage;

  insert into public.audit_events (actor_id, action, target_id, service, details)
  values (auth.uid(), 'erp.restore', ws, 'erp',
          jsonb_build_object('operation_id', r.operation_id, 'keys', r.expected,
                             'archived_epoch', old_epoch, 'epoch', old_epoch + 1));

  return jsonb_build_object('epoch', old_epoch + 1, 'archived_epoch', old_epoch);
end;
$$;

create or replace function public.erp119_restore_status(p_operation text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
  r public.erp119_restore;
begin
  select * into r from public.erp119_restore
  where workspace_id = ws and operation_id = p_operation
  order by created_at desc limit 1;
  if r.stage_id is null then
    return jsonb_build_object('state', 'none');
  end if;
  return jsonb_build_object('state', r.state, 'epoch', r.epoch, 'stage_id', r.stage_id);
end;
$$;

create or replace function public.erp119_restore_abort(p_stage uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.erp119_restore_owner();
begin
  update public.erp119_restore set state = 'aborted'
  where stage_id = p_stage and workspace_id = ws and state in ('staging', 'staged');
  delete from public.erp119_restore_rows where stage_id = p_stage;
  return jsonb_build_object('aborted', true);
end;
$$;

revoke all on function public.erp119_restore_begin(uuid, text, integer) from public, anon;
revoke all on function public.erp119_restore_rows(uuid, jsonb) from public, anon;
revoke all on function public.erp119_restore_verify(uuid) from public, anon;
revoke all on function public.erp119_restore_commit(uuid) from public, anon;
revoke all on function public.erp119_restore_status(text) from public, anon;
revoke all on function public.erp119_restore_abort(uuid) from public, anon;
grant execute on function public.erp119_restore_begin(uuid, text, integer) to authenticated;
grant execute on function public.erp119_restore_rows(uuid, jsonb) to authenticated;
grant execute on function public.erp119_restore_verify(uuid) to authenticated;
grant execute on function public.erp119_restore_commit(uuid) to authenticated;
grant execute on function public.erp119_restore_status(text) to authenticated;
grant execute on function public.erp119_restore_abort(uuid) to authenticated;

-- ============================================================ realtime ===

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'erp119_chat_head'
     ) then
    execute 'alter publication supabase_realtime add table public.erp119_chat_head';
  end if;
end
$$;
