#!/usr/bin/env bash
# Fake spawn command for tests: reads the preload-prompt file passed as its
# final argument and prints a fake takeover link. Stands in for a real RC
# spawn so the suite never touches real session tooling.
set -euo pipefail

preload_file="${!#}" # last positional argument
if [[ -r "$preload_file" ]]; then
  echo "warming session with preload from ${preload_file}"
fi
echo "session ready"
echo "https://example.test/rc/session_FAKE"
