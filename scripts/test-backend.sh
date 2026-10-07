#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/workly-backend-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT

# Keep development event logs from tests out of the real workspace.
# Every test creates its own in-memory SQLite database; no server is started.
cd "$test_dir"
cargo test --manifest-path "$project_root/backend/Cargo.toml" "$@"
