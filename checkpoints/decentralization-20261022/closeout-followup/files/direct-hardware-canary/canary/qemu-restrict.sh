#!/usr/bin/env bash
# qemu-restrict.sh: the canary's cfg.qemu. The PUBLISHED launcher (metal/enclave-metal.mjs) builds every QEMU argument; this
# wrapper changes exactly ONE: the slirp netdev `user,id=net0[,hostfwd=tcp:127.0.0.1:H-:G]...` gets `restrict=on`, so the
# guest can reach NO host address (10.0.2.2 = this host's loopback: production guestd 8095/8096, shielded workers, ...)
# and nothing outside; the explicit loopback hostfwd still works (QEMU: restrict "does not affect explicitly set
# forwarding rules"). DHCP is not needed (the guest's init sets 10.0.2.15 statically). Not measured: the netdev is host
# configuration, not part of the launch digest.
# Refuses (exit 97, QEMU never started) unless there is exactly one -netdev, it matches that shape, and the real QEMU's
# sha256 equals CANARY_REAL_QEMU_SHA256. Then it EXECs the real QEMU (same PID, same process group as the launcher).
# Every invocation's final argv is appended to CANARY_QEMU_ARGV_LOG (paths and flags only; the fw_cfg item is a FILE path).
set -euo pipefail
REAL=${CANARY_REAL_QEMU:-/usr/sbin/qemu-system-x86_64}
die() { echo "qemu-restrict: $*" >&2; exit 97; }
[ -n "${CANARY_REAL_QEMU_SHA256:-}" ] || die "CANARY_REAL_QEMU_SHA256 is not set"
[ "$(sha256sum < "$REAL" | cut -c1-64)" = "$CANARY_REAL_QEMU_SHA256" ] || die "$REAL is not the pinned QEMU"
args=("$@"); n=0
for i in "${!args[@]}"; do
  [ "${args[$i]}" = "-netdev" ] || continue
  n=$((n + 1)); v=${args[$((i + 1))]:-}
  [[ "$v" =~ ^user,id=net0((,hostfwd=tcp:127\.0\.0\.1:[0-9]{1,5}-:[0-9]{1,5})*)$ ]] || die "unexpected -netdev $v"
  args[$((i + 1))]="user,id=net0,restrict=on${BASH_REMATCH[1]}"
done
[ "$n" = 1 ] || die "expected exactly one -netdev, saw $n"
for a in "${args[@]}"; do case "$a" in *restrict=off*|*guestfwd*) die "refusing $a";; esac; done
if [ -n "${CANARY_QEMU_ARGV_LOG:-}" ]; then printf '%s\0' "$REAL" "${args[@]}" >> "$CANARY_QEMU_ARGV_LOG"; printf '\n' >> "$CANARY_QEMU_ARGV_LOG"; fi
exec "$REAL" "${args[@]}"
