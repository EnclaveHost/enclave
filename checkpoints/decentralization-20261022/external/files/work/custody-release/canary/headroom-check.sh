#!/bin/bash
# READ-ONLY preflight for ONE quote-only SNP canary guest of a release image on THIS host. Changes nothing; never takes the
# shared test queue's locks. Exit 0 only when every gate passes.
#   headroom-check.sh <release image dir> <memMiB> <hostPort> <mgmtPort> <stateDir parent>
set -uo pipefail
DIST=$1 MEM=$2 HP=$3 MP=$4 STATE=$5
OVMF=${OVMF:-$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd}
FLOOR=16384 MARGIN=1024 ok=1
gate() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; ok=0; fi; }
sha() { sha256sum "$1" | cut -c1-64; }
m() { node -e "console.log(require('$DIST/manifest.json')$1)"; }
gate "SEV-SNP enabled in kvm_amd"                  '[ "$(cat /sys/module/kvm_amd/parameters/sev_snp 2>/dev/null)" = Y ]'
gate "/dev/sev present and usable by this user"    '[ -r /dev/sev ] && [ -w /dev/sev ]'
gate "release manifest role enclave-custodian-v2 or enclave-custody-rewrap" '[[ "$(m .role)" =~ ^(enclave-custodian-v2|enclave-custody-rewrap)$ ]]'
gate "initramfs sha256 == manifest"                '[ "$(sha "$DIST/initramfs.cpio.gz")" = "$(m .initramfs.sha256)" ]'
gate "vmlinuz sha256 == manifest"                  '[ "$(sha "$DIST/vmlinuz")" = "$(m .kernel.sha256)" ]'
gate "OVMF sha256 == manifest (the measured firmware)" '[ "$(sha "$OVMF")" = "$(m .ovmfSha256)" ]'
gate "cmdline file == manifest cmdline"            '[ "$(tr -d "\n" < "$DIST/cmdline")" = "$(m .cmdline)" ]'
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); NEED=$((FLOOR + MEM + MARGIN))
gate "MemAvailable ${AVAIL} MiB >= ${FLOOR} reserve + ${MEM} guest + ${MARGIN} margin = ${NEED} MiB" '[ "$AVAIL" -ge "$NEED" ]'
gate "loopback hostPort $HP free"                  '! ss -ltnH "sport = :$HP" | grep -q .'
gate "loopback mgmtPort $MP free"                  '! ss -ltnH "sport = :$MP" | grep -q .'
gate "state parent exists with >= 1 GiB free"      '[ -d "$STATE" ] && [ "$(df -Pm "$STATE" | awk "NR==2{print \$4}")" -ge 1024 ]'
echo "info  running SNP guests: $(pgrep -fc 'sev-snp-guest' || true)"
echo "info  shared test queue jobs running: $(pgrep -fc 'claude-test-queue.py' || true) (a canary should wait for a quiet window)"
echo "info  release measurement $(m .measurement)"
[ $ok = 1 ] && echo "PREFLIGHT PASS" || echo "PREFLIGHT FAIL"
exit $((1 - ok))
