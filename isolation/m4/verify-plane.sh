#!/bin/sh
# Boot a plane domain, verify its attestation over TLS, and run the verifier-side negatives - saving EVERY
# client transcript into the run directory.
#
# WHY THE SAVING IS THE POINT. The first version of this fixture was driven by hand and its evidence file quoted
# a VERDICT block that existed only in my terminal, while the file said every line was cut from the run's own
# files. The claims were true and reproducible, but a reader could not check them against anything, which is the
# same defect I had already caught once in the step-2 evidence. So the transcripts are artifacts now: client.out,
# neg-vmpl0.out, neg-appid.out, neg-runtime.out, neg-measurement.out.
#
#   usage: verify-plane.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: verify-plane.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/m4b-plane-$(date +%H%M%S)}
mkdir -p "$W"
. "$here/../m1/domain.env"
FW=${FW:-$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.debug.fd}
QEMU=${QEMU:-$HOME/.cache/enclave-isolation/planeskit/qemu/build/qemu-system-x86_64}
export QEMU
VCEK=${VCEK:-$HOME/.cache/enclave-isolation/m3-clean/vcek.der}
CHAIN=${CHAIN:-$here/../../test/fixtures/amd/Turin-cert_chain.pem}
MINTCB=${MINTCB:-$HOME/.cache/enclave-isolation/m3-clean/min-tcb.json}
for f in "$FW" "$QEMU" "$VCEK" "$CHAIN" "$MINTCB"; do
  [ -r "$f" ] || { echo "cannot read $f"; exit 2; }
done
cp -f "$BUNDLE" "$W/app.bundle"

echo "== building the plane guest"
"$here/build-plane-guest.sh" "$W/app.bundle" "$W/plane.cpio.gz" > "$W/build-guest.txt"
sed 's/^/  /' "$W/build-guest.txt"
appid=$(sed -n 's/.*app id  \([0-9a-f]*\) .*/\1/p' "$W/build-guest.txt")
rtsha=$(sed -n 's/.*runtime sha256  \([0-9a-f]*\) .*/\1/p' "$W/build-guest.txt")
rtid=$(sed -n 's/.*runtime id      \([0-9a-f]*\) .*/\1/p' "$W/build-guest.txt")
for v in "$appid" "$rtsha" "$rtid"; do
  [ ${#v} = 64 ] || { echo "the guest build did not print all three digests"; exit 1; }
done
Z=$(printf '%064d' 0)
export ENCLAVE_APP_IDS="$Z,$appid" ENCLAVE_RUNTIME_SHA256="$Z,$rtsha" ENCLAVE_RUNTIME_IDS="$Z,$rtid"

echo "== building the measured IGVM over it"
BUILDLOG=$W/svsm-build.log "$here/build-measured-igvm.sh" -o "$W/plane.igvm" -i "$W/plane.cpio.gz" -f "$FW" \
  > "$W/build-igvm.txt" 2>&1 || { echo "ABORT: the IGVM did not build:"; tail -8 "$W/build-igvm.txt" | sed 's/^/  /'; exit 1; }
grep -E "Measured SEV hash table at|Launch Digest" "$W/build-igvm.txt" | sed 's/^/  /'
meas=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['igvm']['launchDigest'].lower())" "$W/plane.manifest.json")

echo "== the pre-launch check"
"$here/check-manifest.sh" "$W/plane.manifest.json" "$W/plane.igvm" "$KERNEL" "$W/plane.cpio.gz" "$APPEND" "$FW" \
  > "$W/manifest.txt" 2>&1 || { echo "ABORT: the manifest refuses this launch:"; sed 's/^/  /' "$W/manifest.txt"; exit 1; }

echo "== launching"
IGVM=$W/plane.igvm EVIDENCE_SERIAL=1 FW_DEBUGCON=1 sh "$here/../m3/run-domain.sh" start "$W/plane.cpio.gz" \
  snp P "$W" 2 2048 > "$W/P.host" 2>&1 || true
cleanup() { sh "$here/../m3/run-domain.sh" stop P "$W" >/dev/null 2>&1 || true
            [ -n "${fwdpid:-}" ] && kill "$fwdpid" 2>/dev/null || true; }
trap cleanup EXIT
# Guard the redirect, not just the command: `< missing` fails in the SHELL before tr runs, so this printed a
# "No such file or directory" line on every poll until QEMU created the file.
serving() { [ -s "$W/P.serial" ] && tr -d '\000' < "$W/P.serial" | grep -aq "DOM serving"; }
for _ in $(seq 180); do serving && break; sleep 1; done
[ -s "$W/P.serial" ] || { echo "INFRA: QEMU produced no serial output, so nothing below means anything"; exit 1; }
serving || { echo "ABORT: the domain never served. Guest lines:"
             tr -d '\000' < "$W/P.evidence" 2>/dev/null | sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' | grep -a PLANE | tail -8; exit 1; }

(cd "$here/../m2" && CGO_ENABLED=0 go build -trimpath -o "$W/fwd" ./fwd)
cid=$(sed -n 's/.* cid=\([0-9]*\).*/\1/p' "$W/P.host")
"$W/fwd" -cid "$cid" -port 443 > "$W/fwd.log" 2>&1 &
fwdpid=$!
sleep 3
port=$(sed -n 's/.*127.0.0.1:\([0-9]*\).*/\1/p' "$W/fwd.log" | head -1)
[ -n "$port" ] || { echo "ABORT: the forwarder did not report a port"; cat "$W/fwd.log"; exit 1; }
"$here/../contract/runtime-identity.sh" "$(command -v wasmtime)" > "$W/expected-runtime.json"

cl() {   # cl <outfile> <extra args...>
  o=$1; shift
  node "$here/../m2/client.mjs" "https://127.0.0.1:$port" --no-kds --vcek "$VCEK" \
    --amd-chain "Turin=$CHAIN" --min-tcb "@$MINTCB" "$@" > "$W/$o" 2>&1 || true
}
fails=0
check() { case "$2" in ok) echo "PASS $1";; *) echo "FAIL $1"; fails=$((fails+1));; esac; }
verdict() { sed -n 's/^VERDICT \([a-z-]*\).*/\1/p' "$W/$1" | head -1; }

