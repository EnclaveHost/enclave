#!/usr/bin/env bash
# A second, independent build from the same main into a scratch dir: its id and archive must equal release/'s.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf "$PWD/.build-2"
node build-release.mjs --repo ../enclave --out "$PWD/.build-2" > logs/build-2.json
rm -rf "$PWD/.build-2"
cat logs/build-2.json
