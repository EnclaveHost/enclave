#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
out="$root/bin"
mkdir -p "$out"
export CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOMAXPROCS=1 GOMEMLIMIT=128MiB
for name in dominit domexec; do
 target=$name
 if [ "$name" = dominit ]; then target=init; fi
 gcc -static -O2 -Wl,--build-id=none "-ffile-prefix-map=$root/source=." -o "$out/$target" "$root/source/isolation/m3/$name.c"
done
cd "$root/source/isolation/m2"
go build -p 1 -trimpath -buildvcs=false -tags 'bootstrapdirect shielddirect' -ldflags='-s -w -buildid=' -o "$out/front" ./front
cd "$root/source/isolation/m3"
go build -p 1 -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$out/monitor" ./monitor
go build -p 1 -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$out/secretrun" ./secretrun
sha256sum "$out/"*