echo "== the genuine document"
cl client.out --measurement "$meas" --app-sha "$appid" --vmpl 2 --runtime "$W/expected-runtime.json" --save "$W/doc.json"
[ "$(verdict client.out)" = attested ] && grep -q "^RESULT gate=open" "$W/client.out" && r=ok || r=no
check "1 the plane's document is ATTESTED and the gate opens" $r
grep -q "^RESULT app_requests_sent=1" "$W/client.out" && r=ok || r=no
check "2 and one real application request was served over that connection" $r
grep -q "^RESULT doc_key_matches_handshake=1" "$W/client.out" && r=ok || r=no
check "3 the key in the document is the key of the handshake" $r

echo "== verifier-side negatives, same live domain"
cl neg-vmpl0.out --measurement "$meas" --app-sha "$appid" --runtime "$W/expected-runtime.json"
[ "$(verdict neg-vmpl0.out)" = reject ] && r=ok || r=no
check "4 a verifier expecting VMPL0 REJECTS it" $r
cl neg-appid.out --measurement "$meas" --app-sha "$(printf '%063d1' 0)" --vmpl 2 --runtime "$W/expected-runtime.json"
[ "$(verdict neg-appid.out)" = reject ] && r=ok || r=no
check "5 a different app id REJECTS" $r
sed 's/"version":"[^"]*"/"version":"0.0.0"/' "$W/expected-runtime.json" > "$W/wrong-runtime.json"
cl neg-runtime.out --measurement "$meas" --app-sha "$appid" --vmpl 2 --runtime "$W/wrong-runtime.json"
[ "$(verdict neg-runtime.out)" = reject ] && r=ok || r=no
check "6 a different runtime identity REJECTS" $r
cl neg-measurement.out --measurement "$(printf '%095d1' 0)" --app-sha "$appid" --vmpl 2 --runtime "$W/expected-runtime.json"
[ "$(verdict neg-measurement.out)" = reject ] && r=ok || r=no
check "7 a different measurement REJECTS" $r

echo "== the plane's own probe of its confinement"
pl() { tr -d '\000' < "$W/P.evidence" | sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' | grep -ao "PLANE $1.*" | head -1; }
# The errno alone cannot say why sev-guest refused; only the kernel log can. Require the KEY line verbatim.
# EVERY key the kernel will hand out, each naming its own. Probing only 0 and 2 evidenced half the space while
# the text claimed the plane holds none, and copy_with_no_vmpck clears 0..VMPL_MAX precisely because a guest can
# ask for any of them.
r=ok
for id in 0 1 2 3; do
  pl "vmpck${id}_reason=" | grep -q "Empty VMPCK${id} communication key" || r=no
done
check "8 EVERY VMPCK (0-3) refused because that key is EMPTY, each in the kernel's own words" $r
for id in 0 1 2 3; do
  echo "       $(pl "vmpck${id}=")"
  echo "       $(pl "vmpck${id}_reason=")"
done
[ "$r" = no ] && echo "       ENODEV alone is consistent with a missing device or a kernel that sees no SNP, so it does NOT establish a withheld key"

echo
echo "M4b-plane: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")"
echo "transcripts in $W: client.out neg-*.out P.serial P.evidence P.debugcon"
exit $fails
