#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/steven/Documents/Codex/2026-10-18/wo
cd "$ROOT"
node --test --test-name-pattern='preexisting backup' work/relay-backup-collision/before/test/relay-deploy-apply.test.mjs > work/relay-backup-collision/before.log 2>&1 && {
  echo 'ERROR: negative control unexpectedly passed'
  exit 1
}
grep -q 'backup path was deleted' work/relay-backup-collision/before.log
node --test work/relay-backup-collision/candidate/test/relay-deploy-apply.test.mjs
bash work/site-passkey-main-integration/check-main-and-ci.sh
