#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s https://github.com/ACCOUNT/REPOSITORY.git\n' "$0" >&2
  exit 1
fi

repository_url=$1
case "$repository_url" in
  https://github.com/*.git|git@github.com:*.git) ;;
  *) printf 'Provide a valid HTTPS or SSH GitHub repository URL.\n' >&2; exit 1 ;;
esac

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_root"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -b main
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$repository_url"
else
  git remote add origin "$repository_url"
fi

git add .
if ! git diff --cached --quiet; then
  git commit -m 'feat: production-ready Smart Retail ERP 21 CRM and receivables'
fi

git push --set-upstream origin main
printf 'Repository published successfully: %s\n' "$repository_url"
