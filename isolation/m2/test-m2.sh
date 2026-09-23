#!/bin/sh
# Milestone 2 tests (isolation/DESIGN.md section 10): one app domain SERVING on one port, TLS ending
# inside the domain, and the TLS key bound into the domain's attestation report. T1 (SNP) and T0 (plain
# KVM), our own VMs on our own lab host, documented interfaces only. Every check prints PASS/FAIL with
# the evidence it compared.
#
# Three boots of the same image: s1 (SNP: every client mode, perf, host-in-the-middle, switched key),
# s2 (SNP again: a new launch), t1 (plain KVM: trusted refusal, T0 diagnostic, perf, host-in-the-middle).
# Client modes (client.mjs, judge.mjs): the default is TRUSTED and opens only on an AMD-chain-verified
# report; --lab-unsigned is the explicit diagnostic for this chip, which has no VCEK at AMD KDS, and its
# verdict is "unauthenticated", never "attested"; --t0-diagnostic is the explicit, untrusted T0 path.
#
# usage: test-m2.sh [workdir]      RECHECK=1 re-scores a workdir's saved outputs without booting anything
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:-$(mktemp -d)}; mkdir -p "$W"; W=$(cd "$W" && pwd)
# the guest console ends lines \r\n: strip the \r before comparing (M1 lost a run to this)
res() { tr -d '\r' < "$1" 2>/dev/null | grep -a "^RESULT $2=" | head -1 | sed "s/^RESULT $2=//"; }
dom() { tr -d '\r' < "$1" 2>/dev/null | grep -aoE "$2=[0-9a-f]+" | head -1 | cut -d= -f2; }
verdict() { tr -d '\r' < "$1" 2>/dev/null | grep -a '^VERDICT ' | head -1 | cut -d' ' -f2; }
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

fwdport() {   # the port a forwarder bound, once it has said so
  for _ in $(seq 100); do
    p=$(sed -n 's/^FWD listening 127.0.0.1:\([0-9]*\).*/\1/p' "$1" 2>/dev/null)
    [ -n "$p" ] && { echo "$p"; return; }
    sleep 0.05
  done
  echo 0
}
# client <out> <fwd log> [args]: one client run, its exit status recorded with its output
client() {
  o=$1; f=$2; shift 2; rc=0
  timeout 300 node "$here/client.mjs" "https://127.0.0.1:$(fwdport "$f")" --measurement "$predA" --app-sha "$shaA" "$@" \
    > "$o" 2>&1 || rc=$?
  echo "RESULT exit=$rc" >> "$o"
}

# serve <tag> <snp|plain> <full|basic>: launch, run the clients against the live domain, stop it
serve() {
  tag=$1; mode=$2; depth=$3
  "$here/run-domain.sh" start "$W/dom-A.cpio.gz" "$mode" "$tag" "$W" > "$W/$tag.host"
  cid=$(sed -n 's/.* cid=\([0-9]*\).*/\1/p' "$W/$tag.host"); t0=$(sed -n 's/.* t0_ms=\([0-9]*\).*/\1/p' "$W/$tag.host")
  "$W/fwd" -cid "$cid" -tee "$W/$tag.tee" > "$W/$tag.fwd" 2>&1 & f1=$!
  "$W/fwd" -cid "$cid" > "$W/$tag.fwd-perf" 2>&1 & f2=$!
  "$W/fwd" -cid "$cid" -mitm -mitm-tee "$W/$tag.mitm-plain" > "$W/$tag.fwd-mitm" 2>&1 & f3=$!
  "$W/fwd" -cid "$cid" -switch-after 1 -mitm-tee "$W/$tag.switch-plain" > "$W/$tag.fwd-switch" 2>&1 & f4=$!
  if [ "$mode" = snp ]; then diag=--lab-unsigned; else diag=--t0-diagnostic; fi
  client "$W/$tag.trusted" "$W/$tag.fwd" --t0 "$t0"          # the default mode first: it also waits for boot
  client "$W/$tag.client" "$W/$tag.fwd" "$diag" --save "$W/$tag.doc.json"
  if [ "$depth" = full ]; then
    client "$W/$tag.perf" "$W/$tag.fwd-perf" "$diag" --perf
    client "$W/$tag.mitm" "$W/$tag.fwd-mitm" "$diag"
    if [ "$mode" = snp ]; then client "$W/$tag.switch" "$W/$tag.fwd-switch" "$diag"; fi
  fi
  kill "$f1" "$f2" "$f3" "$f4" 2>/dev/null || true
  "$here/run-domain.sh" stop "$tag" "$W" >> "$W/$tag.host"
}

