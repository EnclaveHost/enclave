#!/usr/bin/env bash
# b1-direct SIDE (queue 1024): the dedicated verifier-only DIRECT image of $C from clone SIDE (a|b) into its own OUT.
# pins -> measurement-tool calibration (base b8376e15, KEPT ed918e4b) -> overlay unittest at the commit with
# CHAIN_VERIFIER_INPUTS (0 skips required) -> overlay --control direct --chain-verifier-dir -> cmdline check -> measurement.
set -euo pipefail
. "$(dirname "$0")/env.sh"
SIDE=$1; case $SIDE in a) S=$SA;; b) S=$SB;; *) echo "side a|b"; exit 2;; esac
KEPT=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90
OUT=$B/out/dist-direct-$C-$SIDE; R=$B/receipts/build-$SIDE; [ ! -e "$OUT" ] && [ ! -e "$R" ] || { echo "$OUT or $R exists"; exit 2; }
mkdir -p "$R" "$B/out"
echo "== 1 pins"
pin "$BASE/manifest.json" cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
pin "$OVMF" 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
pin "$KEPT/initramfs.cpio.gz" c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3
(cd "$V" && sha256sum -c --quiet PINS.sha256) && echo "[ok] chain-verifier-inputs PINS.sha256"
need "base cmdline = the template" [ "$(tr -d '\n' < "$BASE/cmdline")" = "${APPEND_BASE/metal.mode=snp/metal.mode=\${MODE\}}" ]
echo "[tool] $($HOME/.local/bin/sev-snp-measure --version 2>&1)"
need "src HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = 0235e7d9659f1ccbf9f258bd03593d26f32f3f3a ]
need "src tree" [ "$(git -C "$S" rev-parse HEAD^{tree})" = d36f220ab4258b91c6f909d720ef18ce21f73cbc ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo "== 2 overlay unittest at the commit, CHAIN_VERIFIER_INPUTS set (no skip allowed)"
set +e; (cd "$S" && CHAIN_VERIFIER_INPUTS="$V" timeout -k 5 600 python3 -u test/metal-control-overlay.test.py -v) > "$R/overlay-unittest.out" 2>&1; urc=$?; set -e
rm -rf "$S/metal/__pycache__" "$S/test/__pycache__"
tail -4 "$R/overlay-unittest.out"; echo "[unittest] rc=$urc"
need "overlay unittest passed" [ $urc -eq 0 ]
need "overlay unittest: no test skipped" [ -z "$(grep -E 'skipped|skip' "$R/overlay-unittest.out" | grep -v -E '^Ran ')" ]
need "src clean after unittest" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo "== 3 calibration"
m=$($MEASURE --append "$APPEND_BASE" --kernel "$BASE/vmlinuz" --initrd "$BASE/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$BASE/MEASUREMENT")" ] && [ "${m:0:8}" = b8376e15 ] && echo "[cal] production base reproduced $m" || { echo "[cal] BASE MISMATCH $m"; exit 8; }
m=$($MEASURE --append "$APPEND_BASE" --kernel "$KEPT/vmlinuz" --initrd "$KEPT/initramfs.cpio.gz" --output-format hex)
[ "$m" = ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2 ] && echo "[cal] KEPT reproduced $m" || { echo "[cal] KEPT MISMATCH $m"; exit 8; }
echo "== 4 overlay --control direct --chain-verifier-dir"
date -u +%FT%TZ > "$R/build-started.utc"
python3 "$S/metal/overlay-control-image.py" --control direct --chain-verifier-dir "$V" "$BASE" "$OUT" "$C"
date -u +%FT%TZ > "$R/build-finished.utc"
rm -rf "$S/metal/__pycache__"; need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
need "output cmdline == base cmdline + ' metal.control=direct'" [ "$(cat "$OUT/cmdline")" = "$(tr -d '\n' < "$BASE/cmdline") metal.control=direct" ]
echo "== 5 measurement A (cmdline from the artifact)"
APPEND=$(sed 's/\${MODE}/snp/' "$OUT/cmdline" | tr -d '\n'); echo "[append] $APPEND"
A=$($MEASURE --append "$APPEND" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "$A" > "$OUT/MEASUREMENT"; echo "[measure A/$SIDE] $A"
for k in c2442941 fe897820 b8376e15 ed918e4b; do need "measurement is not $k" [ "${A:0:8}" != $k ]; done
(cd "$OUT" && sha256sum *) | tee "$R/artifacts.sha256"; stat -c '%s %n' "$OUT"/*
stub_none
echo BUILD-OK-$SIDE
