#!/usr/bin/env bash
# build (queue 1536; adapted from measured-image-build/tools/build.sh): pins -> calibration (the same recipe reproduces
# production b8376e15 and KEPT ed918e4b) -> the install set from commit 493ee9ee == the s1 precheck -> the overlay with
# --control direct -> measurement A.
set -euo pipefail
. "$(dirname "$0")/env.sh"
S=$B/src; C=493ee9ee07497c94159ec4f6916e9ea920d31959; TREE=b21163723ea789db13ff84d148e309e2709a89f4
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
KEPT=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90
OVMF=$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd; OUT=$B/image/dist-direct-493ee9ee0
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF"
BASE_APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
DIRECT_APPEND="$BASE_APPEND metal.control=direct"
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
pin() { local got; got=$(sha256sum < "$1" | cut -c1-64); [ "$got" = "$2" ] && echo "[pin] OK $1 $got" || { echo "[pin] MISMATCH $1 $got (want $2)"; exit 7; }; }
[ ! -e "$OUT" ] || { echo "$OUT exists"; exit 2; }
echo "== 1 pins"
pin "$BASE/manifest.json" cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
pin "$OVMF" 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
need "base cmdline = the template" [ "$(tr -d '\n' < "$BASE/cmdline")" = "${BASE_APPEND/metal.mode=snp/metal.mode=\${MODE\}}" ]
echo "[tool] $($HOME/.local/bin/sev-snp-measure --version 2>&1)"
echo "== 2 calibration"
m=$($MEASURE --append "$BASE_APPEND" --kernel "$BASE/vmlinuz" --initrd "$BASE/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$BASE/MEASUREMENT")" ] && echo "[cal] production base reproduced $m" || { echo "[cal] BASE MISMATCH $m"; exit 8; }
m=$($MEASURE --append "$BASE_APPEND" --kernel "$KEPT/vmlinuz" --initrd "$KEPT/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$KEPT/MEASUREMENT")" ] && echo "[cal] KEPT reproduced $m" || { echo "[cal] KEPT MISMATCH $m"; exit 8; }
echo "== 3 source + inputs"
need "src HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "src tree $TREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$TREE" ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
need "overlay tool working copy == commit ($(sha256sum < "$S/metal/overlay-control-image.py" | cut -c1-64))" cmp -s <(git -C "$S" show "$C:metal/overlay-control-image.py") "$S/metal/overlay-control-image.py"
python3 -u "$B/tools/verify-inputs.py" "$S" "$B/receipts/inputs-build.json" "$B/receipts/inputs-precheck.json"
rm -rf "$S/metal/__pycache__"
echo "== 4 overlay"
date -u +%FT%TZ > "$B/receipts/build-started.utc"
python3 "$S/metal/overlay-control-image.py" --control direct "$BASE" "$OUT" "$C"
date -u +%FT%TZ > "$B/receipts/build-finished.utc"
rm -rf "$S/metal/__pycache__"; need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo "== 5 measurement A"
A=$($MEASURE --append "$DIRECT_APPEND" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "$A" > "$OUT/MEASUREMENT"; echo "[measure A] $A"
sha256sum "$OUT"/* | tee "$B/receipts/artifacts-A.sha256"; stat -c '%s %n' "$OUT"/*
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo "BUILD-OK"
