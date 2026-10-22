#!/usr/bin/env bash
# rebuild2 (queue 1536; adapted from measured-image-build/tools/rebuild2.sh): the SECOND independent overlay build
# docs/network/measured-control-guest.md requires (step 3: "a second rebuild"). Same commit 493ee9ee, same pinned base, OVMF and
# tool, a NEW output dir; output A is never written (its hashes are checked before and after). The second output is measured on
# its own, then compared with A file by file.
set -euo pipefail
. "$(dirname "$0")/env.sh"
S=$B/src; C=493ee9ee07497c94159ec4f6916e9ea920d31959; TREE=b21163723ea789db13ff84d148e309e2709a89f4
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
A=$B/image/dist-direct-493ee9ee0; O2=$B/image/dist-direct-493ee9ee0-rebuild2
OVMF=$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
[ ! -e "$O2" ] || { echo "$O2 exists"; exit 2; }
need "output A unchanged before" sha256sum -c --quiet "$B/receipts/artifacts-A.sha256"
need "base initramfs pin" [ "$(sha256sum < "$BASE/initramfs.cpio.gz" | cut -c1-64)" = 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc ]
need "base kernel pin" [ "$(sha256sum < "$BASE/vmlinuz" | cut -c1-64)" = 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7 ]
need "base manifest pin" [ "$(sha256sum < "$BASE/manifest.json" | cut -c1-64)" = cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0 ]
need "OVMF pin" [ "$(sha256sum < "$OVMF" | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ]
need "src HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "src tree $TREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$TREE" ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
need "overlay tool == commit (1067a535)" [ "$(sha256sum < "$S/metal/overlay-control-image.py" | cut -c1-64)" = 1067a535413f88e0c66b80441a734d5dc7771ac79e24129df25df8a1d4aeea56 ]
date -u +%FT%TZ > "$B/receipts/rebuild2-started.utc"
python3 "$S/metal/overlay-control-image.py" --control direct "$BASE" "$O2" "$C"
date -u +%FT%TZ > "$B/receipts/rebuild2-finished.utc"
rm -rf "$S/metal/__pycache__"; need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
M2=$($HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf "$OVMF" \
  --append "$(sed 's/\${MODE}/snp/' "$O2/cmdline" | tr -d '\n')" --kernel "$O2/vmlinuz" --initrd "$O2/initramfs.cpio.gz" --output-format hex)
echo "$M2" > "$O2/MEASUREMENT"; echo "[measure rebuild2] $M2"
sha256sum "$O2"/* | tee "$B/receipts/artifacts-rebuild2.sha256"; stat -c '%s %n' "$O2"/*
drift=0
for f in vmlinuz initramfs.cpio.gz cmdline manifest.json MEASUREMENT; do
  if cmp -s "$A/$f" "$O2/$f"; then echo "[same] $f"; else echo "[DRIFT] $f"; drift=1; fi
done
if [ $drift -ne 0 ]; then diff <(python3 -m json.tool "$A/manifest.json") <(python3 -m json.tool "$O2/manifest.json") | head -40 || true; fi
need "output A unchanged after" sha256sum -c --quiet "$B/receipts/artifacts-A.sha256"
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
[ $drift -eq 0 ] && echo "REBUILD2-REPRODUCIBLE" || { echo "REBUILD2-DRIFT"; exit 11; }
