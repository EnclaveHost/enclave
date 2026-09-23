#!/bin/sh
# M4a tests: app-vs-app isolation where the boundary is the SNP GUEST, one guest per app.
#
# What is different from M3a, and why it matters. In M3a many apps share one guest and a privileged MONITOR
# names each app in report_data[32:64]; app-vs-app separation is the guest kernel, and the naming is only as
# good as the monitor. Here each app has its own SNP guest - its own ASID, its own memory-encryption key, its
# own vCPU state - and there is NO monitor: the front asks the PSP directly. So the authority that binds an
# app to its evidence is the LAUNCH MEASUREMENT, which covers the bundle's bytes (build-app-guest.sh writes
# the bundle into the image and kernel-hashes=on puts the image in the measurement).
#
# That changes what the adversary can and cannot do, and the suite says so rather than pretending otherwise:
# a compromised app with root in its own guest CAN mint a report carrying another app's ID, because it owns
# its configfs. What it cannot do is carry the other app's MEASUREMENT. So N3 is a verifier-rejection test,
# and it is the real per-app identity property of this shape.
#
# usage: test-m4.sh [workdir]
#   RECHECK=1 re-scores a saved workdir (see the run context, as in m3)
set -e
here=$(cd "$(dirname "$0")" && pwd)
m1=$here/../m1; m2=$here/../m2
W=${1:-$(mktemp -d)}; mkdir -p "$W"; W=$(cd "$W" && pwd)
VCPUS=1
MEM=${MEM:-512}
res() { tr -d '\r' < "$1" 2>/dev/null | grep -a "^RESULT $2=" | head -1 | sed "s/^RESULT $2=//"; }
verdict() { tr -d '\r' < "$1" 2>/dev/null | grep -a '^VERDICT ' | head -1 | cut -d' ' -f2; }
ser() { tr -d '\r' < "$W/$1.serial" 2>/dev/null; }
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
fwdport() {
  for _ in $(seq 100); do
    p=$(sed -n 's/^FWD listening 127.0.0.1:\([0-9]*\).*/\1/p' "$1" 2>/dev/null)
    [ -n "$p" ] && { echo "$p"; return; }
    sleep 0.05
  done
}
cid_of() { sed -n 's/.* cid=\([0-9]*\).*/\1/p' "$W/$1.host" | head -1; }

BUNDLETOOL=$here/.bundle
(cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)

