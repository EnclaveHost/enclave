#!/bin/bash
# Native G2 (DNS 53 as packets) on a REAL kernel with the nft expressions this dev host lacks. ROOT RUNS THIS ONCE, e.g. on
# ca-east (Ubuntu 6.8.0-146, nft 1.0.9). Prepared by e49; never run remotely by e49.
#   sudo bash run.sh [--allow-module-autoload] [--flush-only]
#   --flush-only: ONLY the failover + kernel.mjs conntrack-delete sequence (stage2.sh flush), after root installed
#                 conntrack-tools; refused while conntrack is absent. The full run is not repeated.
# Refuses unless: root; every harness and frozen file matches MANIFEST.sha256 and frozen/SHA256SUMS; MemAvailable >= 200 MiB;
# nft, ip, wg, unshare, nsenter, systemd-run and python3 present; the kernel modules the ruleset needs are already loaded,
# or --allow-module-autoload is given (loading a module is the ONE host-global effect, and only with that flag).
# Then ONE transient unit: MemoryMax=128M (no swap), RuntimeMaxSec=60, CPUQuota=50%, TasksMax=64, running stage2.sh as PID 1
# of private pid+net+mount namespaces. No host interface, firewall table, sysctl, route, namespace bind-mount or file is
# created or changed; WireGuard keys live in the unit's private tmpfs and vanish with it. Output: PASS/FAIL/SKIP lines and
# G2-RC=<n>; exit = that n (or 2 on a refusal).
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
ALLOW=0; MODE=full
for a in "$@"; do case "$a" in --allow-module-autoload) ALLOW=1;; --flush-only) MODE=flush;; *) echo "unknown option $a" >&2; exit 2;; esac; done
refuse(){ echo "REFUSED: $*" >&2; exit 2; }
[ "$(id -u)" = 0 ] || refuse "run as root (the namespaces and the unit need it)"
(cd "$D" && sha256sum --quiet -c MANIFEST.sha256) || refuse "harness files differ from MANIFEST.sha256"
(cd "$D/frozen" && sha256sum --quiet -c SHA256SUMS) || refuse "frozen ruleset files differ from frozen/SHA256SUMS"
avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
[ "$avail" -ge 200 ] || refuse "MemAvailable ${avail} MiB < 200 MiB"
for t in nft ip wg unshare nsenter systemd-run python3 sha256sum; do command -v "$t" >/dev/null || refuse "missing $t"; done
[ "$MODE" = full ] || command -v conntrack >/dev/null || refuse "--flush-only needs conntrack (conntrack-tools) installed first"
[ "$MODE" = full ] || echo "conntrack: $(command -v conntrack) ($(conntrack --version 2>&1 | head -1))"
echo "host: $(uname -r); $(nft --version); MemAvailable ${avail} MiB"
need="wireguard nf_tables nft_ct nft_nat nft_chain_nat nft_masq nft_limit nft_connlimit nf_conncount nft_reject_inet"
missing=""
for m in $need; do
  lsmod | awk '{print $1}' | grep -qx "$m" && continue
  [ -e "/sys/module/$m" ] && continue                         # built in
  modinfo -n "$m" >/dev/null 2>&1 || refuse "kernel module $m is not available on this kernel"
  missing="$missing $m"
done
if [ -n "$missing" ]; then
  [ "$ALLOW" = 1 ] || refuse "not loaded:$missing - the test would autoload them into the host kernel (host-global). Re-run with --allow-module-autoload only if approved"
  echo "NOTE: approved autoload of:$missing"
fi
unit="enclave-native-g2-$(date +%s)"
echo "unit $unit: MemoryMax=128M RuntimeMaxSec=60 CPUQuota=50%"
set +e
systemd-run --quiet --wait --pipe --collect --unit="$unit" \
  -p MemoryMax=128M -p MemorySwapMax=0 -p RuntimeMaxSec=60 -p CPUQuota=50% -p TasksMax=64 \
  /usr/bin/unshare --net --mount --pid --fork --mount-proc /bin/bash "$D/stage2.sh" "$D" "$MODE"
rc=$?
echo "unit exit $rc"; exit $rc
