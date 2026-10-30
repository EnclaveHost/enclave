#!/bin/bash
# nvme-cold-relocation-stage/r8: ROOT writer-check handoff (FROZEN in this stage's SHA256SUMS; not generated at run time).
# As the OWNER (the redirect creates RESULT as the owner; root writes only to stdout):
#   sudo bash <stage>/r8/jobs/root-writer-check.sh CONFIG > RESULT.json
#   python3 -I <stage>/r8/subtree.py record-writer-check --config CONFIG --result RESULT.json
# Root: copies subtree.py + relocate.py into a NEW root-owned 0700 dir under /run, checks THE FROZEN sha256 below on the copies
# (no check-then-use gap on uid-1000 paths), runs python3 -I -B from there (no bytecode read or written; relocate.py is loaded
# by compile+exec of its verified bytes), opens no journal, takes no lock, writes and chowns nothing. Records two sysctls on stderr.
set -euo pipefail
SUBTREE_SHA=4509e043e51746fa60b873c2e6e824ff8834232bae8a04a73ad2135975585073
RELOCATE_SHA=2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0
[ "$(id -u)" = 0 ] || { printf '%s\n' 'run with sudo' >&2; exit 2; }
CONFIG=${1:?usage: root-writer-check.sh CONFIG}
SRC=$(cd "$(dirname "$0")/.." && pwd -P)
D=$(mktemp -d /run/nvme-cold-wc.XXXXXXXX)
trap 'rm -rf -- "$D"' EXIT                       # root's own temporary copies only
install -m 0400 -o root -g root -- "$SRC/subtree.py" "$D/subtree.py"
install -m 0400 -o root -g root -- "$SRC/relocate.py" "$D/relocate.py"
printf '%s  %s\n' "$SUBTREE_SHA" "$D/subtree.py" "$RELOCATE_SHA" "$D/relocate.py" | sha256sum -c --quiet
printf 'fs.protected_symlinks=%s fs.protected_hardlinks=%s\n' "$(cat /proc/sys/fs/protected_symlinks)" "$(cat /proc/sys/fs/protected_hardlinks)" >&2
cd /
python3 -I -B "$D/subtree.py" writer-check --config "$CONFIG"