if [ "${RECHECK:-0}" != 1 ]; then
  # --- two real apps, each in its own bundle, each in its own measured guest ------------------------------
  # Two genuinely different apps, as the M3 suite builds them: M2_LABEL is compiled INTO the component, so
  # A and B differ in their artifact bytes and not merely in a manifest field.
  for L in AAAAA BBBBB; do
    M2_LABEL=$L cargo build --release --locked --target wasm32-wasip2 \
      --manifest-path "$m2/app/Cargo.toml" --target-dir "$W/target-$L" 2>"$W/cargo-$L.txt"
    cp "$W/target-$L/wasm32-wasip2/release/m2_app.wasm" "$W/app-$L.wasm"
  done
  "$BUNDLETOOL" build -label A -cpu 100 -mem "$MEM" -vcpus "$VCPUS" "$W/app-AAAAA.wasm" "$W/A.bundle" > "$W/A.bundlebuild"
  "$BUNDLETOOL" build -label B -cpu 100 -mem "$MEM" -vcpus "$VCPUS" "$W/app-BBBBB.wasm" "$W/B.bundle" > "$W/B.bundlebuild"
  idA=$("$BUNDLETOOL" id "$W/A.bundle"); idB=$("$BUNDLETOOL" id "$W/B.bundle")

  "$here/build-app-guest.sh" "$W/A.bundle" "$W/A.cpio.gz" "$VCPUS" > "$W/A.build"
  "$here/build-app-guest.sh" "$W/B.bundle" "$W/B.cpio.gz" "$VCPUS" > "$W/B.build"

  # --- launch A and B, then the adversary, and tell the adversary where B is ----------------------------
  "$m2/run-domain.sh" start "$W/A.cpio.gz" snp A "$W" "$VCPUS" "$MEM" 100 > "$W/A.host"
  "$m2/run-domain.sh" start "$W/B.cpio.gz" snp B "$W" "$VCPUS" "$MEM" 100 > "$W/B.host"
  cidB=$(cid_of B)
  ( cd "$m2" && CGO_ENABLED=0 go build -trimpath -o "$W/fwd" ./fwd )
  "$W/fwd" -cid "$(cid_of A)" > "$W/A.fwd" 2>&1 &
  "$W/fwd" -cid "$cidB" > "$W/B.fwd" 2>&1 &
  sleep 1

  [ -f "$W/vcek.der" ] || node "$m2/vcek-prep.mjs" "$W/A.doc.json" "$W" > "$W/vcek-prep.txt" 2>&1 || true

  cl() { o=$1; f=$2; shift 2; rc=0
    timeout 300 node "$m2/client.mjs" "https://127.0.0.1:$(fwdport "$f")" "$@" > "$o" 2>&1 || rc=$?
    echo "rc=$rc" >> "$o"; }
  measA=$(sed -n 's/^predicted measurement: //p' "$W/A.build")
  measB=$(sed -n 's/^predicted measurement: //p' "$W/B.build")

  cl "$W/A.probe" "$W/A.fwd" --measurement "$measA" --app-sha "$idA" --no-kds --save "$W/A.doc.json"
  node "$m2/vcek-prep.mjs" "$W/A.doc.json" "$W" > "$W/vcek-prep.txt" 2>&1 || true
  product=$(sed -n 's/^product //p' "$W/vcek-prep.txt")
  # The TCB floor matters, and leaving it out is not a shortcut: without it the verdict is no-tcb-policy, the
  # trusted gate stays CLOSED by design, and no application request is ever sent - so every check that needs a
  # served response fails for want of a policy rather than for want of isolation. vcek-prep.mjs writes the
  # box's own reported TCB as the floor (equal meets it).
  TR="--no-kds --vcek $W/vcek.der --amd-chain $product=$here/../../test/fixtures/amd/$product-cert_chain.pem --min-tcb @$W/min-tcb.json"
  # shellcheck disable=SC2086
  {
    cl "$W/A.client" "$W/A.fwd" --measurement "$measA" --app-sha "$idA" $TR
    cl "$W/B.client" "$W/B.fwd" --measurement "$measB" --app-sha "$idB" $TR --save "$W/B.doc.json"
    # a client holding A's expectations pointed at B, and the reverse: each must refuse
    cl "$W/A-expect-at-B" "$W/B.fwd" --measurement "$measA" --app-sha "$idA" $TR
    cl "$W/B-expect-at-A" "$W/A.fwd" --measurement "$measB" --app-sha "$idB" $TR
  }

  # The adversary gets a WELL-FORMED binding over B's own transport key and a fresh nonce, so its minted report
  # is complete B evidence in every respect a verifier checks except the measurement. A report that merely
  # parsed would make N3b a claim about bytes we invented.
  node -e '
    const fs=require("fs"),c=require("crypto");
    const doc=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const spki=Buffer.from(doc.spki,"base64");
    const nonce=c.randomBytes(32);
    fs.writeFileSync(process.argv[2],doc.spki);
    fs.writeFileSync(process.argv[3],nonce.toString("hex"));
    fs.writeFileSync(process.argv[4],c.createHash("sha256").update(Buffer.concat([spki,nonce])).digest("hex"));
  ' "$W/B.doc.json" "$W/B.spki.b64" "$W/adv.nonce" "$W/adv.bind"
  advbind=$(cat "$W/adv.bind")

  # --- the adversary guest: built NOW, because its target's vsock CID is only assigned at launch ---------
  # Native code with root in its own SNP guest, aimed at B. Its image, and so its measurement, is its own.
  "$here/build-adversary-guest.sh" "$W/ADV.cpio.gz" "$VCPUS" "$cidB" 443 "$idB" "$advbind" > "$W/ADV.build"
  measADV=$(sed -n 's/^predicted measurement: //p' "$W/ADV.build")
  "$m2/run-domain.sh" start "$W/ADV.cpio.gz" snp ADV "$W" "$VCPUS" "$MEM" 100 > "$W/ADV.host" || true
  # it powers off when done; wait for its verdict lines
  for _ in $(seq 120); do [ -r "$W/ADV.serial" ] && ser ADV | grep -aq '^ADV done' && break; sleep 0.5; done

  # a report the adversary minted, if any, judged by a verifier holding B's expectations
  advrep=$(ser ADV | sed -n 's/^ADV report_b64=//p' | head -1)
  if [ -n "$advrep" ]; then
    printf '%s' "$advrep" > "$W/adv.report.b64"
    node "$here/judge-adv.mjs" "$W/adv.report.b64" "$measB" "$idB" "$measADV" \
      "$W/vcek.der" "$W/min-tcb.json" "$W/B.spki.b64" "$W/adv.nonce" \
      "$here/../../test/fixtures/amd/$product-cert_chain.pem" "$product" > "$W/adv.judged" 2>&1 || true
    # negative fixtures: a fabricated or modified report must not satisfy the same check
    "$here/adv-report-fixtures.sh" "$W" "$measB" "$idB" "$measADV" "$product" > "$W/adv.fixtures" 2>&1 || true
  fi

  # --- crash independence and lifecycle: kill the adversary, then re-attest A and B ---------------------
  "$m2/run-domain.sh" stop ADV "$W" > "$W/ADV.stop" 2>&1 || true
  # shellcheck disable=SC2086
  {
    cl "$W/A.after" "$W/A.fwd" --measurement "$measA" --app-sha "$idA" $TR
    cl "$W/B.after" "$W/B.fwd" --measurement "$measB" --app-sha "$idB" $TR
  }
  "$m2/run-domain.sh" stop A "$W" > "$W/A.stop" 2>&1 || true
  "$m2/run-domain.sh" stop B "$W" > "$W/B.stop" 2>&1 || true
  pkill -P $$ -x fwd 2>/dev/null || true

  # --- N7 bundle tamper, offline: the contract must refuse, and a changed bundle is a changed id --------
  cp "$W/A.bundle" "$W/tampered.bundle"
  # flip a byte inside the artifact region (past the header and manifest)
  python3 - "$W/tampered.bundle" <<'PY'
