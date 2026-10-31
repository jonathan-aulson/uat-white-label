#!/usr/bin/env bash
set -euo pipefail
# Usage: scripts/backup.sh <client-slug>   (remote; run only for an authorised deployment)
# Restore: npx wrangler d1 execute uat-<slug> --remote --config wrangler.<slug>.jsonc --file backups/<file>.sql
# After a restore, re-apply the redaction ledger (redactions-*.json) so redacted text is not resurrected.
umask 077
slug="${1:?client slug required}"
cd "$(dirname "$0")/.."
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cfg="wrangler.${slug}.jsonc"
npx wrangler d1 export "uat-${slug}" --config "$cfg" --remote --output "backups/${slug}-${stamp}.sql"
npx wrangler d1 execute "uat-${slug}" --config "$cfg" --remote --command "SELECT ts,action,target FROM audit WHERE action LIKE 'redact%' ORDER BY id" --json > "backups/${slug}-redactions-${stamp}.json"
printf 'Backup: backups/%s-%s.sql\n' "$slug" "$stamp"
