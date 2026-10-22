#!/usr/bin/env bash
# r6-upstream / r6 / live with the G3 RUNNER (c3c7d9f6) and the G3 packages (route-dns 1ad58e1d with CHALLENGE_TXT_UPSTREAM); local, paths remapped
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package/stage-g3/stage-r2/enclave-host-services-hs2-windows; T=$(mktemp -d)
loc(){ python3 - "$1" "$G/packages" "$T/s" <<'PY'
import json,sys; c=json.load(open(sys.argv[1])); c['packagesDir']=sys.argv[2]; c['stateRoot']=sys.argv[3]
for s in c['services']:
    for k in ('stateDir','directory','manifest','importDir'):
        if k in s['config'] and isinstance(s['config'][k],str): s['config'][k]=sys.argv[3]+'/'+k
pc=c.get('platformHostPolicyCarriers')
if pc and 'importDir' in pc: pc['importDir']=sys.argv[3]+'/import'
print(json.dumps(c))
PY
}
echo "runner $(sha256sum $G/bin/host-services-runner.mjs | cut -c1-8) route-dns pkg $(sha256sum $G/packages/route-dns.package.json | cut -c1-8)"
for f in frozen/hs2-r6/live-47f3e1f.json frozen/hs2-r6/host-services.r6-upstream.json frozen/hs2-r6/host-services.r6.json frozen/host-services.r5e.json; do
  loc $f > $T/c.json; node $G/bin/host-services-runner.mjs check $T/c.json > $T/o 2>&1; rc=$?
  echo "$(basename $f) rc=$rc $(python3 -c "import json;j=json.load(open('$T/o'));print('ok',j['ok'],'roles',[s['role'] for s in j['services']])" 2>/dev/null || head -c 200 $T/o)"
done
rm -rf $T
