#!/usr/bin/env bash
# final-proof-image-stage (PREPARED by Claude; NOT run): ONE verifier-only DIRECT image of the final candidate 10cdf913 over the
# verified production base, with the EXISTING pinned native inputs (no native rebuild), then an INDEPENDENT verification and
# measurement. Adapted from attested-image-stage/tools/{env.sh,c0-clone.sh,b1-direct.sh,v1-direct.sh} (originals untouched).
# NOT DONE HERE: SNP boot, attestation, canary acceptance, trust-list binding, production proof serving.
# Root, from work/rpc-production-final-20261025 (queue 1536, 16 GiB floor, private user+net namespace, loopback only):
#   bash jobs/q-exit-status.sh root-final-proof-image-0500 1536 unshare -rn bash final-proof-image-stage/jobs/final-image.sh
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
B=$W/final-proof-image-stage
V=$W/canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs   # root 0104 native inputs (helios 8250f08a)
REPO=$W/rpc-runtime-composition-stage/r11/src.git                                        # the candidate's object store (read only)
C=10cdf913b9b8bb168156e42da2a9a2a26c2526ad; TREE=3b0f8114c07dfb30f15720155659259a018caad7; SA=$B/src-a; SB=$B/src-b
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
KEPT=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-release/stage/dist-leasegas-deabf8f90
OVMF=$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF"
APPEND_BASE="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
OUT=$B/out/dist-direct-10cdf913; R=$B/receipts/build; X=$B/tmp/extract-direct
export PATH="$B/stub/bin:$PATH" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$B/tmp"
unset GIT_DIR GIT_WORK_TREE
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
pin() { local got; got=$(sha256sum < "$1" | cut -c1-64); [ "$got" = "$2" ] && echo "[pin] OK $1 $got" || { echo "[pin] MISMATCH $1 $got (want $2)"; exit 7; }; }
# ---- environment (env.sh's proofs, unchanged) ---------------------------------------------------------------------------------
for c in ssh scp sftp; do [ "$(command -v $c)" = "$B/stub/bin/$c" ] || { echo "STUB NOT SELECTED for $c"; exit 3; }; done
node -e 'const r=require("child_process").spawnSync("ssh",["-V","stub-proof"]);if(r.status!==255)process.exit(3)' || { echo "node child does not get the stub"; exit 3; }
ifs=$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\n' ' ')
[ "$ifs" = "lo " ] || { echo "NOT in a private network namespace (interfaces: $ifs)"; exit 3; }
[ -z "$(tail -n +2 /proc/self/net/route)" ] || { echo "a route exists in the job's namespace"; exit 3; }
echo "[env] stubs selected; private netns lo only, no route ($(readlink /proc/self/ns/net))"
STUB_BASE=$(wc -l < "$B/stub/invocations.log")
[ ! -e "$OUT" ] && [ ! -e "$R" ] && [ ! -e "$SA" ] && [ ! -e "$SB" ] || { echo "outputs/sources exist: refusing to reuse"; exit 2; }
mkdir -p "$R" "$B/out"
echo "== 1 pins (base, OVMF, calibration image, native inputs)"
pin "$BASE/manifest.json" cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
pin "$OVMF" 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
pin "$KEPT/initramfs.cpio.gz" c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3
(cd "$V" && sha256sum -c --quiet PINS.sha256) && echo "[ok] chain-verifier-inputs PINS.sha256"
pin "$V/helios" 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378
pin "$V/enclave-base-head-listener" 9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3
pin "$V/witness-check" 4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411
need "base cmdline = the template" [ "$(tr -d '\n' < "$BASE/cmdline")" = "${APPEND_BASE/metal.mode=snp/metal.mode=\${MODE\}}" ]
echo "[tool] $($HOME/.local/bin/sev-snp-measure --version 2>&1)"
echo "== 2 two INDEPENDENT clean sources at $C (c0-clone.sh rule: A copies packs, B is a --no-local re-pack of A)"
git clone -q --local --no-hardlinks --no-checkout "$REPO" "$SA" && git -C "$SA" -c advice.detachedHead=false checkout -q --detach "$C"
git clone -q --no-local --no-hardlinks --no-checkout "file://$SA" "$SB" && git -C "$SB" -c advice.detachedHead=false checkout -q --detach "$C"
for s in "$SA" "$SB"; do need "$(basename $s) HEAD $C" [ "$(git -C "$s" rev-parse HEAD)" = $C ]; need "$(basename $s) tree $TREE" [ "$(git -C "$s" rev-parse HEAD^{tree})" = $TREE ]
  need "$(basename $s) clean" [ -z "$(git -C "$s" status --porcelain --untracked-files=all)" ]; done
