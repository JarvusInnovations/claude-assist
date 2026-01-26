#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker run --rm \
  --env-file .env \
  -e GOOGLE_APPLICATION_CREDENTIALS=/credentials/gcp-service-account.json \
  -v "$(pwd)/gcp-service-account.json:/credentials/gcp-service-account.json:ro" \
  restic/restic init