if [ "${RECHECK:-0}" != 1 ]; then
  cargo build --release --locked --target wasm32-wasip2 --manifest-path "$here/app/Cargo.toml" \
    --target-dir "$W/target" 2>"$W/cargo.txt"
  cp "$W/target/wasm32-wasip2/release/m2_app.wasm" "$W/app-A.wasm"
  "$here/build-domain.sh" "$W/app-A.wasm" "$W/dom-A.cpio.gz" 1 > "$W/build-A.txt"
  "$here/build-domain.sh" "$W/app-A.wasm" "$W/dom-A2.cpio.gz" 1 > "$W/build-A2.txt"
  (cd "$here" && CGO_ENABLED=0 go build -trimpath -o "$W/fwd" ./fwd)
fi
predA=$(sed -n 's/^predicted measurement: //p' "$W/build-A.txt")
shaA=$(sha256sum "$W/app-A.wasm" | cut -c1-64)
if [ "${RECHECK:-0}" != 1 ]; then
  serve s1 snp full
  serve s2 snp basic
  serve t1 plain full
  # forged and unsigned evidence, judged offline by the client's own judge(), plus s1's genuine report
  node "$here/negative.mjs" --measurement "$predA" --app-sha "$shaA" --genuine "$W/s1.doc.json" > "$W/negative.txt" 2>&1 || true
fi

echo "evidence: app A sha256 $shaA"
echo "evidence: predicted   $predA"
echo "evidence: live s1     $(res "$W/s1.client" measurement)"
echo "evidence: live s2     $(res "$W/s2.client" measurement)"
cmp -s "$W/dom-A.cpio.gz" "$W/dom-A2.cpio.gz" && r=ok || r=no
check "0 build reproducible: two builds of the domain are byte-identical" $r
[ -n "$predA" ] && [ "$(res "$W/s1.client" measurement)" = "$predA" ] && [ "$(res "$W/s2.client" measurement)" = "$predA" ] && r=ok || r=no
check "1 measurement reproducible: live == predicted, both launches" $r

echo "evidence: s1 trusted: $(tr -d '\r' < "$W/s1.trusted" | grep -a '^VERDICT')"
[ "$(verdict "$W/s1.trusted")" = reject ] && grep -aq 'no VCEK available' "$W/s1.trusted" && [ "$(res "$W/s1.trusted" gate)" = closed ] \
  && [ "$(res "$W/s1.trusted" app_requests_sent)" = 0 ] && [ "$(res "$W/s1.trusted" exit)" = 3 ] && r=ok || r=no
check "2 the TRUSTED default refuses what it cannot authenticate: on this chip (no VCEK at KDS) a genuine T1 report is REJECTED and no application request is sent" $r
[ "$(verdict "$W/t1.trusted")" = not-attested ] && [ "$(res "$W/t1.trusted" gate)" = closed ] \
  && [ "$(res "$W/t1.trusted" app_requests_sent)" = 0 ] && r=ok || r=no
check "2b the trusted default refuses a T0 domain, sending no application request" $r
tr -d '\r' < "$W/negative.txt" | grep -aE '^(PASS|FAIL|evidence)' | sed 's/^/    /' || true
grep -aq '^NEGATIVE: ALL PASS' "$W/negative.txt" && r=ok || r=no
check "2c forged and unsigned evidence: every case refused, or at most 'unauthenticated' in the lab mode" $r

tr -d '\r' < "$W/s1.client" | grep -a '^evidence:' | sed 's/^/    /' || true
[ "$(verdict "$W/s1.client")" = unauthenticated ] && [ "$(verdict "$W/s2.client")" = unauthenticated ] && r=ok || r=no
check "3 lab diagnostic, UNAUTHENTICATED: policy, VMPL0, measurement, key+nonce binding and app naming all consistent (not attestation: no AMD chain on this chip)" $r
[ "$(res "$W/s1.client" second_nonce_verdict)" = unauthenticated ] && [ "$(res "$W/s1.client" key_stable_in_launch)" = 1 ] && r=ok || r=no
check "3b a second nonce on a new, pinned connection: same verdict, same key" $r
[ "$(res "$W/s1.client" replay_rejected)" = 1 ] && r=ok || r=no
check "3c a report does not satisfy a different nonce (no replay)" $r

k1=$(res "$W/s1.client" spki_sha256); k2=$(res "$W/s2.client" spki_sha256)
c1=$(dom "$W/s1.serial" spki_sha256)
echo "evidence: s1 key the client pinned $k1, key the domain minted $c1; s2 pinned $k2"
[ -n "$k1" ] && [ "$k1" = "$c1" ] && r=ok || r=no
check "4 TLS ends inside the domain: the handshake key is the one the domain minted" $r
mp=$(stat -c %s "$W/s1.mitm-plain" 2>/dev/null || echo 0)
mapp=$(grep -a -c -E '/hello|/echo|GET /p ' "$W/s1.mitm-plain" 2>/dev/null || true)
echo "evidence: host-in-the-middle: $(tr -d '\r' < "$W/s1.mitm" | grep -a -m1 '^VERDICT'); the host read $mp plaintext bytes, application requests among them: ${mapp:-0}"
[ "$(verdict "$W/s1.mitm")" = reject ] && grep -aq 'does not bind' "$W/s1.mitm" && [ "$(res "$W/s1.mitm" app_requests_sent)" = 0 ] \
  && [ "${mapp:-0}" = 0 ] && r=ok || r=no
