#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
backup_directory=${1:-"$project_root/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_directory"

if docker compose -f "$project_root/docker-compose.yml" ps --status running app --format json 2>/dev/null | grep -q 'app'; then
  docker compose -f "$project_root/docker-compose.yml" exec -T app \
    node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/smart-retail.sqlite');db.exec(\"VACUUM INTO '/tmp/smart-retail-backup.sqlite'\");db.close()"
  docker compose -f "$project_root/docker-compose.yml" cp app:/tmp/smart-retail-backup.sqlite "$backup_directory/smart-retail-$timestamp.sqlite"
  docker compose -f "$project_root/docker-compose.yml" exec -T app rm -f /tmp/smart-retail-backup.sqlite
else
  database_file=${DATABASE_PATH:-"$project_root/data/smart-retail.sqlite"}
  if [[ ! -f "$database_file" ]]; then
    printf 'Database file does not exist: %s\n' "$database_file" >&2
    exit 1
  fi
  node - "$database_file" "$backup_directory/smart-retail-$timestamp.sqlite" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.argv[2]);
const target = process.argv[3].replace(/'/g, "''");
database.exec(`VACUUM INTO '${target}'`);
database.close();
NODE
fi

chmod 600 "$backup_directory/smart-retail-$timestamp.sqlite"
printf 'Backup created: %s\n' "$backup_directory/smart-retail-$timestamp.sqlite"
