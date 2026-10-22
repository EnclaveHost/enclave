#!/bin/bash
# Build the Shield-direct guest image from the CURRENT integrated source (one 1024 MiB queue job; Go compile + igvmfilegen).
# The pinned kernel, OpenHCL, runtime baseline and generator are unchanged (verify-kit.py). The procedure first reproduces
# the historical reference image and its twin (build-image.mjs), builds the candidate twice (determinism), a DEBUG twin
# (a named rejection artifact, never served) and six measurement mutations. Exit 0 only if every check passes.
set -euo pipefail
cd "$(dirname "$0")"
: "${SHIELD_SOURCE_LABEL:?set SHIELD_SOURCE_LABEL}"
export TMPDIR="$PWD/../scratch"
python3 verify-kit.py
rm -rf bin image shield-direct.cpio.gz shield-direct-again.cpio.gz initrd-build.json
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=go-w -cf source.tar source
export GOOS=linux GOARCH=amd64 GOAMD64=v1 GOEXPERIMENT=nodwarf5
bash compile.sh
# the five recompiled binaries must carry the integrated features (strings survive -s -w)
check() { grep -aq -- "$2" "bin/$1" || { echo "MISSING in $1: $2" >&2; exit 4; }; }
check front 'enclave-app-acme-push-v2'      # app-zone issuance (appzone.go)
check front 'DOM app-zone: in-guest issuance disabled'
check front 'enclave-acme-push-v1'          # owner-name issuance (acme.go)
check front 'DOM shield direct:'            # Shield-direct startup (shield_direct.go)
check front 'app-zone ACME EAB must name two distinct custody secrets'   # custody-EAB validation (bootstrap/names.go)
check front 'DOM encvol:'                   # encrypted volumes (volume parity)
check front 'checkpoint producer needs a verified startup'               # history checkpoints
echo "[image] recompiled front carries app-zone, owner-name, custody-EAB, encvol and checkpoint code"
python3 pack.py
INITRD=$(python3 -c 'import json;print(json.load(open("initrd-build.json"))["initrdSha256"])')
node --expose-gc --max-old-space-size=160 build-image.mjs "$PWD/shield-direct.cpio.gz" "$INITRD" "$PWD/image" "$PWD/inputs/kernel-vtpm.elf" "$PWD/inputs/openhcl-shield.cpio.gz" > image-build.json
python3 - <<'PY'
import json,hashlib,glob
b=json.load(open('image-build.json'))
assert b['reproduceCurrent']['ok'] and b['twinProof']['ok'], 'procedure not proven'
assert b['candidate']['deterministic'], 'image assembly not repeatable'
p=b['kept']+'/vbs-linux-candidate.bin';h=hashlib.sha256(open(p,'rb').read()).hexdigest()
assert h==b['candidate']['binSha'], 'kept image differs'
assert all(m['changed'] for m in b['mutations']), 'unmeasured mutation'
print('[image] candidate',h,'VBS digest',b['candidate']['digest'].lower(),'debug twin',b['debugTwin']['digest'].lower(),'mutations',len(b['mutations']))
PY
echo "[image] exit=0 (not hardware validated; not approved for production activation)"
