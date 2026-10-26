#!/bin/bash
# root-b3bundle-fetch.sh (offline-b3sum-bundle-stage/r2; PREPARED, never run by Claude). Root, HOST, network = one Ubuntu origin only,
# through the shared queue's MAIN lane (1536 MiB cap; the queue admits only with MemAvailable >= 16384 floor + 1536 + 256 + reserve,
# and its memory guard stops the tree if host MemAvailable drops below 16384 MiB and records peakTreeRssMiB in logs/<name>.guard):
#   jobs/q-exit-status.sh root-b3bundle-fetch 1536 bash offline-b3sum-bundle-stage/r2/jobs/root-b3bundle-fetch.sh \
#       SUITE COMPONENT PACKAGE_VERSION TRANSPORT OUT_DIR PRIMARY_FPR [PRIMARY_FPR ...]
# SUITE noble|noble-updates|noble-security; COMPONENT main|universe; PACKAGE_VERSION = exact Debian version (root pin);
# TRANSPORT https (default policy) or http (ONLY if root explicitly selects it; same signed-metadata chain); OUT_DIR = NEW absolute dir;
# PRIMARY_FPR = 40-hex primary fingerprints root derived separately from the pinned keyring (never defaulted here).
# Fixed here (not root-overridable): keyring = logs/guest-trust-1492/ubuntu-archive-keyring.gpg sha256 80a36b0a...5c31; origin derived
# from SUITE + TRANSPORT exactly as the pinned guest ubuntu.sources (e93b42f6...): noble-security -> security.ubuntu.com, else archive.
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C; umask 077
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); W=$(cd "$S/../.." && pwd -P)
KEYRING=$W/logs/guest-trust-1492/ubuntu-archive-keyring.gpg
KEYRING_SHA=80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31
SOURCES_SHA=e93b42f6049cd24174273060f4a33416ad165bf3a3b283626c4e2b93b37700d3
FLOOR_MIB=16384 LANE_MIB=1536
refuse() { echo "REFUSED: $*"; exit 9; }
[ $# -ge 6 ] || refuse "usage: SUITE COMPONENT PACKAGE_VERSION TRANSPORT OUT_DIR PRIMARY_FPR [PRIMARY_FPR ...]"
SUITE=$1 COMPONENT=$2 VER=$3 TR=$4 OUT=$5; shift 5
case "$TR" in https|http) ;; *) refuse "TRANSPORT must be https or http";; esac
case "$SUITE" in noble-security) HOST=security.ubuntu.com;; noble|noble-updates) HOST=archive.ubuntu.com;; *) refuse "SUITE";; esac
ORIGIN=$TR://$HOST/ubuntu
case "$OUT" in /*) ;; *) refuse "OUT_DIR must be absolute";; esac
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || refuse "OUT_DIR exists"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || refuse "stage != SHA256SUMS"
[ "$(sha256sum < "$KEYRING" | cut -d' ' -f1)" = "$KEYRING_SHA" ] || refuse "keyring sha256 != pin"
[ "$(sha256sum < "$W/logs/guest-trust-1492/ubuntu.sources" | cut -d' ' -f1)" = "$SOURCES_SHA" ] || refuse "guest ubuntu.sources sha256 != pin"
grep -qx "URIs: http://$HOST/ubuntu/\?" "$W/logs/guest-trust-1492/ubuntu.sources" || refuse "origin host not in the pinned guest sources"
AVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
[ "$AVAIL" -ge $((FLOOR_MIB + LANE_MIB)) ] || refuse "admission: MemAvailable ${AVAIL} MiB < ${FLOOR_MIB} floor + ${LANE_MIB} lane"
FPRS=(); for f in "$@"; do FPRS+=(--allowed-primary-fpr "$f"); done
L=$S/logs/fetch-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$L" || exit 9
printf '%s\n' "suite=$SUITE component=$COMPONENT version=$VER transport=$TR origin=$ORIGIN out=$OUT availMiB=$AVAIL fprs=$*" > "$L/inputs.txt"
timeout -k 30 1800 python3 -I "$S/b3bundle.py" fetch --keyring "$KEYRING" --keyring-sha256 "$KEYRING_SHA" "${FPRS[@]}" \
    --package-version "$VER" --transport "$TR" --origin "$ORIGIN" --suite "$SUITE" --component "$COMPONENT" --out "$OUT" \
    > "$L/fetch.json" 2> "$L/fetch.err" < /dev/null; rc=$?
echo "$rc" > "$L/rc"; cat "$L/fetch.json"
if [ "$rc" -eq 0 ]; then
  (cd "$OUT" && sha256sum -c --quiet SHA256SUMS) || { echo "FAIL: bundle != its SHA256SUMS"; exit 9; }
  echo "## receipt.json sha256 $(sha256sum < "$OUT/receipt.json" | cut -d' ' -f1)  (root pins this for qualify)"
fi
echo "## fetch rc $rc; logs $L; peakTreeRssMiB/minHostAvailableMiB: logs/root-b3bundle-fetch.guard"; exit $rc
