#!/usr/bin/env bash
# encvol package tests only, lean for a 512 MiB slot (immutable; v1): sequential compile (-p 1), GOGC 50; the real
# Python reference parser and the real pinned rclone v1.67.0 (owner side, format reference, `rclone serve s3`).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree/isolation/m2"
export ENCVOL_RCLONE="$here/cache/rclone" GOFLAGS="-mod=readonly -p=1" GOTOOLCHAIN=local GOMAXPROCS=2 GOGC=50
echo "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447  $ENCVOL_RCLONE" | sha256sum -c -
go vet ./encvol/...
go test -count=1 -v -timeout 900s ./encvol/...
echo "run-encvol-pkg-512-v1: PASS"
