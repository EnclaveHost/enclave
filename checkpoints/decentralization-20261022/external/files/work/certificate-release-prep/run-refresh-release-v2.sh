#!/usr/bin/env bash
# v2. One 768 MiB queue job (builds, a multiprocess smoke and the affected host-package suite):
#  1. refresh relay/network-runtime.bundle.mjs (+ manifest) from the CURRENT integrated source with relay/build-network.mjs,
#     twice into scratch dirs (byte-identical), then in place; node --check; manifest sha == bytes; every named import main's
#     importers take from the bundle exists; input hashes recorded (drift evidence);
#  2. test/relay-network-bundle.test.mjs;
#  3. the challenge-replica host release (scripts/build-challenge-replica-release.mjs: dns.mjs, runtime bundle, the bundled
#     launcher challenge-host.mjs, manifest) twice, byte-identical, delivered to release/dist; --expect-sha256 accepts it;
#  4. release-smoke.mjs: the DELIVERED launcher run from a dependency-free copy, in an unshared network namespace;
#  5. test/challenge-replica-host.test.mjs (changed: host-policy carriers) through the candidate's runner.
# Scratch on disk (TMPDIR), never /tmp (RAM). Exit 0 only if every step passed.
set -euo pipefail
W="$(cd "$(dirname "$0")" && pwd)"; T="$W/tree"; export TMPDIR="$W/scratch"
cd "$T"
rm -rf "$W/gen" "$W/release"; mkdir -p "$W/gen/a" "$W/gen/b" "$W/release"
node relay/build-network.mjs "$W/gen/a/network-runtime.bundle.mjs"
node relay/build-network.mjs "$W/gen/b/network-runtime.bundle.mjs"
cmp "$W/gen/a/network-runtime.bundle.mjs" "$W/gen/b/network-runtime.bundle.mjs"
cmp "$W/gen/a/network-runtime.bundle.mjs.manifest.json" "$W/gen/b/network-runtime.bundle.mjs.manifest.json"
echo "[refresh] two builds byte-identical"
node relay/build-network.mjs
cmp relay/network-runtime.bundle.mjs "$W/gen/a/network-runtime.bundle.mjs"
cmp relay/network-runtime.bundle.mjs.manifest.json "$W/gen/a/network-runtime.bundle.mjs.manifest.json"
node --check relay/network-runtime.bundle.mjs
node --input-type=module - "$T" "$W" <<'JS'
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto'; import {pathToFileURL} from 'node:url';
const [T, W] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const bundle = path.join(T, 'relay/network-runtime.bundle.mjs'), man = JSON.parse(fs.readFileSync(bundle + '.manifest.json', 'utf8'));
if (sha(fs.readFileSync(bundle)) !== man.sha256) throw new Error('manifest sha256 is not the bundle bytes');
const mod = await import(pathToFileURL(bundle).href);
const importers = ['relay/dns-relay.js', 'relay/fleet.mjs', 'relay/api-relay.js', 'network/challenge-replica-host.mjs', 'network/host-services/argv-guard.mjs'];
const missing = [];
for (const f of importers) {
  const src = fs.readFileSync(path.join(T, f), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*network-runtime\.bundle\.mjs["']/g)) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => names.add(n));
  for (const m of src.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["'][^"']*network-runtime\.bundle\.mjs["']\s*\)/g)) m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0]).filter(Boolean).forEach((n) => names.add(n));
  for (const n of names) if (!(n in mod)) missing.push(`${f}: ${n}`);
  console.log(`[refresh] ${f}: ${names.size} named imports resolved`);
}
if (missing.length) throw new Error('bundle lacks: ' + missing.join(', '));
const inputs = man.inputs.map((p) => ({path: p, sha256: sha(fs.readFileSync(path.join(T, p)))}));
fs.writeFileSync(path.join(W, 'gen/bundle-inputs.json'), JSON.stringify({bundleSha256: man.sha256, manifestSha256: sha(fs.readFileSync(bundle + '.manifest.json')), inputs}, null, 1) + '\n');
console.log(`[refresh] bundle ${man.sha256}, ${inputs.length} inputs hashed`);
JS
unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 test/relay-network-bundle.test.mjs'
echo "[refresh] relay-network-bundle test passed"
node scripts/build-challenge-replica-release.mjs "$W/release/a" > "$W/release/a.json"
node scripts/build-challenge-replica-release.mjs "$W/release/b" > "$W/release/b.json"
for f in dns.mjs network-runtime.bundle.mjs dns.mjs.manifest.json challenge-host.mjs; do cmp "$W/release/a/$f" "$W/release/b/$f"; done
DNS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).dnsSha256)' "$W/release/a.json")
RT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).runtimeBundleSha256)' "$W/release/a.json")
HOST=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).hostSha256)' "$W/release/a.json")
node scripts/build-challenge-replica-release.mjs "$W/release/dist" --expect-sha256 "$DNS" > "$W/release/dist.json"
for f in dns.mjs challenge-host.mjs dns.mjs.manifest.json; do cmp "$W/release/dist/$f" "$W/release/a/$f"; done
cmp "$W/release/dist/network-runtime.bundle.mjs" relay/network-runtime.bundle.mjs
echo "[release] dns.mjs $DNS runtime $RT launcher $HOST (two builds identical; --expect-sha256 accepted)"
unshare -rn bash -c "ip link set lo up; TMPDIR='$TMPDIR' node '$W/release-smoke.mjs' '$T' '$W/release/dist' '$DNS' '$RT' '$HOST'"
echo "[release] delivered launcher smoke passed"
TMPDIR="$TMPDIR" bash test/run-certificate-hosted.sh host
echo "[refresh-release] exit=0"
