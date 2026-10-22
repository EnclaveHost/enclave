#!/bin/bash
# build-rc3.sh <run-id>: build the rc3 storage-indexer host-role package TWICE from pinned inputs, compare, and run its
# package tests. NOT RUN YET: root reviews BUILD-RECIPE.md first. Local only: no network, no PostgreSQL server, no
# Docker, no production; zstd + tar + sha256sum + the package's own tests (rc2: peak 142 MiB at the 512 MiB cap).
# Writes only out/<run-id>/ (refuses an existing one). Exit 0 = rc3-a == rc3-b and package tests pass.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:?run-id}
case $id in *[!A-Za-z0-9._-]*|'') echo "bad run-id"; exit 2;; esac
out=$here/out/$id
[ -e "$out" ] && { echo "refused: $out exists"; exit 2; }
mkdir -p "$out"
(cd "$here" && sha256sum -c --quiet PINS.sha256)                         # this package's own files
python3 -B "$here/check_inputs.py" --out "$out/inputs.json" > "$out/inputs.out"   # every input pin (exit 1 on any mismatch)
pkg=$here/rc3/enclave-storage-indexer
bash "$pkg/build.sh" "$out/a" | tee "$out/build-a.sha256"
bash "$pkg/build.sh" "$out/b" | tee "$out/build-b.sha256"
cmp "$out/a/enclave-storage-indexer-1.0.0-rc3.tar.zst" "$out/b/enclave-storage-indexer-1.0.0-rc3.tar.zst"
bash "$pkg/tests/run-tests.sh" > "$out/package-tests.out" 2>&1 || { tail -20 "$out/package-tests.out"; exit 1; }
tail -1 "$out/package-tests.out"
# the descriptor/host.json pin of this package: sha256 of its MANIFEST.sha256
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
zstd -q -d -c "$out/a/enclave-storage-indexer-1.0.0-rc3.tar.zst" | tar -C "$t" -xf -
(cd "$t/enclave-storage-indexer" && sha256sum -c --quiet MANIFEST.sha256)
echo "tarball $(cut -d' ' -f1 "$out/build-a.sha256")"
echo "manifestPin sha256:$(sha256sum "$t/enclave-storage-indexer/MANIFEST.sha256" | cut -d' ' -f1)"
cp "$t/enclave-storage-indexer/PACKAGE.json" "$out/PACKAGE.json"
echo "BUILD-RC3 OK $id"
