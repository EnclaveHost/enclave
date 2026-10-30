#!/bin/bash
# retention_activate.sh (base-retention-stage/activation-r2; PREPARED by 50cf; Claude never ran it). ROOT, inside the guest, by hand:
#   install         copy guard + pinned preflight -> /opt/enclave-rpc/retention/, unit -> /etc/systemd/system/ (sha-checked against this
#                   stage's SHA256SUMS; an existing DIFFERENT file refuses; nothing else is touched), then daemon-reload
#   check           read-only guard (pre): exit 0 admitted, 3 refused
#   start           check; save a copy of data/reth.toml (once, never overwritten); start the retention unit (no-block). The unit's
#                   Conflicts=enclave-base-holder.service guarantees the holder and this download never run together. Refuses on any failure.
#   status          retention/first/holder unit states + missing/partial archives + markers (read-only)
#   stop            stop the retention unit (SIGTERM, then SIGKILL after 120 s), then status. Deletes NOTHING (the datadir may hold a
#                   partial archive: reported); re-run `start` to resume (reth --resumable reuses verified outputs). The holder stays
#                   DISABLED; starting it is a separate root decision (its wrapper re-checks history coverage).
set -uo pipefail
export PATH=/usr/bin:/bin
HERE=$(cd "$(dirname "$0")" && pwd); D=/opt/enclave-rpc/retention; U=enclave-base-retention.service
ROOT=/srv/enclave-base-holder
die() { echo "REFUSED: $*" >&2; exit 3; }
[ "$(id -u)" = 0 ] || die "root only"
case "${1:-}" in
  install)
    (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
    install -d -o root -g root -m 0755 $D || die "dir"
    for f in retention_guard.py:$D/retention_guard.py cached_download_preflight.py:$D/cached_download_preflight.py $U:/etc/systemd/system/$U; do
      src=$HERE/${f%%:*}; dst=${f#*:}
      if [ -e "$dst" ]; then cmp -s "$src" "$dst" && { echo "identical $dst"; continue; } || die "$dst exists with other bytes (review by hand)"; fi
      install -o root -g root -m 0644 "$src" "$dst" || die "install $dst"; echo "installed $dst"
    done
    systemctl daemon-reload ;;
  check)
    /usr/bin/python3 -I $D/retention_guard.py pre ;;
  start)
    st=$(systemctl show --property=ActiveState --value $U) || die "cannot read $U state"   # r2: a running oneshot is 'activating'
    case "$st" in inactive|failed) ;; *) die "$U is busy or in an unexpected state: '$st'";; esac
    /usr/bin/python3 -I $D/retention_guard.py pre || die "guard refused (see JSON above)"
    if [ ! -e $ROOT/retention-backup/reth.toml ]; then
      install -d -o root -g root -m 0700 $ROOT/retention-backup && cp -p --no-clobber $ROOT/data/reth.toml $ROOT/retention-backup/reth.toml \
        && sha256sum $ROOT/retention-backup/reth.toml > $ROOT/retention-backup/reth.toml.sha256 || die "reth.toml backup"
    fi
    systemctl start --no-block $U || die "start $U"
    systemctl show --property=ActiveState,SubState $U ;;
  status)
    systemctl show --property=ActiveState,SubState,Result,ExecMainStatus $U
    /usr/bin/python3 -I $D/retention_guard.py status ;;
  stop)
    systemctl stop $U; echo "stop rc=$?"
    systemctl show --property=ActiveState,SubState,Result $U
    /usr/bin/python3 -I $D/retention_guard.py status
    echo "NOTE: nothing deleted; the holder stays disabled; resume with: $0 start" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
