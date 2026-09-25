# Shared constants and checks for the pool rollout scripts (sourced). Every check exits non-zero on anything unexpected.
EV=~/enclave-bench/pool-rollout-20260925; PROD=/home/steven/enclave-prod; WT=/home/steven/Projects/enclave-poolacct
U=~/.config/systemd/user/enclave-guestd.service; UBAK=$EV/secret/enclave-guestd.service.bak-pre-pool
NEWBIN=$PROD/bin/guestd.c42612c0; NEWBIN_SHA=4a5f8bd94e487fcd71e80efe27d8961c8416ad33e288156938fd90baaee4bbc3
C=/home/steven/Projects/enclave/metal/config.iso.json; CBAK=$EV/secret/config.iso.json.bak-pre-pool
OLDD=/home/steven/Projects/enclave/metal/dist-iso-8ed6231f; NEWD=/home/steven/Projects/enclave/metal/dist-iso-c42612c0
OLDM=04e953a4f856c817bd061e3fa91004c78be75f6a9951be44a02805fdd788f19c56c84b046d0fca6aa2085a6f7b99fc7b
NEWM=$(cat $EV/build/prediction.txt)
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
say() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a $EV/rollout.log; }
# the new measurement is the recorded prediction, and the image being switched to predicts exactly it (M5)
check_prediction() {
  [[ "$NEWM" =~ ^[0-9a-f]{96}$ ]] && [ "$NEWM" != "$OLDM" ] || { say "BAD prediction.txt"; return 1; }
  python3 -c "import json,sys; m=json.load(open('$NEWD/manifest.json')); sys.exit(0 if m['expectedMeasurement']['byVcpus']['4']=='$NEWM' and m['expectedMeasurement']['ovmfSha256'].startswith('142589cc') and m['supervisorOverlay']['commit'].startswith('c42612c0') and m['supervisorOverlay']['dirty'] is False else 1)" \
    || { say "the image's manifest does not predict prediction.txt"; return 1; }
}
# guestd over guestd-control/1, one session: /health and /vms
guestd_seam() {
  (cd $WT && env -u CLAIM_ENABLED -u REGISTRY_ENABLED SECRET=seam-readonly ENABLE_MPS=0 ISOLATION_BACKEND=snp-guest-per-app VMMGR_URL=http://127.0.0.1:8095 \
    GUESTD_KEY_FILE=$PROD/guestd-pair.key ISOLATION_SELFTEST= POOL_SELFTEST= GUEST_POOL_SELFTEST= INSTANCE_SELFTEST= SWEEP_SELFTEST= REACH_SELFTEST= \
    GUESTD_TRANSPORT_SELFTEST='{"calls":[{"method":"GET","path":"/health"},{"method":"GET","path":"/vms"}]}' node supervisor.js 2>/dev/null | tail -1)
}
# mode pool: budget 16384/800, free 11008/500, not overcommitted; mode nopool: an old guestd (no pool). Both: the 3 canaries
# running with their S0 transport keys, and nothing else.
check_guestd() {
  guestd_seam > $EV/.guestd.json || return 1
  python3 - "$1" $EV/.guestd.json $EV/s0-baseline/canaries.tsv <<'PY'
import json,sys
mode,f,base=sys.argv[1:]
try: c=json.load(open(f)); h=c[0]["body"]; vms=c[1]["body"]["vms"]
except Exception as e: print("unreadable guestd answer", e); sys.exit(1)
want={l.split("\t")[0]:l.split("\t")[5] for l in open(base).read().strip().split("\n")}
got={v["name"]:(v["status"],v.get("transportKeySha256")) for v in vms}
if set(got)!=set(want): print("guests differ from S0:", sorted(got)); sys.exit(1)
for n,k in want.items():
    if got[n]!=("running",k): print("guest", n[:10], got[n]); sys.exit(1)
p=h.get("pool")
# pool = the S1 budget 16384/800; pool64 = Steven's 65536/1600. Both: allocated exactly the 3 canaries (5376/300)
budgets={"pool":({"memMiB":16384,"cpuPct":800},{"memMiB":11008,"cpuPct":500}),"pool64":({"memMiB":65536,"cpuPct":1600},{"memMiB":60160,"cpuPct":1300})}
if mode in budgets:
    b,fr=budgets[mode]
    ok = p and p.get("budget")==b and p.get("free")==fr and p.get("allocated")=={"memMiB":5376,"cpuPct":300} and p.get("overcommitted") is False and p.get("guests")==3
    if not ok: print("pool:", p); sys.exit(1)
elif p is not None: print("an old guestd has no pool, but:", p); sys.exit(1)
print("guestd ok:", mode, "3 canaries running, same keys")
PY
}
# the node's attested measurement and overlay, from its raw SNP report (0x90) through the relay
node_attested() {
  curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/v1/attestation 2>/dev/null | python3 -c "
import json,sys,base64
d=json.load(sys.stdin); q=base64.b64decode(d['vm']['quote'])
print(q[0x90:0xC0].hex(), d['enclave']['attestationDocument']['manifest']['supervisorOverlay']['commit'])" 2>/dev/null
}
relay_row_ok() {
  curl -sS --max-time 20 https://api.enclave.host/enclaves | python3 -c "import json,sys; r=[e for e in json.load(sys.stdin).get('enclaves',[]) if e.get('name')=='metal-iso0']; sys.exit(0 if r and r[0].get('serving') and r[0].get('eligible') else 1)" 2>/dev/null
}
public_ok() {   # all 3 canaries: 200 over valid public TLS with their S0 key
  local n=0 lab key host r spki
  while read -r lab key; do
    host=$lab.app.enclave.host
    r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$host/ 2>/dev/null)
    spki=$(timeout 20 openssl s_client -connect $host:443 -servername $host </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64)
    if ! { [ "$r" = "200/0" ] && [ "$spki" = "$key" ]; }; then
      # ONE retry after 10 s: a single failed probe was seen at 17:41:45Z BEFORE any change (s0-baseline/notes.txt)
      local t=$(( $(date +%s) + 10 )); while [ $(date +%s) -lt $t ]; do sleep 2; done
      r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$host/ 2>/dev/null)
      spki=$(timeout 20 openssl s_client -connect $host:443 -servername $host </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64)
      [ "$r" = "200/0" ] && [ "$spki" = "$key" ] || { say "public FAIL $lab http=$r key=${spki:0:12} (after one retry)"; return 1; }
      say "public $lab recovered on its one retry"
    fi
    n=$((n+1))
  done < $EV/canary-keys.txt
  [ $n = 3 ] || { say "public checked $n canaries, not 3"; return 1; }
}
# 99's H2: a dist rollback is safe only while NO non-canary deployment runs on metal-iso0, by the chain AND by guestd.
# A failed read of either is UNSAFE.
noncanary_empty() {
  local j; j=$(node $EV/noncanary.mjs) || { say "UNSAFE: the chain read failed: $j"; return 1; }
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d['ok'] and d['nonCanary']==[] and len(d['onNode'])==3 else 1)" "$j" || { say "UNSAFE: chain lists $j"; return 1; }
  guestd_seam > $EV/.guestd-nc.json || { say "UNSAFE: guestd unreadable"; return 1; }
  python3 - $EV/.guestd-nc.json $EV/s0-baseline/canaries.tsv <<'PY' || { say "UNSAFE: guestd holds a non-canary guest or is unreadable"; return 1; }
import json,sys
try: vms=json.load(open(sys.argv[1]))[1]["body"]["vms"]
except Exception: sys.exit(1)
base={l.split("\t")[0] for l in open(sys.argv[2]).read().strip().split("\n")}
sys.exit(0 if len(vms)>0 and {v["name"] for v in vms} <= base else 1)
PY
}
# wait (by the clock) until a check passes, or give up
wait_for() { local secs=$1; shift; local end=$(( $(date +%s) + secs )); while :; do "$@" && return 0; [ $(date +%s) -ge $end ] && return 1; sleep 5; done; }
