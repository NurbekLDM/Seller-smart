#!/bin/sh
#
# Load a dump made by dump.sh into the self-hosted Supabase on this server.
#
#   sudo sh deploy/migrate/restore.sh <dump-dir>
#
# Runs against the supabase-db container as supabase_admin. Refuses to run
# when the target already has tables in public or users in auth, so it can
# never merge into (or overwrite) live data. Everything is loaded in ONE
# transaction: on any error nothing is left half-restored.
#
# auth.users / auth.identities are loaded by column NAME through a staging
# table, so a Supabase Auth version that added or dropped a column between
# the cloud and this server does not break the load (generated columns are
# skipped; a dropped column that held data is reported and stops the load).

set -eu

DUMP=${1:-}
[ -n "$DUMP" ] && [ -f "$DUMP/schema.sql" ] || { echo "Usage: $0 <dump-dir>" >&2; exit 1; }
DUMP=$(cd "$DUMP" && pwd)
DB=${DB_CONTAINER:-supabase-db}

psql_db() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }

echo "===> Checking the target is empty"
tables=$(psql_db -Atc "select count(*) from pg_tables where schemaname = 'public'")
users=$(psql_db -Atc "select count(*) from auth.users")
if [ "$tables" != "0" ] || [ "$users" != "0" ]; then
    echo "ERROR: target is not empty (public tables: $tables, auth users: $users)." >&2
    echo "       Restore only into a fresh instance." >&2
    exit 1
fi

echo "===> Checking extensions"
psql_db -Atc "select extname from pg_extension" | sort > /tmp/sr-target-ext.txt
sed -n '/^# extensions/,/^$/p' "$DUMP/info.txt" | awk 'NF==3 {print $1}' | sort > /tmp/sr-source-ext.txt
missing=$(comm -23 /tmp/sr-source-ext.txt /tmp/sr-target-ext.txt || true)
[ -z "$missing" ] || echo "     not installed here (fine unless schema.sql needs them): $(echo $missing)"

# CREATE TABLE for a staging copy of a CSV: every column text, names from the header.
staging_ddl() {
    head -n1 "$1" | tr -d '\r' | tr ',' '\n' | sed 's/^"//; s/"$//' \
        | awk -v t="$2" 'BEGIN { printf "create table migrate_staging.%s (", t } { printf "%s\"%s\" text", (NR>1?", ":""), $0 } END { print ");" }'
}

# INSERT the staged rows into the auth table by matching column names.
load_by_name() { cat <<SQL
do \$\$
declare
  cols text; sel text; lost text;
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
    execute format('select 1 from migrate_staging.%I where %I is not null limit 1', '$1', lost);
    if found then raise exception 'auth.$1.% holds data but does not exist on this server', lost; end if;
    raise notice 'auth.$1.% skipped (absent here, empty in the source)', lost;
  end loop;
  execute format('insert into auth.$1 (%s) select %s from migrate_staging.$1 s', cols, sel);
end
\$\$;
SQL
}

echo "===> Loading (one transaction)"
{
    echo "begin;"
    echo "set session_replication_role = replica;"   # no triggers / FK checks while loading
    # public already exists on every Supabase instance.
    sed '/^CREATE SCHEMA "public";$/d' "$DUMP/schema.sql"
    echo "create schema migrate_staging;"
    staging_ddl "$DUMP/auth-users.csv" users
    staging_ddl "$DUMP/auth-identities.csv" identities
    echo "\\copy migrate_staging.users from '/tmp/sr-auth-users.csv' with (format csv, header true)"
    echo "\\copy migrate_staging.identities from '/tmp/sr-auth-identities.csv' with (format csv, header true)"
    load_by_name users
    load_by_name identities
    echo "drop schema migrate_staging cascade;"
    cat "$DUMP/data-public.sql"
    echo "set session_replication_role = origin;"
    # Older dumps named trigger functions without a schema.
    echo "set search_path = public, extensions;"
    cat "$DUMP/fixups.sql"
    echo "commit;"
} > /tmp/sr-restore.sql

docker cp "$DUMP/auth-users.csv" "$DB:/tmp/sr-auth-users.csv"
docker cp "$DUMP/auth-identities.csv" "$DB:/tmp/sr-auth-identities.csv"
docker cp /tmp/sr-restore.sql "$DB:/tmp/sr-restore.sql"
psql_db -q -f /tmp/sr-restore.sql
docker exec "$DB" rm -f /tmp/sr-auth-users.csv /tmp/sr-auth-identities.csv /tmp/sr-restore.sql
rm -f /tmp/sr-restore.sql

echo "===> Refreshing PostgREST and Realtime"
psql_db -qc "analyze; notify pgrst, 'reload schema';"
docker restart realtime-dev.supabase-realtime >/dev/null 2>&1 || true

echo "===> Comparing row counts"
fail=0
while IFS="$(printf '\t')" read -r table expected; do
    [ -n "$table" ] || continue
    got=$(psql_db -Atc "select count(*) from $table" 2>/dev/null || echo missing)
    mark="ok"; [ "$got" = "$expected" ] || { mark="MISMATCH"; fail=1; }
    printf '    %-45s %10s %10s  %s\n' "$table" "$expected" "$got" "$mark"
done < "$DUMP/counts.tsv"

if [ "$fail" = "0" ]; then
    echo "Restore complete: every table matches the source."
else
    echo "ERROR: some tables do not match the source (see above)." >&2
    exit 1
fi
