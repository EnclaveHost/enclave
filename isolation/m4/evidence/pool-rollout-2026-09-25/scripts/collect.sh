#!/usr/bin/env bash
# Read-only evidence for the pool rollout (isolation/GUEST-POOL-ROLLOUT.md S0-S2). Usage: collect.sh <label>
set -uo pipefail
L=$1; EV=~/enclave-bench/pool-rollout-20260925; D=$EV/$L; mkdir -p $D; cd $D
WT=/home/steven/Projects/enclave-poolacct; PROD=/home/steven/enclave-prod; ISO=$PROD/iso-03be27d6/isolation
date -u +%Y-%m-%dT%H:%M:%SZ > at.txt
# host
{ grep -E "^(MemTotal|MemAvailable|AnonPages|Shmem|Unevictable|SwapTotal|SwapFree|Zswapped):" /proc/meminfo; echo; cat /proc/pressure/memory; } > host.txt
# units
for u in enclave-guestd.service enclave-metal-iso.service $(systemctl --user list-units --no-legend 'm2-gd*' | awk '{print $1}'); do
  echo "$u $(systemctl --user show $u -p ActiveState -p SubState -p MainPID -p ActiveEnterTimestamp -p MemoryCurrent -p MemoryMax -p CPUQuotaPerSecUSec -p NRestarts | tr '\n' ' ')"; done > units.txt
systemctl --user show enclave-guestd.service -p ExecStart --value > guestd-execstart.txt
sha256sum ~/.config/systemd/user/enclave-guestd.service ~/.config/systemd/user/enclave-metal-iso.service $PROD/bin/guestd* > files.sha256 2>/dev/null
# guestd, read-only over guestd-control/1 (one session)
(cd $WT && env -u CLAIM_ENABLED -u REGISTRY_ENABLED SECRET=seam-readonly ENABLE_MPS=0 ISOLATION_BACKEND=snp-guest-per-app VMMGR_URL=http://127.0.0.1:8095 \
  GUESTD_KEY_FILE=$PROD/guestd-pair.key ISOLATION_SELFTEST= POOL_SELFTEST= GUEST_POOL_SELFTEST= INSTANCE_SELFTEST= SWEEP_SELFTEST= REACH_SELFTEST= \
  GUESTD_TRANSPORT_SELFTEST='{"calls":[{"method":"GET","path":"/health"},{"method":"GET","path":"/vms"}]}' node supervisor.js 2>guestd-seam.err | tail -1) > guestd.json
# instance records (host bookkeeping, no secrets)
for f in $PROD/guestd-root/gd*/instance.json; do sha256sum "$f"; done > instance.sha256
# node config: only its hash and dist (it holds the operator key)
sha256sum ~/Projects/enclave/metal/config.iso.json | cut -c1-64 > config.sha256; python3 -c "import json;print(json.load(open('/home/steven/Projects/enclave/metal/config.iso.json'))['dist'])" > config-dist.txt
# relay view of the node
curl -sS --max-time 20 https://api.enclave.host/enclaves | python3 -c "import json,sys; d=json.load(sys.stdin); r=[e for e in d.get('enclaves',[]) if 'metal-iso0' in json.dumps(e)]; print(json.dumps([{k:e.get(k) for k in ('id','name','endpoint','mode','tier','serving','eligible','ineligible','teeCpu')} for e in r], indent=1))" > relay-row.json 2>&1
curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability > availability.json 2>&1
# the relay's allowlist (read one line only)
ssh -i ~/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan "grep -E '^METAL_ALLOWED_MEASUREMENTS=' /etc/nan-relay/api-relay.env" > allowlist.txt 2>allowlist.err
# canaries: public TLS (default verification), served key, and the trusted-mode client through the production relay
python3 - "$D/guestd.json" > canaries.tsv <<'PY'
import json,sys
calls=json.load(open(sys.argv[1]))
for v in calls[1]["body"]["vms"]:
    print("\t".join([v["name"], v["id"], v.get("status",""), v.get("appId",""), v.get("measurement",""), v.get("transportKeySha256",""), v.get("hostData","")]))
PY
: > public.txt; : > trusted.txt; ids=""
while IFS=$'\t' read -r name id st app meas key hd; do
  lab=${name:2:8}; ids="$ids $name"; host=$lab.app.enclave.host
  r=$(curl -sS --max-time 30 -o body-$lab.bin -w '%{http_code} verify=%{ssl_verify_result}' https://$host/ 2>&1)
  spki=$(timeout 30 openssl s_client -connect $host:443 -servername $host </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64)
  echo "$lab $id $st http=$r body_sha=$(sha256sum body-$lab.bin | cut -c1-16) served_spki=$spki guestd_key=$key match=$([ "$spki" = "$key" ] && echo yes || echo NO)" >> public.txt
  (cd $ISO/m2 && timeout 120 node client.mjs https://$host --measurement $meas --app-sha $app --host-data $hd --runtime $PROD/guestd-root/expected-runtime.json \
     --vcek ~/.cache/enclave-isolation/m3-clean/vcek.der --amd-chain Turin=$PROD/iso-03be27d6/test/fixtures/amd/Turin-cert_chain.pem \
     --min-tcb @/home/steven/.cache/enclave-isolation/m3-clean/min-tcb.json --no-kds > $D/client-$lab.txt 2>&1)
  echo "$lab $(grep -m1 '^VERDICT' client-$lab.txt) $(grep -m1 '^RESULT gate=' client-$lab.txt) $(grep -m1 '^RESULT spki_sha256=' client-$lab.txt)" >> trusted.txt
done < canaries.tsv
# 99's S2 finding: any guest or claim on metal-iso0 that is NOT one of the three canaries makes a dist rollback unsafe
awk -F'\t' '{print $1}' canaries.tsv | while read -r n; do case "${n:0:10}" in 0x395bed3e|0x0ddbd824|0x4e62e60d) ;; *) echo "$n";; esac; done > noncanary.txt
echo "non-canary guests on metal-iso0 (guestd): $(wc -l < noncanary.txt)"
node $EV/noncanary.mjs > noncanary-chain.json 2>&1 || echo "  (chain read FAILED: treat as unsafe)" >> noncanary-chain.json
node $EV/chain.mjs $ids > chain.json 2> chain.err
date -u +%Y-%m-%dT%H:%M:%SZ >> at.txt
echo "collected $L into $D"
