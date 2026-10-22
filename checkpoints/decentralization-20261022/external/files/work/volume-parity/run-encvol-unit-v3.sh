#!/usr/bin/env bash
# encvol package tests + front vet (immutable; v3, 1024 MiB): the real Python reference parser and the real pinned
# rclone v1.67.0 (owner side, format reference, `rclone serve s3`); the front vetted with its default tags and with the
# Shield-direct tags (shield_direct_custody.go carries the partition's encrypted-volume launch).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree/isolation/m2"
export ENCVOL_RCLONE="$here/cache/rclone" GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
echo "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447  $ENCVOL_RCLONE" | sha256sum -c -
go vet ./encvol/... ./front/
go vet -tags shielddirect,bootstrapdirect ./front/
go test -count=1 -v -timeout 900s ./encvol/...
echo "run-encvol-unit-v3: PASS"
