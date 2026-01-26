#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose exec -T postgres pg_dump \
  --clean --if-exists \
  -U claude -d claude_assist \
| gzip --rsyncable \
| docker run --rm -i \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/credentials/gcp-service-account.json \
  -v "$(pwd)/gcp-service-account.json:/credentials/gcp-service-account.json:ro" \
  restic/restic backup \
    --host claude-assist \
    --stdin \
    --stdin-filename claude-assist.sql.gz
