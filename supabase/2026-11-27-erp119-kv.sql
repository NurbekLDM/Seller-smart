-- Migration 2026-11-27 — server storage for SellerSmart ERP 119.3
-- (erp.<domain>), kept apart from the live ERP's workspace_kv.
--
-- Why a separate table: ERP 119.3 and the live ERP (sellersmart.uz/erp)
-- share the srerp_* key names, but 119.3 migrates several of them to newer
-- formats on start. Writing both into workspace_kv would let 119.3 rewrite
-- records the older ERP still reads. 119.3 therefore gets its own copy,
-- seeded once per workspace from workspace_kv (erp119_seed), and the live
-- ERP is not touched. When everyone has moved to 119.3, workspace_kv can be
-- retired.
--
-- Model:
--   erp119_kv          one row per key: the exact string the ERP stored in
--                      localStorage, or a packed IndexedDB database under
--                      an "idb:<id>" key. revision is a global sequence.
--   erp119_head        key + revision only, published to Realtime so other
--                      devices learn about a change without receiving
--                      megabytes of value.
--   erp119_kv_history  the previous value of every overwritten or deleted
--                      key (last 10 per key), so a lost-update merge can
--                      always be undone by hand.
--   erp119_workspace   per-workspace bookkeeping (when it was seeded).
--
-- Clients only READ erp119_kv directly (RLS); every write goes through
-- erp119_put(), which checks the caller's base revision per key and
-- reports conflicts instead of overwriting.
--
-- Depends on schema.sql (workspace_of, is_active_user, is_workspace_owner)
-- and 2026-09-01-workspace-kv.sql (seed source). Re-runnable.

create sequence if not exists public.erp119_revision_seq;

create table if not exists public.erp119_kv (
  workspace_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text not null,
  revision bigint not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  device text,
  primary key (workspace_id, key),
  constraint erp119_kv_key_format check (char_length(key) between 1 and 1000)
);

create table if not exists public.erp119_head (
  workspace_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  revision bigint not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  device text,
  primary key (workspace_id, key)
);

create table if not exists public.erp119_kv_history (
  id bigserial primary key,
  workspace_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text not null,
  revision bigint not null,
  replaced_at timestamptz not null default now(),
  replaced_by uuid
);

create index if not exists erp119_kv_history_key_idx
  on public.erp119_kv_history (workspace_id, key, id desc);

create table if not exists public.erp119_workspace (
  workspace_id uuid primary key references auth.users (id) on delete cascade,
  seeded_at timestamptz,
  seeded_keys integer,
  created_at timestamptz not null default now()
);

alter table public.erp119_kv enable row level security;
alter table public.erp119_head enable row level security;
alter table public.erp119_kv_history enable row level security;
alter table public.erp119_workspace enable row level security;

-- ----------------------------------------------------------- policies -----

-- Read: every active member of the workspace, as with workspace_kv.
-- No insert/update/delete policies: writes only through erp119_put().
drop policy if exists erp119_kv_select on public.erp119_kv;
create policy erp119_kv_select on public.erp119_kv
  for select to authenticated
  using (workspace_id = public.workspace_of() and public.is_active_user());

drop policy if exists erp119_head_select on public.erp119_head;
create policy erp119_head_select on public.erp119_head
  for select to authenticated
  using (workspace_id = public.workspace_of() and public.is_active_user());

-- History is for the owner only (it can hold values staff may not edit).
drop policy if exists erp119_kv_history_select on public.erp119_kv_history;
create policy erp119_kv_history_select on public.erp119_kv_history
  for select to authenticated
  using (workspace_id = public.workspace_of()
         and public.is_active_user()
         and public.is_workspace_owner());

revoke insert, update, delete on public.erp119_kv, public.erp119_head,
  public.erp119_kv_history, public.erp119_workspace from anon, authenticated;
grant select on public.erp119_kv, public.erp119_head, public.erp119_kv_history
  to authenticated;

-- ------------------------------------------------------------ history -----

create or replace function public.erp119_kv_keep_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' or new.value is distinct from old.value then
    insert into public.erp119_kv_history (workspace_id, key, value, revision, replaced_by)
    values (old.workspace_id, old.key, old.value, old.revision, auth.uid());

    delete from public.erp119_kv_history h
    where h.workspace_id = old.workspace_id
      and h.key = old.key
      and h.id not in (
        select id from public.erp119_kv_history
        where workspace_id = old.workspace_id and key = old.key
        order by id desc
        limit 10);
  end if;
  return null;
end;
$$;

drop trigger if exists erp119_kv_history_trg on public.erp119_kv;
create trigger erp119_kv_history_trg
  after update or delete on public.erp119_kv
  for each row execute function public.erp119_kv_keep_history();

-- ------------------------------------------------------------- status -----

