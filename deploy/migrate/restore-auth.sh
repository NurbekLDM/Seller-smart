#!/bin/sh
#
# Load ONLY the accounts (auth.users + auth.identities, password hashes
# included) from a dump made by dump.sh, when the public data is already on
# this server but the accounts are missing:
#
#   sudo sh deploy/migrate/restore-auth.sh /root/sr-dump
#
# Refuses to run when auth.users already holds rows. One transaction; it
# checks inside that every staged row was inserted and that every profile now
# has its account, otherwise nothing is kept.

set -eu

DUMP=${1:-}
[ -n "$DUMP" ] && [ -f "$DUMP/auth-users.csv" ] && [ -f "$DUMP/auth-identities.csv" ] \
    || { echo "Usage: $0 <dump-dir>" >&2; exit 1; }
DUMP=$(cd "$DUMP" && pwd)
DB=${DB_CONTAINER:-supabase-db}

psql_db() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }

users=$(psql_db -Atc "select count(*) from auth.users")
if [ "$users" != "0" ]; then
    echo "ERROR: auth.users already has $users rows; nothing done." >&2
    exit 1
fi

staging_ddl() {
    head -n1 "$1" | tr -d '\r' | tr ',' '\n' | sed 's/^"//; s/"$//' \
        | awk -v t="$2" 'BEGIN { printf "create table migrate_staging.%s (", t } { printf "%s\"%s\" text", (NR>1?", ":""), $0 } END { print ");" }'
}

load_by_name() { cat <<SQL
do \$\$
declare
  cols text; sel text; lost text; hit int; staged bigint; loaded bigint;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(format('s.%I::%s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' order by a.attnum)
    into cols, sel
  from pg_attribute a
  where a.attrelid = 'auth.$1'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and exists (select 1 from information_schema.columns c
                where c.table_schema = 'migrate_staging' and c.table_name = '$1' and c.column_name = a.attname);
  for lost in
    select c.column_name from information_schema.columns c
    where c.table_schema = 'migrate_staging' and c.table_name = '$1'
      and not exists (select 1 from pg_attribute a where a.attrelid = 'auth.$1'::regclass
                      and a.attname = c.column_name and not a.attisdropped)
  loop
    execute format('select 1 from migrate_staging.%I where %I is not null limit 1', '$1', lost) into hit;
    if hit is not null then raise exception 'auth.$1.% holds data but does not exist on this server', lost; end if;
    raise notice 'auth.$1.% skipped (absent here, empty in the source)', lost;
  end loop;
  execute format('insert into auth.$1 (%s) select %s from migrate_staging.$1 s', cols, sel);
  execute 'select count(*) from migrate_staging.$1' into staged;
  execute 'select count(*) from auth.$1' into loaded;
  if staged = 0 or loaded <> staged then
    raise exception 'auth.$1: staged % rows, loaded %', staged, loaded;
  end if;
  raise notice 'auth.$1: % rows loaded', loaded;
end
\$\$;
SQL
}

LOCAL_SQL=$(mktemp)
{
    echo "begin;"
    echo "create schema migrate_staging;"
    staging_ddl "$DUMP/auth-users.csv" users
    staging_ddl "$DUMP/auth-identities.csv" identities
    # printf, not echo: dash's echo reads "\c" as "stop output" and drops the line.
    printf '%s\n' "\\copy migrate_staging.users from '/tmp/sr-auth-users.csv' with (format csv, header true)"
    printf '%s\n' "\\copy migrate_staging.identities from '/tmp/sr-auth-identities.csv' with (format csv, header true)"
    load_by_name users
    load_by_name identities
    echo "drop schema migrate_staging cascade;"
    cat <<'SQL'
do $$
declare orphans bigint;
begin
  select count(*) into orphans from public.profiles p
  where not exists (select 1 from auth.users u where u.id = p.id);
  if orphans > 0 then raise exception '% profiles still have no account', orphans; end if;
end
$$;
SQL
    echo "commit;"
} > "$LOCAL_SQL"

docker cp "$DUMP/auth-users.csv" "$DB:/tmp/sr-auth-users.csv"
docker cp "$DUMP/auth-identities.csv" "$DB:/tmp/sr-auth-identities.csv"
docker cp "$LOCAL_SQL" "$DB:/tmp/sr-restore-auth.sql"
status=0
psql_db -q -f /tmp/sr-restore-auth.sql || status=$?
docker exec "$DB" rm -f /tmp/sr-auth-users.csv /tmp/sr-auth-identities.csv /tmp/sr-restore-auth.sql
rm -f "$LOCAL_SQL"
[ "$status" = "0" ] || { echo "ERROR: nothing was changed (see the message above)." >&2; exit 1; }

psql_db -c "select (select count(*) from auth.users) as users, (select count(*) from auth.identities) as identities, (select count(*) from public.profiles) as profiles"
echo "Accounts restored."
