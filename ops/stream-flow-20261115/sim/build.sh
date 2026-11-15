#!/bin/sh
# build.sh <dir>   builds the simulation into <dir> (outside the repository): this folder's main.go with the front's
# real tunnel.go and tunnel_flow.go and the host tunnel's tune.go, as they are in this checkout.
set -eu
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../../.." && pwd); out=${1:?usage: build.sh <dir>}
mkdir -p "$out"
cp "$here/main.go" "$here/client.mjs" "$here/run.sh" "$here/matrix.sh" "$out/"
cp "$root/isolation/m2/front/tunnel.go" "$root/isolation/m2/front/tunnel_flow.go" "$out/"
sed 's/^package wg$/package main/' "$root/network/wg/tune.go" > "$out/tune.go"
cat > "$out/go.mod" <<MOD
module flowsim

go 1.24

require (
	enclave.host/isolation/contract v0.0.0
	golang.zx2c4.com/wireguard v0.0.0-20250521234502-f333402bd9cb
	gvisor.dev/gvisor v0.0.0-20250503011706-39ed1f5ac29c
)

replace enclave.host/isolation/contract => $root/isolation/contract
MOD
cat "$root/network/wg/go.sum" "$root/isolation/m2/go.sum" | sort -u > "$out/go.sum"
(cd "$out" && GOFLAGS=-mod=mod go build -o flowsim .)
echo "built $out/flowsim"
