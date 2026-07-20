#!/usr/bin/env bash
# Fake spawn command that fails (non-zero exit) with a stderr reason.
echo "spawn failed: spawn backend unavailable" >&2
exit 3
