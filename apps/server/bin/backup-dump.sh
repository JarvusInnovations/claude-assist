#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Use provided snapshot ID or default to "latest"
SNAPSHOT_ID="${1:-latest}"

docker run --rm -i \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/credentials/gcp-service-account.json \
  -v "$(pwd)/gcp-service-account.json:/credentials/gcp-service-account.json:ro" \
  restic/restic dump \
    "$SNAPSHOT_ID" \
    /claude-assist.sql.gz \
| gunzip
