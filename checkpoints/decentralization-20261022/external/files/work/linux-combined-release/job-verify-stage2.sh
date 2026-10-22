#!/bin/sh
# Finish the checks job-stage-combined-v2.sh did not reach (it stopped at its own wrong expectation that the overlay
# installs /opt/metal/platform-api.bundle.mjs - it never does; that bundle is not in the production base, KEPT or this
# image line). Read-only over stage2's staged artifacts; nothing rebuilt, so measurement 8c59a387... stands.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-combined-release; S=$L/stage2
B=d0510440398e5f50720bb28accb4d1d8088175df; R=$S/metal-d05104403; OUT=$S/dist-leasegas-d05104403; X=$S/extract
KI=$W/linux-post-adoption-release/stage/dist-leasegas-deabf8f90; BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
[ "$(readlink $L/tree)" = stage2/metal-d05104403 ] || { echo "tree pointer moved"; exit 2; }
[ "$(cat $OUT/MEASUREMENT)" = 8c59a387cdf2caa82097318e135e949480f5b077531d9ee54580e23cae4b01c4bd3ca61e4c347c94744889ff83c78484 ] || exit 2
[ "$(sha256sum < $OUT/initramfs.cpio.gz | cut -c1-64)" = 9d65e452ab903c45aaf6a64e5771ce1a25cfbd8989513bff15853b7189056098 ] && echo "STAGED-IMAGE-UNCHANGED-SINCE-MEASUREMENT"
python3 - $OUT/manifest.json $X $R $B <<'PY'
import json,hashlib,sys,os
m=json.load(open(sys.argv[1])); x,r,b=sys.argv[2:5]; co=m['controlOverlay']
h=lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
assert co['commit']==b and m['initramfs']['sha256']==h(os.path.join(os.path.dirname(sys.argv[1]),'initramfs.cpio.gz'))
n=0
for f in co['files']:
    img=x+f['path']; src=r+'/'+f['source']             # the release dir follows its git symlinks, like build-image.mjs
    assert h(img)==f['sha256']==h(src),(f['path'],f['source'])
    n+=1
print('EVERY-OVERLAID-FILE == MANIFEST == RELEASE-SOURCE-BYTES',n,'files;', sum(f['path'].startswith('/opt/metal/') for f in co['files']),'under /opt/metal')
print('OVERLAY-BUILDER',co['builder'],co['builderSha256'])
PY
[ "$(sha256sum < $R/metal/overlay-control-image.py | cut -c1-64)" = "$(sha256sum < $L/overlay-fix/new/metal/overlay-control-image.py | cut -c1-64)" ] && echo "RELEASE-OVERLAY-TOOL == overlay-fix/new"
for f in owner-nomination.mjs lease-gas-conduit.bundle.mjs measured-control.mjs gsup.mjs; do cmp -s $X/opt/metal/$f $R/metal/guest/$f && echo "OPT-METAL-IS-SOURCE $f" || { echo "OPT-METAL-DIFFERS $f"; exit 1; }; done
for f in supervisor.js metal/guest/owner-nomination.mjs network/host-owner-nomination.mjs client/lease-executor-client.mjs network/lease-gas-runtime.mjs relay/net-guard.mjs; do cmp -s $X/app/$f $R/$f && echo "APP-IS-SOURCE $f" || { echo "APP-DIFFERS $f"; exit 1; }; done
python3 - $BASE/initramfs.cpio.gz $KI/initramfs.cpio.gz $OUT/initramfs.cpio.gz $R <<'PY'
import gzip,importlib.util,sys
spec=importlib.util.spec_from_file_location('o',sys.argv[4]+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
for p in sys.argv[1:4]:
    with gzip.open(p,'rb') as f:
        hit=[]
        for key,name,fields,header in o.entries(f):
            o.body(f,fields[6])
            if 'platform-api' in key or 'mcp-server' in key: hit.append(key)
    print('PLATFORM-API/MCP entries in',p.split('/')[-2],hit)
PY
node $S/launcher-check.mjs $R $X
node --input-type=module -e 'import fs from "node:fs"; const { checkOwnerNomination } = await import(process.argv[1]); const n = checkOwnerNomination(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))); console.log("OWNER-CONFIG-OK-BY-IMAGE-CHECKER", n.ownershipContract, n.owner);' "$X/app/metal/guest/owner-nomination.mjs" "$L/metal0-owner-nomination.json"
node --input-type=module -e 'import fs from "node:fs"; const { checkOwnerNomination } = await import(process.argv[1]); try { checkOwnerNomination({ ...JSON.parse(fs.readFileSync(process.argv[2], "utf8")), endpoint: "http://api.enclave.host/t/metal0" }); console.log("UNEXPECTED-ACCEPT"); process.exit(1); } catch (e) { console.log("OWNER-CONFIG-TAMPER-REFUSED", String(e.message).slice(0, 120)); }' "$X/app/metal/guest/owner-nomination.mjs" "$L/metal0-owner-nomination.json"
rm -rf $X
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo STAGE2-VERIFIED