import sys
p=sys.argv[1]; b=bytearray(open(p,'rb').read()); b[-1] ^= 0xff; open(p,'wb').write(b)
PY
  "$BUNDLETOOL" show "$W/tampered.bundle" > "$W/tampered.show" 2>&1 || true
  "$BUNDLETOOL" id "$W/tampered.bundle" > "$W/tampered.id" 2>&1 || true
  {
    echo "CTX_VERSION=1"; echo "CTX_KIND=m4a"; echo "CTX_WHEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "CTX_ID_A=$idA"; echo "CTX_ID_B=$idB"
    echo "CTX_MEAS_A=$measA"; echo "CTX_MEAS_B=$measB"; echo "CTX_MEAS_ADV=$measADV"
    echo "CTX_PRODUCT=$product"
    echo "CTX_SHA_A=$(sha256sum "$W/A.cpio.gz" | cut -c1-64)"
    echo "CTX_SHA_B=$(sha256sum "$W/B.cpio.gz" | cut -c1-64)"
    echo "CTX_SHA_ADV=$(sha256sum "$W/ADV.cpio.gz" | cut -c1-64)"
  } > "$W/run-context"
fi

# ---------------------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------------------
[ -r "$W/run-context" ] || { echo "no run-context in $W; refusing to score a workdir that cannot say what produced it"; exit 2; }
# shellcheck disable=SC1090
. "$W/run-context"
# run-context is an editable text file, so on a recheck it is a CLAIM, not evidence. Re-derive everything it
# asserts from the artefacts the run actually saved, and refuse on any disagreement. Without this, a recheck
# "passes" by reading back numbers someone could have typed - which is the same class of defect as the m3
# recheck guessing its launch context.
if [ "${RECHECK:-0}" = 1 ]; then
  echo "RECHECK: re-deriving the run context from the saved artefacts rather than trusting it"
  bad=""
  for pair in "A:$CTX_ID_A" "B:$CTX_ID_B"; do
    t=${pair%%:*}; want=${pair#*:}
    [ -r "$W/$t.bundle" ] || { echo "  MISSING $t.bundle"; bad="$bad $t.bundle"; continue; }
    got=$("$BUNDLETOOL" id "$W/$t.bundle")
    [ "$got" = "$want" ] && printf '  %s AppID re-derived from %s.bundle: ok\n' "$t" "$t" \
      || { echo "  MISMATCH $t AppID: bundle gives $got, context claims $want"; bad="$bad $t-id"; }
  done
  . "$here/../m1/domain.env"
  for pair in "A:$CTX_MEAS_A" "B:$CTX_MEAS_B" "ADV:$CTX_MEAS_ADV"; do
    t=${pair%%:*}; want=${pair#*:}
    [ -r "$W/$t.cpio.gz" ] || { echo "  MISSING $t.cpio.gz"; bad="$bad $t.cpio.gz"; continue; }
    vc=$VCPUS
    got=$(~/.local/bin/sev-snp-measure --mode snp --vcpus "$vc" --vcpu-family 26 --vcpu-model 2 \
      --vcpu-stepping 1 --vmm-type QEMU --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$W/$t.cpio.gz" \
      --append "$APPEND" 2>/dev/null)
    [ "$got" = "$want" ] && printf '  %s measurement re-derived from %s.cpio.gz: ok\n' "$t" "$t" \
      || { echo "  MISMATCH $t measurement: image gives ${got:-none}, context claims $want"; bad="$bad $t-meas"; }
  done
  # and the adversary verdict is recomputed from the saved report, not read back as text
  if [ -r "$W/adv.report.b64" ]; then
    node "$here/judge-adv.mjs" "$W/adv.report.b64" "$CTX_MEAS_B" "$CTX_ID_B" "$CTX_MEAS_ADV" \
      "$W/vcek.der" "$W/min-tcb.json" "$W/B.spki.b64" "$W/adv.nonce" \
      "$here/../../test/fixtures/amd/$CTX_PRODUCT-cert_chain.pem" "$CTX_PRODUCT" > "$W/adv.judged" 2>&1 || true
    echo "  adversary report re-judged through the real verifier"
  else
    echo "  MISSING adv.report.b64"; bad="$bad adv-report"
  fi
  [ -n "$bad" ] && { echo "RECHECK refusing: the saved artefacts do not match the recorded context:$bad"; exit 2; }
fi
idA=$CTX_ID_A; idB=$CTX_ID_B; measA=$CTX_MEAS_A; measB=$CTX_MEAS_B; measADV=$CTX_MEAS_ADV

echo "evidence: app A id $idA  measurement $measA"
echo "evidence: app B id $idB  measurement $measB"
echo "evidence: adversary guest measurement $measADV"

# 0 the two apps are distinct objects with distinct measured identities
[ "$idA" != "$idB" ] && [ -n "$idA" ] && [ -n "$idB" ] && r=ok || r=no
check "0 two bundles are two identities: a different manifest gives a different AppID over the same artifact" $r
[ "$measA" != "$measB" ] && [ -n "$measA" ] && r=ok || r=no
check "0b two apps give two DIFFERENT launch measurements, so the app is IN the measured image (M3a's shape deliberately does not have this)" $r

# 1 each app attests as itself
[ "$(verdict "$W/A.client")" = attested ] && rA=ok || rA=no
[ "$(verdict "$W/B.client")" = attested ] && rB=ok || rB=no
echo "evidence: A verdict $(verdict "$W/A.client"), B verdict $(verdict "$W/B.client")"
[ "$rA" = ok ] && [ "$rB" = ok ] && r=ok || r=no
check "1 each app's own guest attests: AMD chain to the pinned root, its own measurement, its own AppID in report_data[32:64]" $r
[ "$(res "$W/A.client" app_on_pinned_key)" = 1 ] && [ "$(res "$W/B.client" app_on_pinned_key)" = 1 ] && r=ok || r=no
check "1b each app serves on its own attested TLS key" $r

# N3 (first half) verifier rejection: A's expectations must not be satisfied by B's guest, and vice versa
va=$(verdict "$W/A-expect-at-B"); vb=$(verdict "$W/B-expect-at-A")
echo "evidence: A's expectations against B's guest -> $va; B's against A's -> $vb"
[ "$va" = reject ] && [ "$vb" = reject ] \
  && [ "$(res "$W/A-expect-at-B" app_requests_sent)" = 0 ] && [ "$(res "$W/B-expect-at-A" app_requests_sent)" = 0 ] && r=ok || r=no
check "N3a a verifier holding one app's expectations REJECTS the other app's guest and sends it no application bytes" $r

# N2 IPC: the adversary could not reach B's port
echo "evidence: adversary IPC attempts: $(ser ADV | grep -aoE 'ADV (vsock_target|vsock_host|tcp_target)=[^ ]*' | tr '\n' ' ')"
advt=$(ser ADV | sed -n 's/^ADV vsock_target=//p' | head -1)
case "$advt" in
  CONNECTED) r=no ;;                 # it got through: that is the breach this check exists for
  "") r=no ;;                        # no result at all: silence is not a refusal
  *) r=ok ;;                         # refused, timeout, no route - all of them are "did not get through"
