#!/usr/bin/env bash
# The NEW runner bundle accepts the NEW config + NEW packages; the OLD r3 runner refuses them (pins drifted); the NEW runner
# refuses the OLD config against the NEW packages. Local copies with packagesDir/stateRoot pointed at the stage dirs.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/host-service-tls-20261021; T=$(mktemp -d)
R4=$H/stage-r5/stage-r2/enclave-host-services-hs2-windows; R3=$W/hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows
loc() { python3 - "$1" "$2" "$3" <<'PY'
import json,sys; c=json.load(open(sys.argv[1])); c['packagesDir']=sys.argv[2]; c['stateRoot']=sys.argv[3]
for s in c['services']:
    for k in ('stateDir','directory','manifest','importDir'):
        if k in s['config'] and isinstance(s['config'][k],str): s['config'][k]=sys.argv[3]+'/'+k
pc=c.get('platformHostPolicyCarriers')
if pc and 'importDir' in pc: pc['importDir']=sys.argv[3]+'/import'
print(json.dumps(c))
PY
}
loc "$H/upgrade-bundle-r5/config/host-services.json" "$R4/packages" "$T/s" > "$T/new.json"
loc "$H/bundle-input/host-services.r3-reconstructed.json" "$R4/packages" "$T/s" > "$T/old-vs-new-packages.json"
loc "$H/upgrade-bundle-r5/config/host-services.json" "$R3/packages" "$T/s" > "$T/new-vs-old-packages.json"
node "$R4/bin/host-services-runner.mjs" check "$T/new.json" > "$T/a.out" 2>&1; echo "new runner + new config + new packages rc=$? $(python3 -c "import json;j=json.load(open('$T/a.out'));print('ok',j['ok'],'warnings',len(j['warnings']),'roles',[s['role'] for s in j['services']])" 2>/dev/null || head -c 300 $T/a.out)"
node "$R4/bin/host-services-runner.mjs" check "$T/old-vs-new-packages.json" > "$T/b.out" 2>&1; echo "new runner + OLD config pins + new packages rc=$? $(head -c 160 $T/b.out)"
node "$R3/bin/host-services-runner.mjs" check "$T/new-vs-old-packages.json" > "$T/c.out" 2>&1; echo "OLD runner + new config pins + OLD packages rc=$? $(head -c 160 $T/c.out)"
rm -rf "$T"
