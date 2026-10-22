#!/usr/bin/env bash
# The metal-measured-control "gsup" test, by name only, on the unmodified base (eaea7e46 worktree) and on the work tree:
# shows whether its failure is pre-existing. Offline, denial stubs proved. Immutable.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; done
echo "[job] ssh/scp/sftp -> denial stubs"
for tree in base-eaea7e46 repo; do
  echo "[job] ===== $tree $(git -C "$HERE/$tree" rev-parse HEAD) dirty=$(git -C "$HERE/$tree" status --short metal/guest/gsup.mjs | wc -l)"
  (cd "$HERE/$tree" && unshare -r -n bash -c 'ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^gsup: the legacy path" test/metal-measured-control.test.mjs' 2>&1)
  echo "[job] $tree exit=$?"
done
exit 0