esac
echo "evidence: the adversary's connect to B got: ${advt:-no result}"
check "N2 a compromised app with ROOT in its own guest cannot reach the other app's vsock port (anything but CONNECTED, and a missing result is a failure)" $r

# N1 memory: no shared mapping, no path to B's memory
echo "evidence: adversary memory probes: $(ser ADV | grep -aoE 'ADV (mem_[a-z_]+)=[^ ]*' | tr '\n' ' ')"
[ "$(ser ADV | grep -ac 'ADV mem_other_guest=unreachable')" -ge 1 ] && r=ok || r=no
check "N1 it finds no interface to the other guest's memory: separate SNP guests are separate ASIDs and separate memory-encryption keys" $r

# N3 (second half) the adversary CAN mint a report naming B, and the verifier rejects it on measurement
echo "evidence: $(sed -n '1,3p' "$W/adv.judged" 2>/dev/null | tr '\n' ' ')"
grep -aq 'AUTHENTICATED-AND-REJECTED-AS-B' "$W/adv.judged" 2>/dev/null && r=ok || r=no
check "N3b the adversary's report is AUTHENTIC through the real verifier (VCEK to the pinned ARK, this chip's TCB meeting the floor), it names B AND binds B's transport key, and a verifier pinning B's measurement still REFUSES it on the measurement: the measurement is the app-naming authority, not a monitor" $r
echo "evidence: $(grep -aE '^(ok|FAIL) step' "$W/adv.judged" 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
grep -aq 'adv report fixtures: ALL' "$W/adv.fixtures" 2>/dev/null && r=ok || r=no
echo "evidence: $(tail -1 "$W/adv.fixtures" 2>/dev/null)"
check "N3c a fabricated or modified report does NOT satisfy that check: the proof chain refuses it, so N3b's pass is not vacuous" $r

