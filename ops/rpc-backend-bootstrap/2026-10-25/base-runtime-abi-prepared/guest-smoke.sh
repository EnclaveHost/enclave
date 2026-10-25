#!/bin/bash
# Bounded, read-only version/help smoke of the pinned private Base runtime bundle. SAME script on the build host and the
# Ubuntu guest. DIR holds abi.py, smoke.sh, this file and bundle-<sha12>/. Launch ONLY from a clean parent environment:
#   env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=$DIR/home unshare -n timeout 900 bash $DIR/guest-smoke.sh $DIR BASE_SHA SUMS_SHA
# (the guest: root, private temp DIR, network namespace with no interfaces up; no datadir, no service, no library change).
# Refuses on any LD_* variable or /etc/ld.so.preload, since the system loader (for this shell) and the bundled loader both
# honour them before any script line runs. Not a hermeticity claim: kernel, /etc (hosts, nsswitch, ssl), locale and /proc
# still come from the machine; only the dynamic-library closure is pinned.
set -uo pipefail
D=$(cd "${1:?DIR}" && pwd -P); H=${2:?base sha256}; SUMS=${3:?bundle SHA256SUMS sha256}; BD=$D/bundle-${H:0:12}; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }
h() { sha256sum < "$1" | cut -c1-64; }
echo "== environment audit"
n=$(env | grep -c '^LD_'); [ "$n" = 0 ] && ok "no LD_* variable in this environment" || { echo "[FAIL] $n LD_* variables: refusing"; exit 2; }
[ ! -e /etc/ld.so.preload ] && ok "/etc/ld.so.preload absent" || { echo "[FAIL] /etc/ld.so.preload present: refusing (both loaders read it)"; exit 2; }
echo "[info] $(uname -srm); $( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown OS}"); system $(getconf GNU_LIBC_VERSION); system $(openssl version 2>/dev/null || echo 'openssl: none')"
echo "[info] network interfaces up: $(ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | tr '\n' ' ')"
echo "== pins"
[ "$(h $D/abi.py)" = 3c5edab1ece166e09fb1519494a4c65fcc9296c83e11df2a11298c2fa44f2c0f ] && ok "abi.py 3c5edab1" || bad "abi.py pin"
[ "$(h $D/smoke.sh)" = e3f143908478fba0fd29d8e637d1091710eb04282f13aec50e707251a11b342b ] && ok "smoke.sh e3f14390" || bad "smoke.sh pin"
[ "$(h $BD/SHA256SUMS)" = "$SUMS" ] && ok "bundle SHA256SUMS == $SUMS" || bad "bundle SHA256SUMS is not $SUMS"
python3 -I - "$BD/MANIFEST.json" "$H" <<'PY' && ok "MANIFEST binary pin + loader == verifier loader pin f5e11cc6" || bad "MANIFEST"
import json,sys; m=json.load(open(sys.argv[1])); assert m["binarySha256"]==sys.argv[2], m["binarySha256"]
assert m["loader"]["sha256"].startswith("f5e11cc62f8f2c24"), m["loader"]
print("    libraries:", ", ".join(f"{n} {l['sha256'][:12]} ({l['package']})" for n,l in sorted(m["libraries"].items())))
PY
[ $rc = 0 ] || { echo "## guest-smoke rc=1 (pins)"; exit 1; }
echo "== resolution: every library from the bundle"
python3 -I $D/abi.py guard "$BD" | sed 's/^/    /'; [ "${PIPESTATUS[0]}" = 0 ] && ok "guard" || bad "guard"
echo "== informational: the same binary on the SYSTEM libraries (not the deployment path)"
o=$(HOME=$(mktemp -d) timeout 30 "$BD/bin/base" --version 2>&1); r=$?; echo "[info] direct system-library run rc=$r: $(echo "$o" | head -3 | tr '\n' ' ' | cut -c1-300)"
echo "== smoke through the bundle (smoke.sh)"
bash $D/smoke.sh "$BD" "$H"; [ $? = 0 ] || rc=1
echo "## guest-smoke rc=$rc"; exit $rc
