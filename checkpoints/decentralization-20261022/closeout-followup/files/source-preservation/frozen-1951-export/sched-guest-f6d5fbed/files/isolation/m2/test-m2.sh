#!/bin/sh
# Milestone 2 tests (isolation/DESIGN.md section 10): one app domain SERVING on one port, TLS ending
# inside the domain, and the TLS key bound into the domain's attestation report. T1 (SNP) and T0 (plain
# KVM), our own VMs on our own lab host, documented interfaces only. Every check prints PASS/FAIL with
# the evidence it compared.
#
# Three boots of the same image: s1 (SNP: every client mode, perf, host-in-the-middle, switched key),
# s2 (SNP again: a new launch), t1 (plain KVM: trusted refusal, T0 diagnostic, perf, host-in-the-middle).
# Client modes (client.mjs, judge.mjs): the default is TRUSTED and opens only on "attested" = the AMD
# chain verified AND the reported TCB meets a caller-supplied floor; --lab-unsigned is the explicit
# diagnostic ("no-tcb-policy" / "unauthenticated", never "attested"); --t0-diagnostic is the explicit,
# untrusted T0 path. The chip's VCEK is fetched from AMD KDS once per batch (vcek-prep.mjs) and every
# trusted client then runs with --no-kds. The floors are TEST values derived from the box's own TCB
# (equal must pass, one SNP version above must fail), not a recommended firmware floor.
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
  # the trusted default holding NO VCEK and not asking KDS: it must refuse. It also waits for the boot.
  client "$W/$tag.probe" "$W/$tag.fwd" --no-kds --t0 "$t0" --save "$W/$tag.doc.json"
  if [ "$mode" = snp ]; then
    # that chip's VCEK, fetched once per batch; the TEST floors are written beside it (vcek-prep.mjs)
    [ -f "$W/vcek.der" ] || node "$here/vcek-prep.mjs" "$W/$tag.doc.json" "$W" > "$W/vcek-prep.txt" 2>&1 || true
    product=$(sed -n 's/^product //p' "$W/vcek-prep.txt")
    TR="--no-kds --vcek $W/vcek.der --amd-chain $product=$here/../../test/fixtures/amd/$product-cert_chain.pem"
    # shellcheck disable=SC2086
    {
      client "$W/$tag.nopolicy" "$W/$tag.fwd" $TR
      client "$W/$tag.client" "$W/$tag.fwd" $TR --min-tcb "@$W/min-tcb.json" --runtime "$W/expected-runtime.json"
      # ABI/2 negatives, against the SAME live domain: an expectation that differs in one field must close
      # the gate, and so must expecting a runtime from a domain that binds none.
      client "$W/$tag.rtwrong" "$W/$tag.fwd" $TR --min-tcb "@$W/min-tcb.json" --runtime "$W/wrong-runtime.json"
      client "$W/$tag.above" "$W/$tag.fwd" $TR --min-tcb "@$W/min-tcb-above.json"
      client "$W/$tag.lab" "$W/$tag.fwd" --lab-unsigned --no-kds
      if [ "$depth" = full ]; then
        client "$W/$tag.perf" "$W/$tag.fwd-perf" $TR --min-tcb "@$W/min-tcb.json" --perf
        client "$W/$tag.mitm" "$W/$tag.fwd-mitm" $TR --min-tcb "@$W/min-tcb.json"
        client "$W/$tag.switch" "$W/$tag.fwd-switch" $TR --min-tcb "@$W/min-tcb.json"
      fi
    }
  else
    client "$W/$tag.client" "$W/$tag.fwd" --t0-diagnostic
    if [ "$depth" = full ]; then
      client "$W/$tag.perf" "$W/$tag.fwd-perf" --t0-diagnostic --perf
      client "$W/$tag.mitm" "$W/$tag.fwd-mitm" --t0-diagnostic
    fi
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
# The runtime identity a verifier DEMANDS, derived here rather than read out of the image: same generator,
# same wasmtime, so it must match byte for byte what build-domain.sh wrote into the domain. And one that
# differs in a single field, to prove the pin is load-bearing.
if [ "${RECHECK:-0}" != 1 ]; then
  "$here/../contract/runtime-identity.sh" "$(command -v wasmtime)" > "$W/expected-runtime.json"
  sed 's/"version":"[^"]*"/"version":"0.0.0-not-this-one"/' "$W/expected-runtime.json" > "$W/wrong-runtime.json"
fi
predA=$(sed -n 's/^predicted measurement: //p' "$W/build-A.txt")
shaA=$(sha256sum "$W/app-A.wasm" | cut -c1-64)
if [ "${RECHECK:-0}" != 1 ]; then
  serve s1 snp full
  serve s2 snp basic
  serve t1 plain full
  # forged and unsigned evidence, judged offline by the client's own judge(), plus s1's genuine report
  node "$here/negative.mjs" --measurement "$predA" --app-sha "$shaA" --genuine "$W/s1.doc.json" --vcek "$W/vcek.der" \
    > "$W/negative.txt" 2>&1 || true
fi