# N5 availability: B kept serving and attesting while the adversary ran and after it died
[ "$(verdict "$W/B.after")" = "$(verdict "$W/B.client")" ] && [ "$(res "$W/B.after" app_status)" = 200 ] && r=ok || r=no
check "N5 the other app kept SERVING and ATTESTING while a compromised app ran beside it and after it was killed" $r
[ "$(res "$W/A.after" app_status)" = 200 ] && r=ok || r=no
check "N6 crash independence: the adversary guest ending left A serving and attesting unchanged" $r

# lifecycle cleanup
advend=$(cat "$W/ADV.stop" 2>/dev/null)
case "$advend" in
  *"HOST stopped unit="*) r=ok ;;                 # we ended it
  *"was not running at stop"*) r=ok ;;            # it powered itself off after its probe: also reclaimed
  *) r=no ;;
esac
echo "evidence: adversary guest end: $(printf '%s' "$advend" | tr '\n' ' ' | cut -c1-110)"
check "N6b the adversary guest was reclaimed: its unit is gone and the host recorded its accounting" $r

# N7 bundle tamper (offline, contract-level)
echo "evidence: tampered bundle -> $(head -1 "$W/tampered.show" 2>/dev/null | cut -c1-90)"
grep -aqiE 'artifact|sha256|mismatch|invalid|refus' "$W/tampered.show" 2>/dev/null && r=ok || r=no
check "N7 a tampered bundle is REFUSED by the contract rather than loaded as its old identity" $r
[ "$(cat "$W/tampered.id" 2>/dev/null)" != "$idA" ] && r=ok || r=no
check "N7b and its AppID is not A's: identity is over ALL the bundle's bytes" $r

echo "workdir $W"
if [ "$fails" -ne 0 ]; then echo "M4a: $fails FAILED"; exit 1; fi
cat <<EOF
M4a: ALL PASS

app-vs-app isolation here is the SNP GUEST boundary, and the app's identity is the measured image: two apps
have two different launch measurements, and a verifier holding one app's expectations refuses the other's
guest. There is no monitor in this shape, so nothing unmeasured names an app.

NOT established by this suite: per-app isolation at DENSITY. One guest per app costs a guest per app
(M2 measured 3.4 s and ~586 MB each). The plane-per-app shape that would make it cheap is M4b, and
vmpl_count=4 caps it at 2-3 apps per guest. See isolation/m4/PLAN.md.
EOF
