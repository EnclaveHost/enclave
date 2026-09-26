#!/bin/bash
# stage-hvnode.sh <node-commit> <cli-commit> <outdir>
# Workstation side of the NucBox hv-node rollout (ROLLOUT.md step 2). It builds, from pinned commits, the two archives the
# box installs, and prints their sha256 for the install to check:
#   hvnode-<c8>.tar.gz  the hv node's tree at <node-commit>: exactly the files agent.mjs loads (its import closure, checked
#                    below), the npm lockfile, fetch-cid.py + ipfs_fetch.py, and relay/fixtures/tpm-roots.pem. The repo
#                    LAYOUT is kept: agent.mjs imports ../../relay/*.mjs and ../vbslike/*.
#   cli-<c8>.tar.gz     cli/ at <cli-commit> (`deploy --isolation`, for acceptance test 1 only).
# plus MANIFEST-*.txt: the sha256 of every file in each archive, which the box checks after expanding. The archives are
# deterministic (sorted names, mtime 0, owner 0, gzip -n): a function of the commits. The box expands them with its
# built-in tar.exe.
# It runs nothing on the box; d1 copies the files over (scp to C:\Users\claude\vbs-like\hvnode\stage\).
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <node-commit> <cli-commit> <outdir>" >&2; exit 2; }
NC=$(git rev-parse --verify "$1^{commit}"); CC=$(git rev-parse --verify "$2^{commit}"); OUT=$3
mkdir -p "$OUT"
N8=${NC:0:8}; C8=${CC:0:8}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

git archive --format=tar "$NC" windows/node windows/vbslike/datapath windows/vbslike/verify \
  relay/vbs-policy.mjs relay/vbs-tcglog.mjs relay/vbs-verify.mjs relay/avf-verify.mjs relay/fixtures/tpm-roots.pem \
  isolation/m4/guestd/supervisor-splice.mjs wasm/ipfs_fetch.py | tar -x -C "$T"
# fetch-cid.py imports ipfs_fetch.py from its own directory (main carries it only under wasm/)
cp "$T/wasm/ipfs_fetch.py" "$T/windows/node/ipfs_fetch.py"
rm -rf "$T/windows/node/ops" "$T/windows/node/test-fixtures"
find "$T" -name '*.test.mjs' -delete

# the import closure of agent.mjs + host.mjs must be inside the tree, or the node fails at start on the box
node --input-type=module -e '
  import fs from "node:fs"; import path from "node:path";
  const root = process.argv[1]; const seen = new Set(); const todo = ["windows/node/agent.mjs", "windows/node/host.mjs"];
  const re = /(?:import\s[^"'"'"'`]*?from\s*|import\s*\(\s*|export\s[^"'"'"'`]*?from\s*)["'"'"'`](\.{1,2}\/[^"'"'"'`]+)["'"'"'`]/g;
  let missing = 0;
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    let src; try { src = fs.readFileSync(path.join(root, f), "utf8"); } catch { console.error("MISSING " + f); missing++; continue; }
    for (const m of src.matchAll(re)) { const t = path.normalize(path.join(path.dirname(f), m[1])); if (!seen.has(t)) todo.push(t); } }
  console.error(`import closure: ${seen.size} files, ${missing} missing`); process.exit(missing ? 1 : 0);' "$T"

# the manifest is written OUTSIDE the tree it lists: redirected into $T, the shell created it before find ran, so it
# listed itself (hashed half-written) while the archive, packed after the mv, did not carry it; the box's per-file check
# then refused the install (enclave-d1, staging 013deb51)
(cd "$T" && find . -type f | sort | sed 's|^\./||' | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -c1-64)" "$f"; done) > "$OUT/MANIFEST-hvnode-$N8.txt"
pack() { tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -C "$1" -cf - "${@:3}" | gzip -n -9 > "$2"; }
pack "$T" "$OUT/hvnode-$N8.tar.gz" .

C=$(mktemp -d); git archive --format=tar "$CC" cli/enclave.mjs cli/package.json cli/package-lock.json | tar -x -C "$C"
(cd "$C" && find . -type f | sort | sed 's|^\./||' | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -c1-64)" "$f"; done) > "$OUT/MANIFEST-cli-$C8.txt"
pack "$C" "$OUT/cli-$C8.tar.gz" .; rm -rf "$C"

LOCK=$(sha256sum "$T/windows/node/package-lock.json" | cut -c1-64)
echo "node commit $NC -> $OUT/hvnode-$N8.tar.gz  sha256 $(sha256sum "$OUT/hvnode-$N8.tar.gz" | cut -c1-64)"
echo "  manifest $OUT/MANIFEST-hvnode-$N8.txt  sha256 $(sha256sum "$OUT/MANIFEST-hvnode-$N8.txt" | cut -c1-64)  ($(wc -l < "$OUT/MANIFEST-hvnode-$N8.txt") files)"
echo "  windows/node/package-lock.json sha256 $LOCK"
echo "cli commit $CC -> $OUT/cli-$C8.tar.gz  sha256 $(sha256sum "$OUT/cli-$C8.tar.gz" | cut -c1-64)"
echo "  manifest $OUT/MANIFEST-cli-$C8.txt  sha256 $(sha256sum "$OUT/MANIFEST-cli-$C8.txt" | cut -c1-64)"
