#!/usr/bin/env bash
# G3 final package, job 4: generator tests, the REAL r5 -> G3 bundle, runner smoke (new accepts, old/stale refuse).
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package; H=$G/..; cd "$G"; date -u +%FT%TZ
python3 -m unittest -v test_make_upgrade_bundle_g3 > logs/t-generator.out 2>&1; echo "generator tests rc=$? $(grep -E '^(Ran|OK|FAILED)' logs/t-generator.out | tr '\n' ' ')"
R5=$H/stage-r5/stage-r2/enclave-host-services-hs2-windows; G3S=$G/stage-g3/stage-r2/enclave-host-services-hs2-windows
rm -rf "$G/upgrade-bundle-g3"
python3 make-upgrade-bundle-g3.py --old-stage "$R5" --new-stage "$G3S" --old-config "$H/upgrade-bundle-r5/config/host-services.json" \
  --old-config-sha 5768866dc1804435673174f673abfcd2aaf7da15f8fef18886c645ab9c94b87d --old-receipt-sha 2ea7d28e67eb0913e4c2a5a18d05dcc7e8a88a16c908ca07ed2fb1e7da9ef369 \
  --new-config "$G/candidate/host-services.json" --add-role service-tls --out "$G/upgrade-bundle-g3" > logs/bundle-g3.out 2>&1; echo "bundle rc=$?"; cat logs/bundle-g3.out
T=$(mktemp -d)
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
chk() { node "$1" check "$2" > "$T/o" 2>&1; local rc=$?; echo "$3 rc=$rc $(python3 -c "import json;j=json.load(open('$T/o'));print('ok',j['ok'],'warnings',len(j['warnings']),'roles',[s['role'] for s in j['services']])" 2>/dev/null || head -c 220 $T/o | tr '\n' ' ')"; }
loc "$G/candidate/host-services.json" "$G3S/packages" "$T/s" > "$T/cand.json"
loc "$H/upgrade-bundle-r5/config/host-services.json" "$G3S/packages" "$T/s" > "$T/live-vs-g3pk.json"
loc "$G/candidate/host-services.json" "$R5/packages" "$T/s" > "$T/cand-vs-r5pk.json"
python3 -c "import json;c=json.load(open('$T/cand.json'));c['services'][-1]['config']['orders']='approved';print(json.dumps(c))" > "$T/approved.json"
python3 -c "import json;c=json.load(open('$T/cand.json'));c['services'][-1]['config']['orders']='yes';print(json.dumps(c))" > "$T/badorders.json"
python3 -c "import json;c=json.load(open('$T/cand.json'));c['services'][-1]['config']['hostId']='0x'+'3'*64;print(json.dumps(c))" > "$T/badhost.json"
python3 -c "import json;c=json.load(open('$T/cand.json'));c['platformHostPolicy']='off';print(json.dumps(c))" > "$T/policyoff.json"
chk "$G3S/bin/host-services-runner.mjs" "$T/cand.json"          "G3 runner + candidate (held) + G3 packages      "
chk "$G3S/bin/host-services-runner.mjs" "$T/approved.json"      "G3 runner + candidate (approved) + G3 packages  "
chk "$G3S/bin/host-services-runner.mjs" "$T/badorders.json"     "G3 runner + orders 'yes' (must refuse)          "
chk "$G3S/bin/host-services-runner.mjs" "$T/badhost.json"       "G3 runner + foreign hostId (must refuse)        "
chk "$G3S/bin/host-services-runner.mjs" "$T/policyoff.json"     "G3 runner + platformHostPolicy off (must refuse)"
chk "$G3S/bin/host-services-runner.mjs" "$T/live-vs-g3pk.json"  "G3 runner + LIVE r5 config + G3 packages (stale route-dns pin, must refuse)"
chk "$R5/bin/host-services-runner.mjs"  "$T/cand-vs-r5pk.json"  "r5 runner + candidate + r5 packages (must refuse)"
rm -rf "$T"; date -u +%FT%TZ
