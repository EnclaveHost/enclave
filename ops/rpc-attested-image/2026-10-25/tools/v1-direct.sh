#!/usr/bin/env bash
# v1-direct (queue 1024, separate job): A == B byte parity of every artifact; measurement recomputed from A's artifacts on
# disk (pinned OVMF, 4 vCPU recipe, cmdline from the artifact) == both builds' recorded values; the independent direct-mode
# verifier (own newc reader, bytes vs git at the commit, natives vs the RECIPE table + PINS + commit record).
set -euo pipefail
. "$(dirname "$0")/env.sh"
OA=$B/out/dist-direct-$C-a; OB=$B/out/dist-direct-$C-b; X=$B/tmp/extract-direct; R=$B/receipts
need "OVMF pin" [ "$(sha256sum < "$OVMF" | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ]
for f in initramfs.cpio.gz vmlinuz manifest.json cmdline MEASUREMENT; do need "A == B: $f" cmp -s "$OA/$f" "$OB/$f"; done
need "A artifacts == A build receipt" bash -c "cd '$OA' && sha256sum -c --quiet '$R/build-a/artifacts.sha256'"
need "B artifacts == B build receipt" bash -c "cd '$OB' && sha256sum -c --quiet '$R/build-b/artifacts.sha256'"
Bm=$($MEASURE --append "$(sed 's/\${MODE}/snp/' "$OA/cmdline" | tr -d '\n')" --kernel "$OA/vmlinuz" --initrd "$OA/initramfs.cpio.gz" --output-format hex)
echo "[measure B] $Bm"; need "measurement B == recorded A" [ "$Bm" = "$(cat "$OA/MEASUREMENT")" ]; echo "$Bm" > "$R/measurement-B.txt"
rm -rf "$X"
python3 -u "$B/tools/verify-image-direct.py" "$SA" "$C" "$OA" "$X" "$V" - "$R/image-verify-direct.json"
rm -rf "$X" "$SA/metal/__pycache__"
need "src still clean" [ -z "$(git -C "$SA" status --porcelain --untracked-files=all)" ]
stub_none
echo VERIFY-OK