-- Who am I to ERP 119.3: workspace, whether the account may use it, and
-- whether the workspace has been seeded.
create or replace function public.erp119_status()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'workspace_id', public.workspace_of(),
    'active', public.is_active_user(),
    'owner', public.is_workspace_owner(),
    'seeded', exists (select 1 from public.erp119_workspace w
                      where w.workspace_id = public.workspace_of()
                        and w.seeded_at is not null),
    'keys', (select count(*) from public.erp119_kv k
             where k.workspace_id = public.workspace_of()),
    'revision', (select coalesce(max(revision), 0) from public.erp119_kv k
                 where k.workspace_id = public.workspace_of())
  );
$$;

-- --------------------------------------------------------------- seed -----

/* One-time copy of the live ERP's data (workspace_kv) into ERP 119.3.
   Runs only while the workspace has no 119.3 data and was never seeded,
   under a per-workspace lock, so two devices opening 119.3 at the same
   moment cannot seed twice. workspace_kv stores the ERP's string either as
   a jsonb string or as parsed JSON; both are turned back into the exact
   text the ERP keeps in localStorage. */
create or replace function public.erp119_seed()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.workspace_of();
  copied integer := 0;
begin
  if ws is null or not public.is_active_user() then
    raise exception 'erp119: account is not active' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('erp119_seed:' || ws::text));

  insert into public.erp119_workspace (workspace_id) values (ws)
  on conflict (workspace_id) do nothing;

  if exists (select 1 from public.erp119_workspace
             where workspace_id = ws and seeded_at is not null)
     or exists (select 1 from public.erp119_kv where workspace_id = ws) then
    return jsonb_build_object('seeded', false, 'copied', 0);
  end if;

  if to_regclass('public.workspace_kv') is not null then
    with src as (
      select k.key,
             case jsonb_typeof(k.value)
               when 'string' then k.value #>> '{}'
               else k.value::text
             end as value
      from public.workspace_kv k
      where k.workspace_id = ws
    ), ins as (
      insert into public.erp119_kv (workspace_id, key, value, revision, updated_by, device)
      select ws, src.key, src.value, nextval('public.erp119_revision_seq'), auth.uid(), 'seed'
      from src
      where src.value is not null
      returning key, revision
    ), head as (
      insert into public.erp119_head (workspace_id, key, revision, updated_by, device)
      select ws, ins.key, ins.revision, auth.uid(), 'seed' from ins
      on conflict (workspace_id, key) do update
        set revision = excluded.revision, deleted = false,
            updated_at = now(), updated_by = excluded.updated_by, device = 'seed'
      returning 1
    )
    select count(*) into copied from head;
  end if;

  update public.erp119_workspace
  set seeded_at = now(), seeded_keys = copied
  where workspace_id = ws;

  return jsonb_build_object('seeded', true, 'copied', copied);
end;
$$;

-- ---------------------------------------------------------------- put -----

/* Write a batch of keys. Each entry:
     { "key": text, "value": text | null (null = delete), "base": bigint | null }
   base is the revision the client last saw for that key (null = it believes
   the key does not exist). A key whose current revision differs is NOT
   written; its current value and revision come back as a conflict so the
   client can merge and retry. Keys are independent: one conflict does not
   stop the others.

   Returns [{ key, status: ok|conflict|forbidden, revision, value? }]. */
create or replace function public.erp119_put(p_entries jsonb, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid := public.workspace_of();
  me uuid := auth.uid();
  is_owner boolean := public.is_workspace_owner();
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
  if ws is null or me is null or not public.is_active_user() then
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

  for entry in select * from jsonb_array_elements(p_entries) loop
    k := entry ->> 'key';
    if k is null or char_length(k) < 1 or char_length(k) > 1000 then
      raise exception 'erp119: bad key' using errcode = '22023';
    end if;
    v := case when entry ? 'value' and jsonb_typeof(entry -> 'value') = 'string'
              then entry ->> 'value' end;
    base := case when jsonb_typeof(entry -> 'base') = 'number'
                 then (entry ->> 'base')::bigint end;

    -- Same rule as workspace_kv: staff never write the owner's Uzum
    -- Analytics state.
    if k = 'srerp_analytics_parent_state' and not is_owner then
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

revoke all on function public.erp119_status() from public, anon;
grant execute on function public.erp119_status() to authenticated;
revoke all on function public.erp119_seed() from public, anon;
grant execute on function public.erp119_seed() to authenticated;
revoke all on function public.erp119_put(jsonb, text) from public, anon;
grant execute on function public.erp119_put(jsonb, text) to authenticated;
revoke all on function public.erp119_kv_keep_history() from public, anon, authenticated;

-- ----------------------------------------------------------- realtime -----

-- Only the small head table is published: subscribers learn "key X is now
-- at revision N" and fetch the value when they need it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'erp119_head'
     ) then
    execute 'alter publication supabase_realtime add table public.erp119_head';
  end if;
end
$$;
