#!/usr/bin/env bash
# The CLEAN APPEND SEAM for the standalone MCP authority product (NOT composed now: no 73/73 root PASS exists yet).
# Only after a root run of the MCP stage ends `RESULT: PASS` with every EXPECTED-TAP row exact (73 tests, 0 skip/todo/cancelled):
#   append-mcp-seam.sh <root receipt .out> <its sha256>    -> refs/r11/candidate-mcp in THIS private repo (r11 candidate + the r2 patch)
# Refuses: a receipt that is not that exact pinned PASS, a patch that is not r2's pinned file (dccad59c…, per r2 SHA256SUMS), or a patch that does not apply.
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); G="git --git-dir=$R/src.git"
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/standalone-mcp-authority-stage/r2/standalone-mcp-authority-r2.patch
[ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || { echo "receipt is not the pinned file"; exit 2; }
grep -qx 'RESULT: PASS' "$1" && [ "$(grep -c '^  PASS$' "$1")" = 8 ] && ! grep -qE 'INCOMPLETE|FAIL|skipped|SETUP-FAILURE' "$1" || { echo "receipt is not a 73/73 PASS (8 exact rows)"; exit 2; }
[ "$(sha256sum < $P | cut -c1-64)" = "$(sed -n 's/^\([0-9a-f]\{64\}\)  standalone-mcp-authority-r2.patch$/\1/p' $(dirname $P)/SHA256SUMS)" ] || { echo "r2 patch not its pinned bytes"; exit 2; }
export GIT_INDEX_FILE=$(mktemp -u); $G read-tree refs/r11/candidate; $G apply --cached --check $P && $G apply --cached $P; T=$($G write-tree); unset GIT_INDEX_FILE
C=$(GIT_AUTHOR_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_NAME=SteveDeFacto GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_AUTHOR_DATE=2026-10-26T00:00:00Z GIT_COMMITTER_DATE=2026-10-26T00:00:00Z \
  $G commit-tree $T -p refs/r11/candidate -m "compose: append the root-passed standalone MCP authority product (r2 patch $(sha256sum < $P | cut -c1-16))

MCP-Root-Receipt-Sha256: $2")
$G update-ref refs/r11/candidate-mcp $C; echo "refs/r11/candidate-mcp $C (rerun the r11 runner on it: it must then also run the MCP rows)"
