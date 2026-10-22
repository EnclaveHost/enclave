#!/usr/bin/env bash
# encvol end to end on the candidate (immutable; v2: the wasip2 component the documented build makes): front/encvol_e2e_test.go with every input pinned and checked.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/apps/encrypted-volumes/target/wasm32-wasip2/release/encrypted_volumes.wasm"
echo "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447  $here/cache/rclone" | sha256sum -c -
(cd "$here/cache/rt-aa6c985c" && sha256sum -c ../rt-aa6c985c.sha256)
test -s "$app"
sha256sum "$app"
cd "$here/tree/isolation/m2"
export ENCVOL_E2E=1 ENCVOL_RCLONE="$here/cache/rclone" ENCVOL_RT="$here/cache/rt-aa6c985c" ENCVOL_APP="$app" \
  ENCVOL_CLI="$here/tree/scripts/enclave-encvol.sh" GOFLAGS=-mod=readonly GOTOOLCHAIN=local GOMAXPROCS=4
go vet ./front/
go test -count=1 -v -timeout 900s -run 'TestEncvolEndToEnd' ./front/
echo "run-encvol-e2e-v2: PASS"
