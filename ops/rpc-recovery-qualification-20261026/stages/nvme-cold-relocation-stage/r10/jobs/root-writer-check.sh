#!/bin/bash
# nvme-cold-relocation-stage/r10: ROOT writer-check. NEVER run from the stage: only the fixed `sudo systemd-run --scope ... bash -c` wrapper in README runs it,
# AFTER copying this file, subtree.py and relocate.py (bounded no-follow dd reads) into a NEW root-owned 0700 /run/nvme-cold-wc10.* dir and
# sha256-verifying ALL THREE against the pins written in the wrapper text. Usage (wrapper only): bash STAGED/jobs/root-writer-check.sh STAGED CONFIG
# Root: re-checks the two Python pins on the staged copies, runs python3 -I -B from there (no bytecode read or written; relocate.py
# is loaded by compile+exec of its verified bytes), opens no journal, takes no lock, writes and chowns nothing; JSON on stdout only.
set -euo pipefail
umask 077
SUBTREE_SHA=90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3
RELOCATE_SHA=2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0
[ "$(id -u)" = 0 ] || { printf '%s\n' 'run as root, via the staged wrapper (README)' >&2; exit 2; }
W=${1:?usage: root-writer-check.sh STAGED_DIR CONFIG}; CONFIG=${2:?usage: root-writer-check.sh STAGED_DIR CONFIG}
case "$W" in /run/nvme-cold-wc10.????????) ;; *) printf '%s\n' 'STAGED_DIR must be the wrapper'"'"'s /run/nvme-cold-wc10.* copy' >&2; exit 2;; esac
[ ! -L "$W" ] && [ "$(stat -c '%u %a' -- "$W")" = '0 700' ] || { printf '%s\n' 'staged dir must be root-owned 0700' >&2; exit 2; }
for f in subtree.py relocate.py jobs/root-writer-check.sh; do
  [ ! -L "$W/$f" ] && [ "$(stat -c '%u %F' -- "$W/$f")" = '0 regular file' ] || { printf '%s\n' "staged $f must be a root-owned regular file" >&2; exit 2; }
done
printf '%s  %s\n' "$SUBTREE_SHA" "$W/subtree.py" "$RELOCATE_SHA" "$W/relocate.py" | sha256sum -c --quiet -
AVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)        # 16 GiB host floor + the wrapper's 1 GiB scope
[ "$AVAIL" -ge $((16384 + 1024)) ] || { printf '%s\n' "host MemAvailable ${AVAIL} MiB < 16384 floor + 1024 scan cap: not starting" >&2; exit 2; }
printf 'fs.protected_symlinks=%s fs.protected_hardlinks=%s\n' "$(cat /proc/sys/fs/protected_symlinks)" "$(cat /proc/sys/fs/protected_hardlinks)" >&2
cd /
exec env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -I -B "$W/subtree.py" writer-check --config "$CONFIG"
