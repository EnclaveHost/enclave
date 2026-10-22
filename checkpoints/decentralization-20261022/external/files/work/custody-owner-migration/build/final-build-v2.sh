#!/bin/bash
# FINAL candidate rewrap image build (immutable once written; supersedes final-build.sh, which never ran: its queue retry
# loop was stopped before start, PIDs 1826624/1843671, because root found it could mask failures).
#
# Host policy, stated explicitly: network/platform-host-policy-config.mjs PRODUCTION_MIRRORS is [] today, and the guest's
# httpPolicyMirrors requires 1-8 HTTPS origins. So:
#   (N) the production host-policy input with the EMPTY mirror list must be REFUSED at build time (nonzero exit, exact
#       error, no image directory);
#   (1)(2) the two candidate images are built WITHOUT --host-policy, and each manifest is asserted to embed NO hostPolicy:
#       these images do not enforce the platform host policy in the guest. The production image is rebuilt with
#       --host-policy once root publishes the mirror set; its measurement will differ.
# Every step's exit status is checked (set -euo pipefail, no output filtering); results go to final-build-result.json.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TREE="$HERE/../tree"
BASE=/home/steven/enclave-prod/dist-custody-9e5fb2028
VAULT=0xe48699b8401564aace7a814ae4569b67a3f7eef5
BOOK=0xab214342d5a490150a4a977063a2f88e21f80907
cd "$TREE"
for d in never-v2 final-v2-1 final-v2-2; do [ ! -e "$HERE/$d" ] || { echo "FAIL: $HERE/$d already exists"; exit 2; }; done

echo "== (N) empty production mirror list: must be refused at build time"
set +e
node scripts/build-custody-rewrap.mjs --base "$BASE" --out "$HERE/never-v2" --vault "$VAULT" --book "$BOOK" \
  --host-policy "$HERE/host-policy-production.json" --allow-dirty > "$HERE/never-v2.log" 2>&1
NEG=$?
set -e
echo "exit=$NEG"
[ "$NEG" -ne 0 ] || { echo "FAIL: the empty mirror list was accepted"; exit 3; }
grep -q "host policy mirrors: 1-8 HTTPS origins" "$HERE/never-v2.log" || { echo "FAIL: not the expected error:"; cat "$HERE/never-v2.log"; exit 3; }
[ ! -e "$HERE/never-v2" ] || { echo "FAIL: an image directory was written"; exit 3; }
echo "refused as expected: $(grep -m1 -o 'host policy mirrors: 1-8 HTTPS origins' "$HERE/never-v2.log")"

for n in final-v2-1 final-v2-2; do
  echo "== ($n) candidate image, no --host-policy"
  node scripts/build-custody-rewrap.mjs --base "$BASE" --out "$HERE/$n" --vault "$VAULT" --book "$BOOK" --allow-dirty > "$HERE/$n.log" 2>&1
  echo "build exit=0"
done

node --input-type=module - "$HERE" <<'EOF'
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const H = process.argv[2], sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const m = (n) => JSON.parse(fs.readFileSync(path.join(H, n, "manifest.json"), "utf8"));
const [a, b] = [m("final-v2-1"), m("final-v2-2")];
const fail = (why) => { console.log("FAIL: " + why); process.exit(4); };
for (const [n, x] of [["final-v2-1", a], ["final-v2-2", b]]) {
  if (x.role !== "enclave-custody-rewrap") fail(`${n}: role`);
  if ("hostPolicy" in x.measured) fail(`${n}: embeds a hostPolicy`);
  if (x.measurementError || !/^[0-9a-f]{96}$/.test(String(x.measurement))) fail(`${n}: no launch measurement (${x.measurementError})`);
  if (sha(path.join(H, n, "initramfs.cpio.gz")) !== x.initramfs.sha256) fail(`${n}: initramfs hash differs from its manifest`);
  if (sha(path.join(H, n, "vmlinuz")) !== x.kernel.sha256) fail(`${n}: kernel hash differs`);
}
const same = ["measurement", "measurementSha256", "initramfs", "files", "runtimeId", "measured", "cmdline", "ovmfSha256"].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
if (!same) fail("the two builds differ");
const r = { checkedAt: new Date().toISOString(), deterministic: true, negativeEmptyMirrors: "refused at build time (nonzero exit, exact error, no image)",
  hostPolicyEmbedded: false, sourcesCommitted: a.sourcesCommitted, measurement: a.measurement, measurementSha256: a.measurementSha256, runtimeId: a.runtimeId,
  initramfs: a.initramfs, files: a.files, measured: a.measured, base: a.base, ovmfSha256: a.ovmfSha256, cmdline: a.cmdline, bundler: a.bundler,
  bundleInputs: a.bundleInputs };
fs.writeFileSync(path.join(H, "final-build-result.json"), JSON.stringify(r, null, 1) + "\n");
console.log(JSON.stringify({ deterministic: true, measurement: r.measurement, measurementSha256: r.measurementSha256, initramfs: r.initramfs, files: r.files, hostPolicyEmbedded: false }, null, 1));
EOF
cmp "$HERE/final-v2-1/initramfs.cpio.gz" "$HERE/final-v2-2/initramfs.cpio.gz"
echo "PASS: deterministic, initramfs byte-identical"
