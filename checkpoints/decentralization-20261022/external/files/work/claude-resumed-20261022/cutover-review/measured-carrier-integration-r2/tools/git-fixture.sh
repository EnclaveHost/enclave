#!/usr/bin/env bash
# git-fixture.sh <test tree root>: an ISOLATED local repository at <root>/.git (a new directory in the throwaway test tree; no
# existing git metadata is read for writing or changed) whose HEAD commit holds exactly ONE file:
#   metal/guest/gsup.mjs = git-fixture/gsup.e762a9c5.mjs, the blob 7bfd5052 that `git show HEAD:metal/guest/gsup.mjs` returned in
#   work/enclave (HEAD e762a9c5), where test/metal-measured-control.test.mjs and measured-control.mjs were written (both untracked
#   there; gsup.mjs modified). The test's `git show HEAD:metal/guest/gsup.mjs` therefore reads the same baseline it was written
#   against, and its assertion runs unchanged.
set -euo pipefail; T="$1"; P=$(cd "$(dirname "$0")/.." && pwd)
[ -e "$T/.git" ] || [ -L "$T/.git" ] && { echo "$T/.git already exists"; exit 1; }
export GIT_DIR="$T/.git" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0
export GIT_AUTHOR_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_NAME=SteveDeFacto GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com
export GIT_AUTHOR_DATE=2026-10-21T00:00:00Z GIT_COMMITTER_DATE=2026-10-21T00:00:00Z
git init -q
blob=$(git hash-object -w "$P/git-fixture/gsup.e762a9c5.mjs")
[ "$blob" = 7bfd50520ec527a2cba9a1b5fc247bca05e1fc2a ] || { echo "baseline blob $blob is not e762a9c5:metal/guest/gsup.mjs"; exit 1; }
t1=$(printf '100644 blob %s\tgsup.mjs\n' "$blob" | git mktree); t2=$(printf '040000 tree %s\tguest\n' "$t1" | git mktree); t3=$(printf '040000 tree %s\tmetal\n' "$t2" | git mktree)
c=$(git commit-tree "$t3" -m "test fixture: metal/guest/gsup.mjs as at work/enclave e762a9c5 (blob 7bfd5052)")
git update-ref refs/heads/fixture "$c"; git symbolic-ref HEAD refs/heads/fixture
[ "$(git show HEAD:metal/guest/gsup.mjs | sha256sum | cut -c1-64)" = e0dd6af1e3bcd240e449241c63263d06be0ad450d71532cb6afbcaf98f05dd0c ] || { echo "fixture HEAD does not serve the baseline"; exit 1; }
echo "git fixture: HEAD $c tree $t3 blob $blob"
