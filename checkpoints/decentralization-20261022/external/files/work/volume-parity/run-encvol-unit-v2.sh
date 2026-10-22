#!/usr/bin/env bash
# encvol package tests on the candidate (immutable; v2): the real Python reference parser and the real pinned rclone
# v1.67.0 (the owner's side, the format reference and `rclone serve s3`); plus vet of the front that embeds the engine.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree/isolation/m2"
export ENCVOL_RCLONE="$here/cache/rclone" GOFLAGS=-mod=readonly GOTOOLCHAIN=local GOMAXPROCS=4
echo "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447  $ENCVOL_RCLONE" | sha256sum -c -
go vet ./encvol/... ./front/
go test -count=1 -v ./encvol/...
echo "run-encvol-unit-v2: PASS"
