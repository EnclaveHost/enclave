#!/usr/bin/env bash
# mirror-base = src + canonical tests + the 59 EXACT live control files (probe out-20261021T212012Z, each local copy's sha
# prefix == the live file's); mirror-new = mirror-base + control/new (the composed candidate). Local only.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/node-hold-package-20261021
for m in mirror-base mirror-new; do
  rm -rf $P/$m; cp -a $P/src $P/$m; cp -rn $W/enclave/test/. $P/$m/test/
  python3 - $P/$m <<'PY'
import json,sys,shutil,hashlib,os
m=sys.argv[1];d=json.load(open('/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/probe/live-control-map.json'))
live=json.load(open(sorted(__import__('glob').glob('/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/probe/out-*.json'))[-1]))['files']['control']
for k,src in d['found'].items():
    dst=os.path.join(m,k.replace('\\','/')); shutil.copyfile(src,dst)
    assert hashlib.sha256(open(dst,'rb').read()).hexdigest()[:16]==live[k],k
print('live control overlay:',len(d['found']),'files')
PY
done
N=$P/mirror-new; C=$P/control/new
for f in host agent appzone network-enroll host-admission.bundle hvcert; do cp $C/$f.mjs $N/windows/node/$f.mjs; done
for f in wallet-admission host-service-names host-service-transport; do cp $C/$f.mjs $N/network/$f.mjs; done
cp $P/tests/*.test.mjs $N/test/
echo "mirror-new host $(sha256sum $N/windows/node/host.mjs | cut -c1-8) base host $(sha256sum $P/mirror-base/windows/node/host.mjs | cut -c1-8)"
