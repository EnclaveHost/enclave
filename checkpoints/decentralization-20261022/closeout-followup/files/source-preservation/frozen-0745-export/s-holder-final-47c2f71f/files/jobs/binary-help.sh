#!/bin/bash
# Run the staged official base binary's version/help in a network-denied namespace (no state, no network).
set -u
cd "$(dirname "$0")/.."
B=$PWD/staging/base-v1.5.1-20261023T053947Z/base; O=evidence/binary-help-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p $O
sha256sum $B | tee $O/binary.sha256
ldd $B > $O/ldd.txt 2>&1; ldd --version | head -1 >> $O/ldd.txt
run() { local name=$1; shift; timeout -k 2 30 unshare --user --map-root-user --net env -i PATH=/usr/bin:/bin HOME=/nonexistent "$B" "$@" > $O/$name.txt 2>&1; echo "$name rc=$?" | tee -a $O/rc.txt; }
run version --version
run help --help
run rpc-help --chain mainnet rpc --help
run rpc-help-default rpc --help
cd $O && sha256sum *.txt > SHA256SUMS
