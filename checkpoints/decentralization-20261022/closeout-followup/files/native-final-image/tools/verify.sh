#!/usr/bin/env bash
# verify (queue 1536, a separate job from the build; adapted from measured-image-build/tools/verify.sh): measurement B in a
# fresh process from the artifacts on disk, artifact hashes == the build's receipt, tools/verify-image.py (entries/manifest/
# closure from the image's own bytes), then the node import check from the extracted image under the loopback-only fetch guard.
# The extraction is removed afterwards.
set -euo pipefail
. "$(dirname "$0")/env.sh"
S=$B/src; OUT=$B/image/dist-direct-493ee9ee0; X=$B/tmp/extract
OVMF=$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
need "OVMF pin" [ "$(sha256sum < "$OVMF" | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ]
need "artifacts == build receipt" sha256sum -c --quiet "$B/receipts/artifacts-A.sha256"
Bm=$($HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf "$OVMF" \
  --append "$(sed 's/\${MODE}/snp/' "$OUT/cmdline" | tr -d '\n')" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "[measure B] $Bm (cmdline taken from the artifact's own cmdline file)"
need "measurement B == measurement A" [ "$Bm" = "$(cat "$OUT/MEASUREMENT")" ]
rm -rf "$X"
python3 -u "$B/tools/verify-image.py" "$S" "$OUT" "$X" "$B/receipts/image-verify.json"
node --import "$S/test/helpers/loopback-only-fetch.mjs" "$B/tools/import-check.mjs" "$S" "$X" | tee "$B/receipts/import-check.json"
rm -rf "$X" "$S/metal/__pycache__"
need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo VERIFY-OK
