#!/bin/sh
# Milestone 1 tests (isolation/DESIGN.md section 7): one Wasm app -> one measured domain, on T1 (SNP)
# and T0 (plain KVM). Our own VMs on our own lab host, documented interfaces only. Every check prints
# PASS/FAIL with the evidence it compared.
#
# usage: test-m1.sh [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:-$(mktemp -d)}; mkdir -p "$W"
ROUNDS=${ROUNDS:-1500000000}
rnd() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# the guest prints through a serial console, so every line ends \r\n: strip the \r before comparing
field() { tr -d '\r' < "$1" | grep -a "^DOM $2=" | head -1 | sed "s/^DOM $2=//; s/ .*//"; }
num() { tr -d '\r' < "$1" | grep -aoE "$2=[0-9]+" | head -1 | cut -d= -f2; }
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# RECHECK=1 re-evaluates the saved outputs in an existing workdir without booting anything.
if [ "${RECHECK:-0}" != 1 ]; then
for L in AAAAA BBBBB; do
  sed -e "s/@LABEL@/$L/" -e "s/@ROUNDS@/$ROUNDS/" "$here/app.wat.in" > "$W/app-$L.wat"
  wasm-tools parse "$W/app-$L.wat" -o "$W/app-$L.wasm"
  "$here/build-domain.sh" "$W/app-$L.wasm" "$W/dom-$L.cpio.gz" 1 > "$W/build-$L.txt"
done
n1=$(rnd); n2=$(rnd)

"$here/run-domain.sh" "$W/dom-AAAAA.cpio.gz" snp   1 512 100 "$n1" > "$W/r1-A-snp.txt"
"$here/run-domain.sh" "$W/dom-AAAAA.cpio.gz" snp   1 512 100 "$n2" > "$W/r2-A-snp-n2.txt"
"$here/run-domain.sh" "$W/dom-BBBBB.cpio.gz" snp   1 512 100 "$n1" > "$W/r3-B-snp.txt"
"$here/run-domain.sh" "$W/dom-AAAAA.cpio.gz" plain 1 512 100 "$n1" > "$W/r4-A-plain.txt"
"$here/run-domain.sh" "$W/dom-AAAAA.cpio.gz" snp   1 512 25  "$n1" > "$W/r5-A-snp-q25.txt"
fi
predA=$(sed -n 's/^predicted measurement: //p' "$W/build-AAAAA.txt")
predB=$(sed -n 's/^predicted measurement: //p' "$W/build-BBBBB.txt")
shaA=$(sha256sum "$W/app-AAAAA.wasm" | cut -c1-64)
shaB=$(sha256sum "$W/app-BBBBB.wasm" | cut -c1-64)
# the nonces each run was given, read back from what the HOST passed (not from the guest)
n1=$(tr -d '\r' < "$W/r1-A-snp.txt" | sed -n 's/^HOST .*nonce=//p'); n2=$(tr -d '\r' < "$W/r2-A-snp-n2.txt" | sed -n 's/^HOST .*nonce=//p')

m1=$(field "$W/r1-A-snp.txt" measurement); m2=$(field "$W/r2-A-snp-n2.txt" measurement)
m3=$(field "$W/r3-B-snp.txt" measurement)
echo "evidence: predicted A $predA"
echo "evidence: live A      $m1 (again: $m2)"
echo "evidence: predicted B $predB"
echo "evidence: live B      $m3"
[ -n "$m1" ] && [ "$m1" = "$predA" ] && r=ok || r=no; check "1 measurement reproducible: live A == predicted A" $r
[ -n "$m3" ] && [ "$m3" = "$predB" ] && r=ok || r=no; check "1b measurement reproducible: live B == predicted B" $r
[ -n "$m1" ] && [ "$m1" != "$m3" ] && r=ok || r=no;   check "2 app bound into identity: A != B" $r
[ -n "$m1" ] && [ "$m1" = "$m2" ] && r=ok || r=no;    check "2b same app, new nonce: identity unchanged" $r
[ "$(field "$W/r1-A-snp.txt" report_data)" = "$shaA$n1" ] && r=ok || r=no;    check "3 report_data = sha256(A) || nonce1" $r
[ "$(field "$W/r2-A-snp-n2.txt" report_data)" = "$shaA$n2" ] && r=ok || r=no; check "3b report_data follows the nonce (nonce2)" $r
[ "$(field "$W/r3-B-snp.txt" report_data)" = "$shaB$n1" ] && r=ok || r=no;    check "3c report_data names app B for B" $r
[ "$(num "$W/r1-A-snp.txt" vmpl)" = 0 ] && [ "$(num "$W/r1-A-snp.txt" snp)" = 1 ] && r=ok || r=no
check "3d SNP active, report at VMPL0" $r

full=$(num "$W/r1-A-snp.txt" app_ms); q25=$(num "$W/r5-A-snp-q25.txt" app_ms)
ratio=$(awk -v a="$q25" -v b="$full" 'BEGIN { if (b > 0) printf "%.2f", a / b; else print 0 }')
echo "evidence: app_ms at 100% $full, at 25% $q25, ratio $ratio (4.00 = exactly the quota)"
awk -v r="$ratio" 'BEGIN { exit !(r >= 3.0 && r <= 5.5) }' && r=ok || r=no
check "4 CPU share enforced: 25% quota slows the app ~4x" $r

appA=$(tr -d '\r' < "$W/r1-A-snp.txt" | grep -a '^APP '); appP=$(tr -d '\r' < "$W/r4-A-plain.txt" | grep -a '^APP ')
echo "evidence: T1 output '$appA' / T0 output '$appP'"
[ -n "$appA" ] && [ "$appA" = "$appP" ] && r=ok || r=no; check "6 tier parity: same image, same app output on T0 and T1" $r
[ "$(num "$W/r4-A-plain.txt" snp)" = 0 ] && ! grep -aq '^DOM report_bytes' "$W/r4-A-plain.txt" && r=ok || r=no
check "6b T0 domain is not SNP and produces no report" $r

echo "--- 5 lifecycle cost (measured, no pass/fail) ---"
for f in r1-A-snp r4-A-plain r5-A-snp-q25; do
  printf '%-14s guest boot->init %sms, app %sms, host launch->poweroff %sms, %s\n' "$f" \
    "$(num "$W/$f.txt" boot_ms)" "$(num "$W/$f.txt" app_ms)" "$(num "$W/$f.txt" wall_ms)" \
    "$(grep -aoE 'Memory peak: [^,]+' "$W/$f.txt" | head -1)"
done
echo "workdir $W"
[ "$fails" -eq 0 ] && echo "M1: ALL PASS" || { echo "M1: $fails FAILED"; exit 1; }
