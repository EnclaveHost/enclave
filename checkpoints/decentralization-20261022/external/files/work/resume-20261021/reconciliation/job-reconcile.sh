#!/bin/sh
# Reconciled candidate (immutable v1): fresh path inventory -> main tree hash -> reconcile.py -> main tree hash again.
# Writes only reconciliation/ and reconciled-candidate/. Main (work/enclave) is only read (GIT_OPTIONAL_LOCKS=0).
set -e
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/reconciliation; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
export GIT_OPTIONAL_LOCKS=0
treehash() { (cd "$M" && find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o \( -type f -o -type l \) -print0 | sort -z | xargs -0 sha256sum 2>/dev/null); }
treehash > $H/main-before.sha256
python3 $H/path-inventory.py > $H/path-inventory.out
python3 $H/reconcile.py
treehash > $H/main-after.sha256
cmp -s $H/main-before.sha256 $H/main-after.sha256 && echo "MAIN-STABLE-DURING-RECONCILE" || { echo "MAIN MOVED DURING RECONCILE:"; diff $H/main-before.sha256 $H/main-after.sha256 | grep '^[<>]' | awk '{print $3}' | sort -u; exit 4; }
echo RECONCILE-OK