check "4b a host that terminates TLS itself is REJECTED on the binding, and receives no application request" $r
teeb=$(stat -c %s "$W/s1.tee" 2>/dev/null || echo 0)
hits=$(grep -a -c -E 'APP AAAAA|/hello|from=client|enclave-attestation' "$W/s1.tee" 2>/dev/null || true)
echo "evidence: the host relayed $teeb bytes for the s1 clients; plaintext markers found: ${hits:-0}"
[ "$teeb" -gt 1000 ] && [ "${hits:-0}" = 0 ] && r=ok || r=no
check "4c the host relays ciphertext only: no request or response plaintext in what it moved" $r
sp=$(stat -c %s "$W/s1.switch-plain" 2>/dev/null || echo 0)
echo "evidence: switched key: $(grep '^FWD conn' "$W/s1.fwd-switch" | tr '\n' ' ')/ $(tr -d '\r' < "$W/s1.switch" | grep -a 'ABORTED' | cut -c1-120)"
[ "$(res "$W/s1.switch" app_aborted)" = pin-mismatch ] && [ "$(res "$W/s1.switch" exit)" = 4 ] \
  && [ "$(res "$W/s1.switch" app_requests_sent)" = 0 ] && [ "$(res "$W/s1.switch" refused_handshakes)" -ge 1 ] \
  && grep -q '^FWD conn 2 mitm' "$W/s1.fwd-switch" && [ "$sp" = 0 ] && r=ok || r=no
check "4d reconnect to a switched key: refused AT THE HANDSHAKE, traffic aborted, 0 plaintext bytes reached the host ($sp)" $r
[ -n "$k1" ] && [ -n "$k2" ] && [ "$k1" != "$k2" ] && r=ok || r=no
check "5 key minted per launch: s1 and s2 keys differ, identity (check 1) does not" $r

b1=$(res "$W/s1.client" app_body); bt=$(res "$W/t1.client" app_body)
echo "evidence: T1 app says $b1 / T0 app says $bt"
[ "$(res "$W/s1.client" app_status)" = 200 ] && [ "$b1" = '"APP AAAAA path=/hello?from=client"' ] \
  && [ "$(res "$W/s1.client" app_on_pinned_key)" = 1 ] && r=ok || r=no
check "6 the app serves through the domain's port, on the pinned key (lab diagnostic)" $r
[ "$(res "$W/s1.perf" echo_intact)" = 1 ] && [ "$(res "$W/t1.perf" echo_intact)" = 1 ] && r=ok || r=no
check "6b 4 x 16 MiB echoed intact through the domain on the pinned key (T1 lab, T0 diagnostic)" $r

[ -n "$bt" ] && [ "$bt" = "$b1" ] && [ "$(res "$W/t1.client" app_on_pinned_key)" = 1 ] && r=ok || r=no
check "7 tier parity: the same image serves the same app output on T0 (t0-diagnostic)" $r
[ "$(dom "$W/t1.serial" snp)" = 0 ] && [ "$(verdict "$W/t1.client")" = not-attested ] && [ "$(res "$W/t1.client" tier)" = T0 ] && r=ok || r=no
check "7b T0 says it is not attested, and no mode calls it attested" $r
[ "$(verdict "$W/t1.mitm")" = not-attested ] && r=ok || r=no
check "7c T0 cannot tell a host in the middle apart (it stays not-attested, never attested)" $r

echo "--- 8 serving cost (measured, no pass/fail) ---"
for t in s1 s2 t1; do
  printf '%-3s kernel->init %sms, init->serving %sms, host launch->first attestation document %sms, host CPU %ss, memory peak %s MB\n' "$t" \
    "$(dom "$W/$t.serial" boot_ms)" \
    "$(awk -v a="$(tr -d '\r' < "$W/$t.serial" | grep -aoE 'ready_ms=[0-9]+' | cut -d= -f2)" -v b="$(dom "$W/$t.serial" boot_ms)" 'BEGIN { if (a != "") print a - b }')" \
    "$(res "$W/$t.trusted" first_attestation_ms)" \
    "$(awk -v n="$(sed -n 's/^HOST CPUUsageNSec=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.1f", n / 1e9 }')" \
    "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')"
done
for t in s1 t1; do
  printf '%-3s request latency p50 %sms p99 %sms (sequential, one kept-alive TLS connection); echo %s MB/s\n' "$t" \
    "$(res "$W/$t.perf" latency_p50_ms)" "$(res "$W/$t.perf" latency_p99_ms)" "$(res "$W/$t.perf" echo_mb_per_s)"
done
echo "workdir $W"
[ "$fails" -eq 0 ] && echo "M2: ALL PASS" || { echo "M2: $fails FAILED"; exit 1; }
