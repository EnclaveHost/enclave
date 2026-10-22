#!/bin/bash
# DIAGNOSTIC images with the ACTUAL verified production policy mirrors (main network/platform-host-policy-config.mjs
# PRODUCTION_MIRRORS, composed into this isolated tree). Immutable once written. Nothing is signed, published or activated;
# no policy document or anchor exists; these measurements are diagnostic, not a release (sources are not committed).
#   (E) equivalence: main's ORIGINAL scripts/build-custodian-v2.mjs (whole-buffer) vs the tree's STREAMING version on a
#       small synthetic base -> byte-identical initramfs required;
#   (C) the corrected custodian image (current main custody code) with --book and --host-policy (the four mirrors);
#   (R) the rewrap image (result-attestation fix) with --host-policy (the same mirrors).
# Every step's exit status is checked (set -euo pipefail); git metadata through a scoped read-only GIT_DIR.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); TREE="$HERE/../tree"; MAIN="$HERE/../../enclave"
BASE=/home/steven/enclave-prod/dist-custody-9e5fb2028
VAULT=0xe48699b8401564aace7a814ae4569b67a3f7eef5; BOOK=0xab214342d5a490150a4a977063a2f88e21f80907; OWN=0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7
HP="$HERE/host-policy-mirrors-v1.json"
export GIT_DIR="$MAIN/.git" GIT_OPTIONAL_LOCKS=0
for d in synth-base equiv-orig equiv-stream custodian-v3 rewrap-v3; do [ ! -e "$HERE/$d" ] || { echo "FAIL: $HERE/$d exists"; exit 2; }; done
ORIG="$TREE/scripts/build-custodian-v2.orig-equivalence.mjs"
trap 'rm -f "$ORIG"' EXIT
cp "$MAIN/scripts/build-custodian-v2.mjs" "$ORIG"
[ "$(sha256sum < "$ORIG")" = "$(sha256sum < "$MAIN/scripts/build-custodian-v2.mjs")" ] || { echo "FAIL: original copy"; exit 2; }
cd "$TREE"

echo "== (E) builder equivalence on a synthetic base"
python3 "$HERE/make-synthetic-base.py" "$HERE/synth-base"
ARGS=(--base "$HERE/synth-base" --vault "$VAULT" --host-ownership "$OWN" --book "$BOOK" --host-policy "$HP" --allow-dirty)
node "$ORIG" "${ARGS[@]}" --out "$HERE/equiv-orig" > "$HERE/equiv-orig.log" 2>&1
node scripts/build-custodian-v2.mjs "${ARGS[@]}" --out "$HERE/equiv-stream" > "$HERE/equiv-stream.log" 2>&1
cmp "$HERE/equiv-orig/initramfs.cpio.gz" "$HERE/equiv-stream/initramfs.cpio.gz"
echo "PASS: original whole-buffer and streaming builders give byte-identical initramfs ($(sha256sum < "$HERE/equiv-orig/initramfs.cpio.gz" | cut -c1-16)…)"

echo "== (C) corrected custodian image, --book, --host-policy (4 verified mirrors)"
node scripts/build-custodian-v2.mjs --base "$BASE" --out "$HERE/custodian-v3" --vault "$VAULT" --host-ownership "$OWN" --book "$BOOK" --host-policy "$HP" --allow-dirty > "$HERE/custodian-v3.log" 2>&1
echo "build exit=0"
echo "== (R) rewrap image, --host-policy (4 verified mirrors)"
node scripts/build-custody-rewrap.mjs --base "$BASE" --out "$HERE/rewrap-v3" --vault "$VAULT" --book "$BOOK" --host-policy "$HP" --allow-dirty > "$HERE/rewrap-v3.log" 2>&1
echo "build exit=0"

node --input-type=module - "$HERE" <<'EOF'
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const H = process.argv[2], sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const hp = JSON.parse(fs.readFileSync(path.join(H, "host-policy-mirrors-v1.json"), "utf8"));
const fail = (w) => { console.log("FAIL: " + w); process.exit(4); };
const c = JSON.parse(fs.readFileSync(path.join(H, "custodian-v3/manifest.json"), "utf8"));
const r = JSON.parse(fs.readFileSync(path.join(H, "rewrap-v3/manifest.json"), "utf8"));
for (const [n, m] of [["custodian-v3", c], ["rewrap-v3", r]]) {
  if (m.measurementError || !/^[0-9a-f]{96}$/.test(String(m.measurement))) fail(`${n}: no measurement (${m.measurementError})`);
  if (sha(path.join(H, n, "initramfs.cpio.gz")) !== m.initramfs.sha256) fail(`${n}: initramfs hash`);
}
const cBundle = fs.readFileSync(path.join(H, "custodian-v3.log"), "utf8");
if (JSON.stringify(r.measured.hostPolicy) !== JSON.stringify(hp)) fail("rewrap manifest does not embed the intended hostPolicy");
const out = { checkedAt: new Date().toISOString(), diagnostic: true, hostPolicy: hp,
  custodian: { measurement: c.measurement, measurementSha256: c.measurementSha256, initramfs: c.initramfs, files: c.files, base: c.base, ovmfSha256: c.ovmfSha256, cmdline: c.cmdline, vault: c.vault, hostOwnership: c.hostOwnership },
  rewrap: { measurement: r.measurement, measurementSha256: r.measurementSha256, initramfs: r.initramfs, files: r.files, runtimeId: r.runtimeId, measured: r.measured, sourcesCommitted: r.sourcesCommitted } };
fs.writeFileSync(path.join(H, "image-build-v3-result.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ custodian: out.custodian.measurementSha256, rewrap: out.rewrap.measurementSha256, rewrapHostPolicyEmbedded: true }, null, 1));
EOF
grep -q '"hostPolicy"' "$HERE/custodian-v3/manifest.json" || grep -q "platform-policy" "$HERE/custodian-v3/initramfs.cpio.gz" || true
node --input-type=module -e "
import fs from 'node:fs'; import zlib from 'node:zlib';
const hp = JSON.parse(fs.readFileSync('$HP','utf8'));
// the custodian bundle embeds its measured config: every mirror URL must be inside /opt/custodian/custodian.mjs
const gz = fs.createReadStream('$HERE/custodian-v3/initramfs.cpio.gz').pipe(zlib.createGunzip()); let tail = '', found = new Set();
for await (const c of gz) { const s = tail + c.toString('latin1'); for (const u of hp.mirrors) if (s.includes(u)) found.add(u); tail = s.slice(-200); }
if (found.size !== hp.mirrors.length) { console.log('FAIL: the custodian image does not embed every mirror'); process.exit(5); }
console.log('PASS: the custodian image embeds all ' + found.size + ' mirrors');"
echo "PASS: image-build-v3 complete"
