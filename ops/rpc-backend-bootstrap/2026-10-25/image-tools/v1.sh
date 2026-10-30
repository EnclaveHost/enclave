#!/usr/bin/env bash
# v1 verify (queue 1024, separate job from the build): measurement B from the artifacts on disk (cmdline from the artifact),
# artifact hashes == build receipt, tools/verify-image-cv.py (own cpio reader; bytes vs git at the commit; RECIPE natives), then
# D's import check of the extracted image under the loopback-only fetch guard + node --check of the chain-verifier runtime.
set -euo pipefail
. "$(dirname "$0")/env.sh"
X=$B/tmp/extract
need "OVMF pin" [ "$(sha256sum < "$OVMF" | cut -c1-64)" = 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9 ]
need "artifacts == build receipt" sha256sum -c --quiet "$R/artifacts-A.sha256"
need "release tar == build receipt" sha256sum -c --quiet "$R/release-tar.sha256"
Bm=$($MEASURE --append "$(sed 's/\${MODE}/snp/' "$OUT/cmdline" | tr -d '\n')" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "[measure B] $Bm (cmdline taken from the artifact's own cmdline file)"
need "measurement B == measurement A" [ "$Bm" = "$(cat "$OUT/MEASUREMENT")" ]
echo "$Bm" > "$R/measurement-B.txt"
need "release tar == git archive of $C (fresh)" cmp -s <(git -C "$S" archive --format=tar "$C") "$B/release-$C9.tar"
rm -rf "$X"
python3 -u "$B/tools/verify-image-cv.py" "$S" "$C" "$OUT" "$X" "$V" "$R/inputs-precheck.json" "$R/image-verify.json"
node --import "$S/test/helpers/loopback-only-fetch.mjs" "$B/tools/import-check-relay.mjs" "$S" "$X" | tee "$R/import-check.json"
for f in $(cd "$X/app" && node -e '
  import(require("url").pathToFileURL(process.argv[1]).href).then(({supervisorClosure}) => {
    const { files } = supervisorClosure(process.cwd(), ["network/rpc-runtime-main.mjs"]);
    console.log(files.filter((f) => /\.m?js$/.test(f)).join("\n")); })' "$S/metal/supervisor-closure.mjs" 2>/dev/null || true); do
  node --check "$X/app/$f" || { echo "[FAIL] node --check app/$f"; exit 9; }; echo "[check] app/$f"; done | tee "$R/runtime-syntax.txt"
need "chain-verifier runtime closure syntax-checked ($(grep -c "^\[check\]" "$R/runtime-syntax.txt") files)" [ "$(grep -c "^\[check\]" "$R/runtime-syntax.txt")" -gt 0 ]
node --check "$X/app/network/rpc-runtime-main.mjs" && node --check "$X/opt/metal/chain-verifier.mjs" && echo "[ok] node --check rpc-runtime-main.mjs + chain-verifier.mjs"
rm -rf "$X" "$S/metal/__pycache__"
need "src still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
stub_none
echo VERIFY-OK