need "B shares no object store with A" [ ! -e "$SB/.git/objects/info/alternates" ]
need "MCP bundle at $C = the composed-run checked 280b6d05" [ "$(sha256sum < "$SA/metal/guest/mcp-server.bundle.mjs" | cut -c1-64)" = 280b6d05ae278570bd9c4c494606773daa8f8e18bdbae9215f5bb93afd79a005 ]
need "commit image record pins helios 8250f08a" grep -q '"8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378"' "$SA/metal/chain-verifier-image.json"
# the overlay tool, its 19-test file and the closure rules are blob-identical to r12 final debbfb37 (metal-control-overlay.test.py
# PASS there with CHAIN_VERIFIER_INPUTS): the unittest is NOT repeated; these exact blobs are required instead
need "overlay tool blob a7c41de8 (== r12 final)" [ "$(git -C "$SA" rev-parse $C:metal/overlay-control-image.py)" = a7c41de85f684f26f36c0a7782194defe757058e ]
need "overlay test blob ca7adf93 (== r12 final)" [ "$(git -C "$SA" rev-parse $C:test/metal-control-overlay.test.py)" = ca7adf93fd561bbcafb692dfe05e7a68eb2136ac ]
need "supervisor-closure blob 51500846 (== r12 final)" [ "$(git -C "$SA" rev-parse $C:metal/supervisor-closure.mjs)" = 51500846c95aa80a73695db4839598a0e1b37bed ]
echo "== 3 measurement-tool calibration"
m=$($MEASURE --append "$APPEND_BASE" --kernel "$BASE/vmlinuz" --initrd "$BASE/initramfs.cpio.gz" --output-format hex)
[ "$m" = "$(cat "$BASE/MEASUREMENT")" ] && [ "${m:0:8}" = b8376e15 ] && echo "[cal] production base reproduced $m" || { echo "[cal] BASE MISMATCH $m"; exit 8; }
m=$($MEASURE --append "$APPEND_BASE" --kernel "$KEPT/vmlinuz" --initrd "$KEPT/initramfs.cpio.gz" --output-format hex)
[ "$m" = ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2 ] && echo "[cal] KEPT reproduced $m" || { echo "[cal] KEPT MISMATCH $m"; exit 8; }
echo "== 4 ONE overlay: --control direct --chain-verifier-dir (from source A; BASE is never modified)"
date -u +%FT%TZ > "$R/build-started.utc"
python3 "$SA/metal/overlay-control-image.py" --control direct --chain-verifier-dir "$V" "$BASE" "$OUT" "$C"
date -u +%FT%TZ > "$R/build-finished.utc"
rm -rf "$SA/metal/__pycache__"; need "source A still clean" [ -z "$(git -C "$SA" status --porcelain --untracked-files=all)" ]
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
need "output cmdline == base cmdline + ' metal.control=direct'" [ "$(cat "$OUT/cmdline")" = "$(tr -d '\n' < "$BASE/cmdline") metal.control=direct" ]
echo "== 5 measurement A (cmdline from the artifact)"
APPEND=$(sed 's/\${MODE}/snp/' "$OUT/cmdline" | tr -d '\n'); echo "[append] $APPEND"
A=$($MEASURE --append "$APPEND" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "$A" > "$OUT/MEASUREMENT"; echo "[measure A] $A"
for k in c2442941 fe897820 b8376e15 ed918e4b 4287b65e; do need "measurement is not $k (an earlier image)" [ "${A:0:8}" != $k ]; done
(cd "$OUT" && sha256sum *) | tee "$R/artifacts.sha256"; stat -c '%s %n' "$OUT"/*
echo "== 6 INDEPENDENT verification: measurement recomputed + verify-image-direct.py with source B (own newc reader, git blobs)"
need "artifacts == build receipt" bash -c "cd '$OUT' && sha256sum -c --quiet '$R/artifacts.sha256'"
Bm=$($MEASURE --append "$(sed 's/\${MODE}/snp/' "$OUT/cmdline" | tr -d '\n')" --kernel "$OUT/vmlinuz" --initrd "$OUT/initramfs.cpio.gz" --output-format hex)
echo "[measure B] $Bm"; need "measurement B == recorded A" [ "$Bm" = "$(cat "$OUT/MEASUREMENT")" ]; echo "$Bm" > "$B/receipts/measurement-B.txt"
rm -rf "$X"
python3 -u "$B/tools/verify-image-direct.py" "$SB" "$C" "$OUT" "$X" "$V" - "$B/receipts/image-verify-direct.json"
rm -rf "$X" "$SB/metal/__pycache__"
need "verifier receipt ok" python3 -c "import json,sys;d=json.load(open('$B/receipts/image-verify-direct.json'));sys.exit(0 if d['ok'] and d['commit']=='$C' and len(d['checks']) == 45 and all(c['ok'] for c in d['checks']) else 1)"
echo "[verify] $(python3 -c "import json;d=json.load(open('$B/receipts/image-verify-direct.json'));print(len(d['checks']),'checks, all ok')")"
need "source B still clean" [ -z "$(git -C "$SB" status --porcelain --untracked-files=all)" ]
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo "FINAL-IMAGE-BUILT-AND-VERIFIED measurement $A  (NOT booted; SNP attestation/canary/trust-list/production proof NOT DONE)"
