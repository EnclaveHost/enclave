#!/bin/bash
# the provenance analysis alone, against the generated file saved by gen1 (outputs/generated/)
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
echo "repo HEAD $(git -C "$W/repo" rev-parse HEAD)"; sha256sum "$W/outputs/generated/contract-artifacts.js"
git -C "$W/repo" show HEAD:site/js/gen/contract-artifacts.js > "$W/tmp/committed-contract-artifacts.js"
exec timeout -k 5 600 node "$W/jobs/bytecode-provenance.mjs" "$W/repo" "$W/tmp/old-src" "$W/tmp/committed-contract-artifacts.js" "$W/outputs/generated/contract-artifacts.js"
