#!/bin/bash
# build.sh <outdir>: assemble the package tarball reproducibly (fixed order, mtime, owners; zstd -19).
# Inputs are pinned by sha256: the G-C2 indexd release (reproducible itself: work/indexd-c2-implementation/tools/
# build-all.sh, two empty-cache builds byte-identical) and the GeoLite2 database it bundles.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?outdir}
W=$(cd "$here/../../.." && pwd)                       # work/
REL=$W/indexd-c2-implementation/package/release/indexd-v0.6.0-fence.2-c2-linux-amd64
GEO=$W/indexd-c2-implementation/src/GeoLite2-City.mmdb
INDEXD_SHA=e6e812fd625de0cd7c5956c5c5bffc5f3d1822784d65125cdc704ba793ec2955
echo "$INDEXD_SHA  $REL" | sha256sum -c --quiet
GEO_SHA=$(sha256sum "$GEO" | cut -d' ' -f1)
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
p=$stage/enclave-storage-indexer
mkdir -p "$p/bin" "$p/share"
install -m 0755 "$REL" "$p/bin/indexd"
install -m 0644 "$GEO" "$p/share/GeoLite2-City.mmdb"
cp -r "$here/libexec" "$here/units" "$here/templates" "$p/"
install -m 0644 "$here/README.md" "$p/README.md"
chmod 0755 "$p"/libexec/*; chmod 0644 "$p"/units/* "$p"/templates/*
python3 - "$p" "$INDEXD_SHA" "$GEO_SHA" <<'PY'
import json, sys
p, ish, gsh = sys.argv[1:]
json.dump({"format": "enclave-storage-indexer-package/1", "name": "enclave-storage-indexer", "version": "1.0.0-rc2",
           "indexd": {"file": "bin/indexd", "version": "v0.6.0-fence.2-c2", "sha256": ish,
                      "source": "work/indexd-c2-implementation (G-C2 v4.0: cas-v4, op-nonce, fence)"},
           "geoip": {"file": "share/GeoLite2-City.mmdb", "sha256": gsh},
           "requires": {"postgresqlMajor": 18, "systemd": ">= 250 (LoadCredentialEncrypted)", "memAvailableMiB": 2304, "diskMiB": 3584},
           "forbiddenHosts": ["DigitalOcean (transport-only machines)"],
           "supervisor": "network/host-services/storage-indexer-host.mjs in the Enclave host software (platform host policy gate)",
           "app": {"name": "sia-s3", "artifactSha256": "00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc",
                   "note": "the clone-safe candidate; never aa15a054 in copy-tolerant mode"}},
          open(f"{p}/PACKAGE.json", "w"), indent=1, sort_keys=True)
PY
(cd "$p" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256)
mkdir -p "$out"
tarball=$out/enclave-storage-indexer-1.0.0-rc2.tar.zst
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    -C "$stage" -cf - enclave-storage-indexer | zstd -q -12 -T1 > "$tarball"
sha256sum "$tarball"
