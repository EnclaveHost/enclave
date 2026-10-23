#!/bin/bash
# credit-vault submitter build 1: rebuild the host-service packages from the composed sources, KEEP only the
# credit-vault-submitter package (the role assigned here), restore every other role's tracked files, prove the kept bundle
# rebuilds byte-identically, and diff its manifest inputs against the previous package. Exit nonzero on any failure.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo/work/credit-vault-submitter-verifier-20261023
cd $W/repo; P=network/host-services/packages; R=credit-vault-submitter
git show HEAD:$P/$R.package.json > $W/jobs/build1-prev-manifest.json
node relay/build-network.mjs relay/network-runtime.bundle.mjs > /dev/null || { echo "network-runtime bundle failed"; exit 4; }
node scripts/build-host-service-packages.mjs || { echo "BUILD FAILED"; exit 2; }
echo "tracked package files the full build changed:"; git status --short -- $P
for f in $(git diff --name-only -- $P); do case "$f" in $P/$R.mjs|$P/$R.package.json) ;; *) git checkout -- "$f"; echo "restored (not this role): $f";; esac; done
A=$(sha256sum $P/$R.mjs | cut -c1-64); M=$(sha256sum $P/$R.package.json | cut -c1-64)
cp $P/$R.mjs $W/jobs/build1-first.mjs
node scripts/build-host-service-packages.mjs > /dev/null || { echo "SECOND BUILD FAILED"; exit 2; }
for f in $(git diff --name-only -- $P); do case "$f" in $P/$R.mjs|$P/$R.package.json) ;; *) git checkout -- "$f";; esac; done
B=$(sha256sum $P/$R.mjs | cut -c1-64); N=$(sha256sum $P/$R.package.json | cut -c1-64)
echo "bundle  $A / second build $B"; echo "manifest $M / second build $N"
[ "$A" = "$B" ] && [ "$M" = "$N" ] && echo "REPRODUCIBLE" || { echo "NOT REPRODUCIBLE"; exit 5; }
node -e '
const fs = require("fs"), [a, b] = process.argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const keys = new Set([...Object.keys(a.inputs), ...Object.keys(b.inputs)]); let d = { added: 0, removed: 0, changed: 0 };
for (const k of [...keys].sort()) if (a.inputs[k] !== b.inputs[k]) { const t = a.inputs[k] ? (b.inputs[k] ? "changed" : "removed") : "added"; d[t]++; if (!k.startsWith("node_modules/viem/_esm/op-stack/")) console.log("INPUT", t, k); }
console.log("op-stack inputs added:", [...keys].filter((k) => k.startsWith("node_modules/viem/_esm/op-stack/") && !a.inputs[k]).length, "totals", JSON.stringify(d));
console.log("bundle", a.bundleSha256, a.bytes, "->", b.bundleSha256, b.bytes); for (const k of ["cold", "notCold", "secrets", "state"]) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log("FIELD changed", k);
' $W/jobs/build1-prev-manifest.json $P/$R.package.json
git status --short -- $P