echo "evidence: app A sha256 $shaA"
echo "evidence: predicted   $predA"
echo "evidence: live s1     $(res "$W/s1.client" measurement)"
echo "evidence: live s2     $(res "$W/s2.client" measurement)"
echo "evidence: $(grep -E '^(product|test-floor|kds)' "$W/vcek-prep.txt" 2>/dev/null | tr '\n' ' ')"
cmp -s "$W/dom-A.cpio.gz" "$W/dom-A2.cpio.gz" && r=ok || r=no
check "0 build reproducible: two builds of the domain are byte-identical" $r
[ -n "$predA" ] && [ "$(res "$W/s1.client" measurement)" = "$predA" ] && [ "$(res "$W/s2.client" measurement)" = "$predA" ] && r=ok || r=no
check "1 measurement reproducible: live == predicted, both launches" $r

tr -d '\r' < "$W/s1.client" | grep -a '^evidence:' | sed 's/^/    /' || true
for t in s1 s2; do
  [ "$(verdict "$W/$t.client")" = attested ] && [ "$(res "$W/$t.client" gate)" = open ] && [ "$(res "$W/$t.client" tcb_checked)" = 1 ] \
    && grep -aq 'AMD signature chain verified' "$W/$t.client" && grep -aq 'VCEK chip ID and TCB extensions match the report' "$W/$t.client" \
    && r=ok || r=no
  check "2 $t ATTESTED, live: AMD chain to the pinned root, VCEK names this chip and TCB, TCB meets the supplied (test) floor, key+nonce bound, app named" $r
done
[ "$(res "$W/s1.client" second_nonce_verdict)" = attested ] && [ "$(res "$W/s1.client" key_stable_in_launch)" = 1 ] && r=ok || r=no
check "2b a second nonce on a new, pinned connection: attested again, same key" $r
[ "$(res "$W/s1.client" replay_rejected)" = 1 ] && r=ok || r=no
check "2c a report does not satisfy a different nonce (no replay)" $r
# ABI/2: the app is one portable WebAssembly component compiled INSIDE the domain, so the runtime that
# compiled it is part of what the report vouches for (isolation/contract/RUNTIME.md). These three checks are
# the whole property: the domain states an identity and binds it, a verifier that pins it still gets
# ATTESTED, and a verifier that pins a different one is refused on the binding.
echo "evidence: expected runtime $(cat "$W/expected-runtime.json" 2>/dev/null)"
echo "evidence: domain  runtime $(res "$W/s1.client" runtime)"
echo "evidence: domain  selftest $(res "$W/s1.client" runtime_selftest)"
[ "$(res "$W/s1.client" abi)" = enclave-domain-abi/2 ] && [ "$(res "$W/s1.client" runtime_pinned)" = 1 ]   && [ "$(verdict "$W/s1.client")" = attested ] && [ "$(res "$W/s1.client" gate)" = open ]   && grep -aq 'runtime identity is the expected one' "$W/s1.client"   && grep -aq "report_data binds the caller's expected binding" "$W/s1.client" && r=ok || r=no
check "2h ABI/2 live: the domain bound its runtime identity into report_data, a verifier that PINS that identity still gets attested" $r
grep -aq 'exec_pages=allowed wx=clean' "$W/s1.client" && grep -aq 'found no writable-and-executable mapping' "$W/s1.client"   && grep -aq 'may hold an executable page' "$W/s1.client" && r=ok || r=no
check "2i the domain MEASURED its own runtime before stating it: an executable page is permitted (execution=jit is possible) and no page is writable AND executable (W^X)" $r
closed() {   # closed <file> <verdict> <reason regex>: that verdict, gate closed, exit 3, no application request
  [ "$(verdict "$1")" = "$2" ] && grep -aqE "$3" "$1" && [ "$(res "$1" gate)" = closed ] \
    && [ "$(res "$1" exit)" = 3 ] && [ "$(res "$1" app_requests_sent)" = 0 ]
}
closed "$W/s1.probe" reject 'no VCEK available' && closed "$W/t1.probe" not-attested 'never trusted' && r=ok || r=no
check "2d the trusted default holding no VCEK refuses the T1 report, and refuses T0; no application request either time" $r
closed "$W/s1.nopolicy" no-tcb-policy 'no minimum-TCB policy' && r=ok || r=no
check "2e the chain verified but NO minimum-TCB policy was supplied: not accepted, gate closed, nothing sent" $r
closed "$W/s1.above" reject 'reported TCB below policy' && r=ok || r=no
check "2f a floor one SNP version above the box: REJECTED on the TCB, nothing sent" $r
closed "$W/s1.rtwrong" reject 'runtime identity differs from the expected one in version' && r=ok || r=no
check "2j a verifier expecting a DIFFERENT runtime version is refused, gate closed, nothing sent (the binding itself is proved on the genuine report by N9h)" $r
tr -d '\r' < "$W/negative.txt" | grep -aE '^(PASS|FAIL|evidence)' | sed 's/^/    /' || true
grep -aq '^NEGATIVE: ALL PASS' "$W/negative.txt" && r=ok || r=no
check "2g forged, unsigned and TCB-policy evidence (offline, incl. s1's genuine report): every case as expected" $r
[ "$(verdict "$W/s1.lab")" = unauthenticated ] && [ "$(res "$W/s1.lab" app_status)" = 200 ] && r=ok || r=no
check "3 the lab diagnostic without the chain says UNAUTHENTICATED, and is the only mode that serves on it" $r

