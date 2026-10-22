#!/usr/bin/env bash
# Final verification of the scoped tree (immutable; v1): vet (default + Shield-direct tags), the encvol packages
# (spec, engine, vendored crypt) against the real Python parser and the real pinned rclone, and the full-stack E2E.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/apps/encrypted-volumes/target/wasm32-wasip2/release/encrypted_volumes.wasm"
echo "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447  $here/cache/rclone" | sha256sum -c -
(cd "$here/cache/rt-aa6c985c" && sha256sum -c ../rt-aa6c985c.sha256)
echo "388a62ab26d15f7992ae6be065a9af0abdaee58172e8f42c38c906ba71a1cf93  $app" | sha256sum -c -
cd "$here/tree/isolation/m2"
export ENCVOL_E2E=1 ENCVOL_RCLONE="$here/cache/rclone" ENCVOL_RT="$here/cache/rt-aa6c985c" ENCVOL_APP="$app" \
  ENCVOL_CLI="$here/tree/scripts/enclave-encvol.sh" GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
go vet ./encvol/... ./front/
go vet -tags shielddirect,bootstrapdirect ./front/
go test -count=1 -v -timeout 900s ./encvol/...
go test -count=1 -v -timeout 900s -run 'TestEncvolEndToEnd|TestShieldEncVolumes' ./front/
echo "run-final-v1: PASS"
