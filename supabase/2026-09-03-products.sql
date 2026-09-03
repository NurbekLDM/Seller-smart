-- Migration 2026-09-03 — products per account.
--
-- The platform is two products sold separately: 'analytics' (the Uzum
-- analytics page, /) and 'erp' (Smart Retail ERP, /erp.html). Until now
-- every owner account got both. The /admin dashboard can now enable one
-- or both per account:
--
--   analytics only  → lands on /, the ERP entry is gone from its menu
--   erp only        → lands on /erp.html, never sees the analytics page
--   both            → exactly what every account has today
--
-- Staff accounts inherit their owner's products; an owner without the ERP
-- has no staff to speak of, so is_active_user() treats theirs as inactive.
--
-- Enforced where it matters — the database — not only by which page a
-- browser is sent to: the workspace_kv policies and a row trigger refuse
-- the other product's data. The analytics page keeps its whole state in
-- ONE key (srerp_analytics_parent_state); every other key in the synced
-- key space belongs to the ERP.
--
-- Safe to run on a live database: adds a column with a default that keeps
-- every existing account exactly as it is, three functions, one trigger,
-- and re-creates the four workspace_kv policies with one extra condition.
-- Re-runnable. Run BEFORE deploying the build that carries the /admin
-- product controls; the pages tolerate a database without the column
-- (they grant both), so the other order also works, but the dashboard's
-- product buttons would fail until this has run.

-- ------------------------------------------------------------ column ------

alter table public.profiles add column if not exists products text[]
  not null default array['analytics', 'erp']::text[];
alter table public.profiles drop constraint if exists profiles_products_known;
alter table public.profiles add constraint profiles_products_known
  check (products <@ array['analytics', 'erp']::text[]);

-- --------------------------------------------------------- functions ------

-- Staff are active only while their owner still has the ERP.
create or replace function public.is_active_user()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select p.active
       and (p.expires_at is null or p.expires_at > now())
       and (p.workspace_owner is null or exists (
              select 1 from public.profiles o
              where o.id = p.workspace_owner
                and o.active
                and (o.expires_at is null or o.expires_at > now())
                and 'erp' = any(o.products)))
    from public.profiles p where p.id = auth.uid()
  ), false);
$$;

-- Which product a workspace key belongs to.
create or replace function public.key_product(k text)
returns text
language sql
immutable
as $$
  select case when k = 'srerp_analytics_parent_state' then 'analytics' else 'erp' end;
$$;

-- Whether the OWNER of a workspace holds a product. Keyed by workspace so
-- it answers the same for the owner and for their staff.
create or replace function public.workspace_has_product(ws uuid, product text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select product = any(p.products) from public.profiles p where p.id = ws), false);
$$;

-- The caller's products: their own, or their owner's (staff). Staff cannot
-- read their owner's profile row, so this is how the ERP page learns them.
create or replace function public.my_products()
returns text[]
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select o.products
    from public.profiles p
    join public.profiles o on o.id = coalesce(p.workspace_owner, p.id)
    where p.id = auth.uid()
  ), '{}'::text[]);
$$;
revoke all on function public.my_products() from public, anon;
grant execute on function public.my_products() to authenticated;

-- ---------------------------------------------------- workspace_kv --------

/* Reads: a key is visible only if the workspace holds its product. The
   ERP page never asks for the analytics key and the analytics page simply
   receives fewer rows, so no client sees an error — it sees only what
   was bought. */
drop policy if exists workspace_kv_select on public.workspace_kv;
create policy workspace_kv_select on public.workspace_kv
  for select to authenticated
  using (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and public.workspace_has_product(workspace_id, public.key_product(key))
  );

drop policy if exists workspace_kv_insert on public.workspace_kv;
create policy workspace_kv_insert on public.workspace_kv
  for insert to authenticated
  with check (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
    and public.workspace_has_product(workspace_id, public.key_product(key))
  );

drop policy if exists workspace_kv_update on public.workspace_kv;
create policy workspace_kv_update on public.workspace_kv
  for update to authenticated
  using (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
    and public.workspace_has_product(workspace_id, public.key_product(key))
  )
  with check (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
    and public.workspace_has_product(workspace_id, public.key_product(key))
  );

drop policy if exists workspace_kv_delete on public.workspace_kv;
create policy workspace_kv_delete on public.workspace_kv
  for delete to authenticated
  using (
    workspace_id = public.workspace_of()
    and public.is_active_user()
    and (key <> 'srerp_analytics_parent_state' or public.is_workspace_owner())
    and public.workspace_has_product(workspace_id, public.key_product(key))
  );

/* Writes reach the table through save_workspace_kv() and
   save_workspace_kv_delta(), which are SECURITY DEFINER and therefore
   bypass the policies above. A row trigger applies the same rule to
   every path — those two, the plain upsert fallback, the version restore
   and the one-off cutover. A legitimate client never trips it: the pages
   refuse to open the product that was not bought. */
create or replace function public.workspace_kv_guard_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.workspace_has_product(new.workspace_id, public.key_product(new.key)) then
    raise exception 'product_not_enabled: % for workspace %', public.key_product(new.key), new.workspace_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_kv_guard_product_trg on public.workspace_kv;
create trigger workspace_kv_guard_product_trg
  before insert or update on public.workspace_kv
  for each row execute function public.workspace_kv_guard_product();

-- ------------------------------------------------------------- notes ------
-- Narrow an account to one product by hand (the /admin page does this):
--   update public.profiles set products = '{analytics}' where id = '...';
--   update public.profiles set products = '{erp}'       where id = '...';
-- Give both back:
--   update public.profiles set products = '{analytics,erp}' where id = '...';
