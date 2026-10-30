#!/usr/bin/env bash
# b1 (queue 1024; RECIPE-IMAGE.md step 3): pins -> overlay unittest at the commit (recorded, not gating) -> calibration (base
# b8376e15, KEPT ed918e4b) -> install set recomputed == s1 -> overlay with --chain-verifier-dir, NO --control -> measurement A
# -> the host launcher's release tree (git archive).
set -euo pipefail
. "$(dirname "$0")/env.sh"
[ ! -e "$OUT" ] || { echo "$OUT exists"; exit 2; }
echo "== 1 pins"
pin "$BASE/manifest.json" cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
pin "$OVMF" 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
pin "$KEPT/initramfs.cpio.gz" c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3
(cd "$V" && sha256sum -c --quiet PINS.sha256) && echo "[ok] chain-verifier-inputs PINS.sha256"
need "base cmdline = the template" [ "$(tr -d '\n' < "$BASE/cmdline")" = "${APPEND/metal.mode=snp/metal.mode=\${MODE\}}" ]
need "KEPT cmdline = base cmdline" cmp -s "$BASE/cmdline" "$KEPT/cmdline"
echo "[tool] $($HOME/.local/bin/sev-snp-measure --version 2>&1)"
need "src HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "src tree $TREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$TREE" ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo "== 2 overlay unittest at the commit (informational)"
set +e; (cd "$S" && timeout -k 5 600 python3 -u test/metal-control-overlay.test.py) > "$B/tmp/overlay-unittest.out" 2>&1; urc=$?; set -e
rm -rf "$S/metal/__pycache__" "$S/test/__pycache__"
tail -5 "$B/tmp/overlay-unittest.out"; echo "[unittest] rc=$urc"; cp "$B/tmp/overlay-unittest.out" "$R/overlay-unittest.out"
need "src clean after unittest" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
echo "== 3 calibration"
m=$($MEASURE --append "$APPEND" --kernel "$BASE/vmlinuz" --initrd "$BASE/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$BASE/MEASUREMENT")" ] && [ "${m:0:8}" = b8376e15 ] && echo "[cal] production base reproduced $m" || { echo "[cal] BASE MISMATCH $m"; exit 8; }
m=$($MEASURE --append "$APPEND" --kernel "$KEPT/vmlinuz" --initrd "$KEPT/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$KEPT/MEASUREMENT")" ] && [ "$m" = ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2 ] \
  && echo "[cal] KEPT (production Linux runtime) reproduced $m" || { echo "[cal] KEPT MISMATCH $m"; exit 8; }
echo "== 4 install set recomputed == s1"
python3 -I "$L/tools/image-inputs.py" "$S" "$C" "$V" "$R/inputs-build.json" > "$B/tmp/inputs-build.out"
rm -rf "$S/metal/__pycache__"
python3 - "$R/inputs-precheck.json" "$R/inputs-build.json" <<'EOF'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:])
same = all(a[k] == b[k] for k in ("commit", "tree", "overlayTool", "inputs", "nativeInputs", "chainVerifier"))
print("[inputs] build == precheck:", same, len(a["inputs"]), "committed +", len(a["nativeInputs"]), "native"); sys.exit(0 if same and b["ok"] else 9)
EOF
echo "== 5 overlay (relay mode: no --control; --chain-verifier-dir)"
date -u +%FT%TZ > "$R/build-started.utc"
python3 "$S/metal/overlay-control-image.py" --chain-verifier-dir "$V" "$BASE" "$OUT" "$C"
date -u +%FT%TZ > "$R/build-finished.utc"
rm -rf "$S/metal/__pycache__"; need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
need "output cmdline == base cmdline" cmp -s "$BASE/cmdline" "$OUT/cmdline"
echo "== 6 measurement A"
A=$($MEASURE --append "$APPEND" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "$A" > "$OUT/MEASUREMENT"; echo "[measure A] $A"
sha256sum "$OUT"/* | tee "$R/artifacts-A.sha256"; stat -c '%s %n' "$OUT"/*
echo "== 7 host release tree (git archive of the commit, no node_modules)"
REL=$B/release-$C9.tar
[ ! -e "$REL" ] || { echo "$REL exists"; exit 2; }
git -C "$S" archive --format=tar -o "$REL" "$C"
git -C "$S" archive --format=tar "$C" | cmp -s - "$REL" && echo "[ok] git archive deterministic (second pass byte-identical)" || { echo "[FAIL] git archive differs"; exit 9; }
sha256sum "$REL" | tee "$R/release-tar.sha256"; stat -c '%s %n' "$REL"
stub_none
echo BUILD-OK
