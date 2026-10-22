#!/bin/bash
# v5: completes image-build-v4.sh, which built (E) equivalence PASS and (C) custodian-v4 (exit 0), then was stopped during
# (R) by the HOST floor (MemAvailable 16366 MiB < 16384; other workers' load), not by this job's 512 MiB cap.
# Here: (R) the rewrap image into a FRESH directory, then the post-checks v4 never reached, over custodian-v4 and rewrap-v5.
# Immutable once written; set -euo pipefail; diagnostic only (nothing signed, published, anchored or activated).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); TREE="$HERE/../tree"; MAIN="$HERE/../../enclave"
BASE=/home/steven/enclave-prod/dist-custody-9e5fb2028
VAULT=0xe48699b8401564aace7a814ae4569b67a3f7eef5; BOOK=0xab214342d5a490150a4a977063a2f88e21f80907
HP="$HERE/host-policy-mirrors-v1.json"
export GIT_DIR="$MAIN/.git" GIT_OPTIONAL_LOCKS=0
[ -f "$HERE/custodian-v4/manifest.json" ] || { echo "FAIL: custodian-v4 is incomplete"; exit 2; }
[ ! -e "$HERE/rewrap-v5" ] || { echo "FAIL: rewrap-v5 exists"; exit 2; }
cd "$TREE"
echo "== (R) rewrap image, --host-policy (4 verified mirrors)"
node scripts/build-custody-rewrap.mjs --base "$BASE" --out "$HERE/rewrap-v5" --vault "$VAULT" --book "$BOOK" --host-policy "$HP" --allow-dirty > "$HERE/rewrap-v5.log" 2>&1
echo "build exit=0"
node --input-type=module - "$HERE" "$HP" <<'EOF'
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib"; import { createHash } from "node:crypto";
const [H, HPF] = process.argv.slice(2), sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const hp = JSON.parse(fs.readFileSync(HPF, "utf8"));
const fail = (w) => { console.log("FAIL: " + w); process.exit(4); };
const c = JSON.parse(fs.readFileSync(path.join(H, "custodian-v4/manifest.json"), "utf8"));
const r = JSON.parse(fs.readFileSync(path.join(H, "rewrap-v5/manifest.json"), "utf8"));
for (const [n, m] of [["custodian-v4", c], ["rewrap-v5", r]]) {
  if (m.measurementError || !/^[0-9a-f]{96}$/.test(String(m.measurement))) fail(`${n}: no measurement (${m.measurementError})`);
  if (sha(path.join(H, n, "initramfs.cpio.gz")) !== m.initramfs.sha256) fail(`${n}: initramfs hash`);
  if (sha(path.join(H, n, "vmlinuz")) !== m.kernel.sha256) fail(`${n}: kernel hash`);
}
if (JSON.stringify(r.measured.hostPolicy) !== JSON.stringify(hp)) fail("rewrap manifest does not embed the intended hostPolicy");
// the custodian manifest records no hostPolicy field: check its bundle actually carries every mirror (streamed scan)
const found = new Set(); let tail = "";
for await (const ch of fs.createReadStream(path.join(H, "custodian-v4/initramfs.cpio.gz")).pipe(zlib.createGunzip())) {
  const s = tail + ch.toString("latin1"); for (const u of hp.mirrors) if (s.includes(u)) found.add(u); tail = s.slice(-200);
}
if (found.size !== hp.mirrors.length) fail(`the custodian image embeds ${found.size}/${hp.mirrors.length} mirrors`);
const out = { checkedAt: new Date().toISOString(), diagnostic: true, hostPolicy: hp, equivalence: "image-build-v4 (E): original vs streaming builder byte-identical on a synthetic base",
  custodian: { dir: "custodian-v4", measurement: c.measurement, measurementSha256: c.measurementSha256, initramfs: c.initramfs, files: c.files, base: c.base, ovmfSha256: c.ovmfSha256,
               cmdline: c.cmdline, vault: c.vault, hostOwnership: c.hostOwnership, mirrorsEmbedded: found.size },
  rewrap: { dir: "rewrap-v5", measurement: r.measurement, measurementSha256: r.measurementSha256, initramfs: r.initramfs, files: r.files, runtimeId: r.runtimeId, measured: r.measured,
            sourcesCommitted: r.sourcesCommitted, rulesImage: r.rulesImage } };
fs.writeFileSync(path.join(H, "image-build-v5-result.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ custodian: [c.measurement, c.measurementSha256], rewrap: [r.measurement, r.measurementSha256], mirrorsEmbedded: found.size, rewrapHostPolicyEmbedded: true }, null, 1));
EOF
echo "PASS: image-build-v5 complete"