k1=$(res "$W/s1.client" spki_sha256); k2=$(res "$W/s2.client" spki_sha256)
c1=$(dom "$W/s1.serial" spki_sha256)
echo "evidence: s1 key the client pinned $k1, key the domain minted $c1; s2 pinned $k2"
[ -n "$k1" ] && [ "$k1" = "$c1" ] && r=ok || r=no
check "4 TLS ends inside the domain: the attested handshake key is the one the domain minted" $r
mapp=$(grep -a -c -E '/hello|/echo|GET /p ' "$W/s1.mitm-plain" 2>/dev/null || true)
echo "evidence: host-in-the-middle: $(tr -d '\r' < "$W/s1.mitm" | grep -a -m1 '^VERDICT'); the host read $(stat -c %s "$W/s1.mitm-plain" 2>/dev/null || echo 0) plaintext bytes, application requests among them: ${mapp:-0}"
closed "$W/s1.mitm" reject 'does not bind' && [ "${mapp:-0}" = 0 ] && r=ok || r=no
check "4b a host that terminates TLS itself is REJECTED on the binding, and receives no application request" $r
teeb=$(stat -c %s "$W/s1.tee" 2>/dev/null || echo 0)
hits=$(grep -a -c -E 'APP AAAAA|/hello|from=client|enclave-attestation' "$W/s1.tee" 2>/dev/null || true)
echo "evidence: the host relayed $teeb bytes for the s1 clients; plaintext markers found: ${hits:-0}"
[ "$teeb" -gt 1000 ] && [ "${hits:-0}" = 0 ] && r=ok || r=no
check "4c the host relays ciphertext only: no request or response plaintext in what it moved" $r
sp=$(stat -c %s "$W/s1.switch-plain" 2>/dev/null || echo 0)
echo "evidence: switched key: $(grep '^FWD conn' "$W/s1.fwd-switch" | tr '\n' ' ')/ $(tr -d '\r' < "$W/s1.switch" | grep -a -m1 '^VERDICT' | cut -c1-40) / $(tr -d '\r' < "$W/s1.switch" | grep -a 'ABORTED' | cut -c1-120)"
[ "$(verdict "$W/s1.switch")" = attested ] && [ "$(res "$W/s1.switch" app_aborted)" = pin-mismatch ] && [ "$(res "$W/s1.switch" exit)" = 4 ] \
  && [ "$(res "$W/s1.switch" app_requests_sent)" = 0 ] && [ "$(res "$W/s1.switch" refused_handshakes)" -ge 1 ] \
  && grep -q '^FWD conn 2 mitm' "$W/s1.fwd-switch" && [ "$sp" = 0 ] && r=ok || r=no
check "4d after an ATTESTED handshake, a reconnect to a switched key is refused AT THE HANDSHAKE: aborted, $sp plaintext bytes to the host" $r
[ -n "$k1" ] && [ -n "$k2" ] && [ "$k1" != "$k2" ] && r=ok || r=no
check "5 key minted per launch: s1 and s2 keys differ, identity (check 1) does not" $r

b1=$(res "$W/s1.client" app_body); bt=$(res "$W/t1.client" app_body)
echo "evidence: T1 app says $b1 / T0 app says $bt"
[ "$(res "$W/s1.client" app_status)" = 200 ] && [ "$b1" = '"APP AAAAA path=/hello?from=client"' ] \
  && [ "$(res "$W/s1.client" app_on_pinned_key)" = 1 ] && r=ok || r=no
check "6 the app serves through the domain's port on the ATTESTED key" $r
[ "$(res "$W/s1.perf" echo_intact)" = 1 ] && [ "$(verdict "$W/s1.perf")" = attested ] && [ "$(res "$W/t1.perf" echo_intact)" = 1 ] && r=ok || r=no
check "6b 4 x 16 MiB echoed intact through the domain (T1 attested, T0 diagnostic)" $r

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
    "$(res "$W/$t.probe" first_attestation_ms)" \
    "$(awk -v n="$(sed -n 's/^HOST CPUUsageNSec=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.1f", n / 1e9 }')" \
    "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')"
done
for t in s1 t1; do
  printf '%-3s request latency p50 %sms p99 %sms (sequential, one kept-alive TLS connection); echo %s MB/s\n' "$t" \
    "$(res "$W/$t.perf" latency_p50_ms)" "$(res "$W/$t.perf" latency_p99_ms)" "$(res "$W/$t.perf" echo_mb_per_s)"
done
echo "workdir $W"
[ "$fails" -eq 0 ] && echo "M2: ALL PASS" || { echo "M2: $fails FAILED"; exit 1; }
