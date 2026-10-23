#!/usr/bin/env bash
# recheck.sh: rerun ONLY the read-only release checker (r4.1) on the existing release; no build, no prepare, no release bytes written.
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
CID=bafybeihm7f2mhw6qn5a3lddqfu4bjleqg6zo6jxset7ni4dsiaamhpgqla
[ "$(git -C "$S/src" rev-parse HEAD)" = a942a61fde4a07e6237b859f6ca5f0e1e22e8c33 ] && [ -z "$(git -C "$S/src" status --porcelain)" ] || { echo "src is not clean a942a61fd"; exit 1; }
before=$(cd "$S/release/$CID" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)
EXPECT_COMMIT=a942a61f EXPECT_DIRTY=0 node "$S/tools/release-check.mjs" "$S/release/$CID" "$S/src" "$W/logo-site-hotfix/final" "$S/check" > "$S/logs/recheck.out"
after=$(cd "$S/release/$CID" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)
[ "$before" = "$after" ] || { echo "release tree changed"; exit 1; }
echo "release tree unchanged: $before"; tail -1 "$S/logs/recheck.out"
