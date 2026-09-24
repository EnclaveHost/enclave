#!/bin/sh
# A verifier reconstructs a per-app guest's measurement from a PINNED domain release and the app's bundle, and gets
# exactly what a live SNP guest reported. Local; no guest is launched - the live values are the ones recorded by
# the guestd hardware run (evidence/guestd-2026-09-24.txt), read from its own files.
#
#   D1  a release is reproducible from this host's inputs: two creations, one id
#   D2  reconstruction from the release equals the LIVE measurement for both of that run's apps
#   D3  every tampering is refused: a changed, extra, missing or symlinked file; a non-canonical manifest; a
#       manifest rewritten to match a tampered file (only the PINNED id catches that, and it is caught); a swapped
#       firmware that does not verify
#   D4  the vCPU count and the app each move the measurement
#   D5  a catalog-derived bundle (contract/catalog) is reconstructed too, and a bare component is refused
#   D6  the measured front does not link the catalog package (the regression that moved every measurement)
#
#   usage: test-domain-release.sh <guestd run dir, e.g. ~/enclave-bench/guestd-test-091307> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
G=${1:?usage: test-domain-release.sh <guestd run dir> [workdir]}
W=${2:-$HOME/enclave-bench/domain-release-test-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
live() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["measurement"])' "$G/$1.vm.json"; }
em() { "$here/expected-measurement.sh" "$@" 2> "$W/em.err"; }
meas() { sed -n 's/^measurement //p'; }

# D1 ------------------------------------------------------------------------------------------------------------
"$here/domain-release.sh" "$W/rel1" > "$W/rel1.txt"
"$here/domain-release.sh" "$W/rel2" > "$W/rel2.txt"
R1=$(awk '{print $2}' "$W/rel1.txt"); R2=$(awk '{print $2}' "$W/rel2.txt")
n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["files"]))' "$W/rel1/release.json")
echo "   release $R1 ($n files)"
[ ${#R1} = 64 ] && [ "$R1" = "$R2" ] && [ "$n" -ge 12 ] && r=ok || r=no
check "D1 the release is reproducible from this host's inputs: two creations, one id" $r

# D2 ------------------------------------------------------------------------------------------------------------
r=ok
for x in A B; do
  got=$(em "$W/rel1" "$G/$x.bundle" 1 "$R1" | meas); want=$(live "$x")
  echo "   $x reconstructed $(echo "$got" | cut -c1-24)  live $(echo "$want" | cut -c1-24)"
  [ ${#got} = 96 ] && [ "$got" = "$want" ] || r=no
done
check "D2 reconstruction from the pinned release equals the LIVE measurement of both apps of the guestd run" $r

# D3 ------------------------------------------------------------------------------------------------------------
tamper() {   # tamper <name> <expected refusal> <shell run inside the copy>
  rm -rf "$W/t"; cp -a "$W/rel1" "$W/t"; chmod -R u+w "$W/t"
  (cd "$W/t" && sh -c "$3")
  if em "$W/t" "$G/A.bundle" 1 "${PIN-$R1}" > /dev/null; then echo "     $1: ACCEPTED"; return 1; fi
  grep -q "$2" "$W/em.err" && { echo "     $1: $(head -1 "$W/em.err")"; return 0; }
  echo "     $1: refused for another reason: $(head -1 "$W/em.err")"; return 1
}
n=0; ok=0
for c in \
  "changed file|does not match its manifest entry|printf x >> template/front" \
  "extra file|not in its manifest|printf x > template/rt/extra.so" \
  "missing file|missing|rm template/rt/libm.so.6" \
  "symlink|symlink|ln -s libc.so.6 template/rt/libc.so.7" \
  "non-canonical manifest|not canonical|python3 -c 'import json; d=json.load(open(\"release.json\")); open(\"release.json\",\"w\").write(json.dumps(d, sort_keys=True))'" \
  "manifest rewritten to match a changed front|not the pinned release|printf x >> template/front && rm release.json && python3 $here/release-manifest.py write . --cmdline \"\$(python3 -c 'import json; print(json.load(open(\"'$W'/rel1/release.json\"))[\"cmdline\"])')\" > /dev/null" \
  ; do
  n=$((n + 1)); name=${c%%|*}; rest=${c#*|}; want=${rest%%|*}; cmd=${rest#*|}
  tamper "$name" "$want" "$cmd" && ok=$((ok + 1))
done
# a consistent release with a firmware that does not verify: refused even WITHOUT a pin
n=$((n + 1))
PIN="" tamper "non-verifying firmware, manifest made consistent" "not pinned as verifying" \
  "cp /usr/share/edk2/x64/OVMF.4m.fd firmware.fd && rm release.json && python3 $here/release-manifest.py write . --cmdline 'console=ttyS0 rdinit=/init loglevel=3' > /dev/null" \
  && ok=$((ok + 1))
[ $ok = $n ] && [ $n -ge 7 ] && r=ok || r=no
check "D3 every tampering is refused ($ok of $n), the consistent rewrite only by the pinned id" $r

# D4 ------------------------------------------------------------------------------------------------------------
a1=$(em "$W/rel1" "$G/A.bundle" 1 "$R1" | meas); a2=$(em "$W/rel1" "$G/A.bundle" 2 "$R1" | meas)
b1=$(em "$W/rel1" "$G/B.bundle" 1 "$R1" | meas)
[ ${#a2} = 96 ] && [ "$a1" != "$a2" ] && [ "$a1" != "$b1" ] && r=ok || r=no
check "D4 the vCPU count and the app each move the measurement" $r

# D5 ------------------------------------------------------------------------------------------------------------
BT=$here/.bundle
"$BT" extract "$G/A.bundle" "$W/A.component"
cid=$(python3 -c 'import hashlib,base64,sys; d=open(sys.argv[1],"rb").read(); print("b"+base64.b32encode(b"\x01\x55\x12\x20"+hashlib.sha256(d).digest()).decode().lower().rstrip("="))' "$W/A.component")
rt=$(node -e 'import("'"$here"'/../contract/runtime.mjs").then(m=>process.stdout.write(m.runtimeId(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).toString("hex")))' "$W/rel1/template/rt/runtime.json")
printf '{"derivation":"enclave-catalog-bundle/1","catalog":{"app":"0x%s","version":3},"cid":"%s","policy":{"cpuPercent":100,"memMiB":512,"vcpus":1},"runtimeId":"%s"}' \
  "$(printf 'ab%.0s' $(seq 32))" "$cid" "$rt" > "$W/derive.json"
python3 "$here/../contract/catalog/derive_reference.py" bundle "$W/derive.json" "$W/A.component" "$W/A.derived.bundle" > "$W/derive.out"
d1=$(em "$W/rel1" "$W/A.derived.bundle" 1 "$R1" | meas)
r=ok
[ ${#d1} = 96 ] && [ "$d1" != "$a1" ] || r=no
em "$W/rel1" "$W/A.component" 1 "$R1" > /dev/null && r=no
echo "   catalog-derived A: $(echo "$d1" | cut -c1-24) (AppID $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["appId"][:16])' "$W/derive.out")...)"
check "D5 a catalog-derived bundle is reconstructed (its own measurement), and a bare component is refused" $r

# D6 ------------------------------------------------------------------------------------------------------------
(cd "$here/../m2" && go list -deps ./front) > "$W/front-deps.txt"
grep -q "isolation/contract$" "$W/front-deps.txt" && ! grep -q "contract/catalog" "$W/front-deps.txt" && r=ok || r=no
check "D6 the measured front links the contract but NOT the catalog package" $r

echo
echo "domain-release: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")  (workdir $W)"
exit $fails
