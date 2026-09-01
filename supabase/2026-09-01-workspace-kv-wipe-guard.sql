-- Migration 2026-09-01 (g) — refuse to empty a populated list in one write.
--
-- Today the warehouse cell map (6 249 rows) was reduced to [] four times.
-- The cause was a client bug: Supabase does not carry a Realtime payload
-- larger than about 1 MB, the store took the missing value as truth, and
-- the ERP wrote the nothing it had read back over the real rows. That bug
-- is fixed, but the shape of the failure is worth guarding against on its
-- own: a browser tab left open on old code could still do it, and the next
-- such bug will not announce itself either.
--
-- No client of this application legitimately turns a list of thousands
-- into an empty one as a side effect. When a shop really does mean it -
-- the ERP's own reset buttons - it can say so through
-- clear_workspace_list(), which is deliberate, owner-only, and audited by
-- the version history like anything else.
--
-- The guard refuses rather than silently ignoring: a write that is dropped
-- without a word is how a shop discovers at closing time that nothing was
-- saved. The client recognises the error, drops that write and re-reads.
--
-- Safe to run on a live database: adds one function and one trigger.
-- Re-runnable.

/* Below this, a list is small enough that clearing it is ordinary - an
   empty basket, a settings array nobody filled in. Above it, emptying in a
   single write is a bug until proven otherwise. */
create or replace function public.workspace_kv_list_length(candidate jsonb)
returns integer
language plpgsql
immutable
as $$
declare
  parsed jsonb;
begin
  if candidate is null then return -1; end if;
  -- Values are stored as the app's own JSON text inside a jsonb string.
  begin
    parsed := (candidate #>> '{}')::jsonb;
  exception when others then
    return -1;   -- not JSON: not a list, nothing to guard
  end;
  if parsed is null or jsonb_typeof(parsed) <> 'array' then return -1; end if;
  return jsonb_array_length(parsed);
end;
$$;

create or replace function public.workspace_kv_guard_wipe()
returns trigger
language plpgsql
as $$
declare
  was integer;
  becomes integer;
begin
  -- An explicit clear says so first; see clear_workspace_list().
  if coalesce(current_setting('sr.allow_list_clear', true), '') = 'on' then
    return new;
  end if;

  was := public.workspace_kv_list_length(old.value);
  becomes := public.workspace_kv_list_length(new.value);

  if was >= 20 and becomes = 0 then
    raise exception
      'list_wipe_refused: % had % entries and the write would leave none', new.key, was
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_kv_guard_wipe_trg on public.workspace_kv;
create trigger workspace_kv_guard_wipe_trg
  before update on public.workspace_kv
  for each row execute function public.workspace_kv_guard_wipe();

/* The deliberate route. Owner-only, and it takes a named version first so
   the state being discarded stays recoverable — the same promise the
   restore panel makes. */
create or replace function public.clear_workspace_list(target_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.workspace_of();
  was integer;
begin
  if uid is null or not public.is_active_user() or not public.is_workspace_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_key !~ '^srerp_[a-zA-Z0-9_-]{1,100}$' then
    raise exception 'bad_key' using errcode = 'P0001';
  end if;

  select public.workspace_kv_list_length(value) into was
    from public.workspace_kv where workspace_id = uid and key = target_key;
  if was is null then return 0; end if;

  perform public.snapshot_workspace_kv('avto: ' || target_key || ' tozalashdan oldin');

  perform set_config('sr.allow_list_clear', 'on', true);   -- this transaction only
  update public.workspace_kv
     set value = to_jsonb('[]'::text)
   where workspace_id = uid and key = target_key;
  perform set_config('sr.allow_list_clear', 'off', true);

  return was;
end;
$$;

revoke all on function public.clear_workspace_list(text) from public, anon;
grant execute on function public.clear_workspace_list(text) to authenticated;
revoke all on function public.workspace_kv_list_length(jsonb) from public, anon;
