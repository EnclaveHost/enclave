#!/usr/bin/env bash
# Model volume distribution (immutable; v1): a real reproducible volume (mkfs.ext4 + veritysetup), pinned chunk
# manifest, COLD fetch from 127.0.0.1 replicas through RawArtifacts, veritysetup verify against the pinned root.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
node --test --test-concurrency=1 test/model-volume-dist.test.mjs test/raw-artifacts.test.mjs
echo "run-dist-v1: PASS"
