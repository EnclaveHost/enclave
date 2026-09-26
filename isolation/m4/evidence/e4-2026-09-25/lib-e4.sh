# 4e (ENABLEMENT.md step 4, rev 5 efdea70e): the canaries become RELEASE guests, one at a time, hookbin 0ddbd824 first,
# by the owner's restart (the agent wallet). Sourced AFTER ../pool-rollout-20260925/lib.sh, ../s4c-20260925/lib4cc.sh and
# ../release-on-20260925/lib-ro.sh. The S0 checks (public_ok, check_guestd) pin the S0 keys, which a relaunch changes by
# design, so 4e keeps its OWN expected state in state/ (copies of S0, one canary's key replaced on its acceptance).
E4=~/enclave-bench/e4-20260925; LOG4=$E4/e4.log; ST=$E4/state
KEYS4=$ST/canary-keys.txt; TSV4=$ST/canaries.tsv
REL=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4; RUNTIME=ccadb38a
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
# id8 -> full id, legacy measurement, release-79c5ecf2 measurement (ENABLEMENT step 4; re-checked against the relay), the
# app's own stdout marker (a control: the legacy guest's serial shows it; the release guest's must not)
# CFGB: the config the relay releases. ENABLEMENT's "config:null" was a mis-prediction (0ddbd824, 23:50Z): the canaries'
# on-chain envelope is {"isolation":{"require":"snp-guest-per-app"}} (45 bytes, sha256 42c6f115f763f544...: the serial's
# envelope tag), which names no config, so the relay releases the catalog VERSION's inline config verbatim
# (versionConfigFor): only its public "_media" tile art (hookbin 0xf7e65a8f.../4 177 bytes sha256 f9beac1f...;
# 0x5356e8bd.../4 194 bytes f2486114...; read by enclave-d1 and enclave-e3 from two RPCs). The standard runner delivers the
# same (site/js/core/catalog.js), so it is parity. The one allowed origin is the relay's, always present (egress/policy.go).
canary() {
  case $1 in
    0ddbd824) FULL=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76
              LEGM=be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d
              RELM=2317370df6562d5b03f2b4b78c297e0b14cf81cc0e53704f893e86dc305bf397e92233b226868bd219ca9246721262ea
              MARK='^\[hookbin'; PREV=; CFGB=177;;
    395bed3e) FULL=0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595
              LEGM=c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e
              RELM=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25
              MARK='^Serving HTTP on '; PREV=0ddbd824; CFGB=194;;
    4e62e60d) FULL=0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
              LEGM=c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e
              RELM=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25
              MARK='^Serving HTTP on '; PREV=395bed3e; CFGB=194;;
    *) return 1;;
  esac
  LABEL=$1; HOST=$1.app.enclave.host
}
# guestd's /vms now (one guestd_seam read into state/.guestd.json); a failed read prints nothing and returns 1
vms4() { guestd_seam > $ST/.guestd.json && python3 -c "import json; print(json.dumps(json.load(open('$ST/.guestd.json'))[1]['body']['vms']))"; }
# the guest entry for deployment $1 (guestd's "name" is the deployment id, "id" the guest), from the last vms4 read
entry4() { python3 -c "import json,sys; v=[x for x in json.load(open('$ST/.guestd.json'))[1]['body']['vms'] if x['name'].lower()=='$1'.lower()]; sys.exit(1) if len(v)!=1 else print(json.dumps(v[0]))"; }
# check_guestd pool64 against 4e's expected state: exactly the 3 canaries, each running with its CURRENT expected key
check_guestd4() {
  guestd_seam > $ST/.guestd.json || return 1
  python3 - $ST/.guestd.json $TSV4 <<'PY'
import json,sys
f,base=sys.argv[1:]
try: c=json.load(open(f)); h=c[0]["body"]; vms=c[1]["body"]["vms"]
except Exception as e: print("unreadable guestd answer", e); sys.exit(1)
want={l.split("\t")[0]:l.split("\t")[5] for l in open(base).read().strip().split("\n")}
got={v["name"]:(v["status"],v.get("transportKeySha256")) for v in vms}
if set(got)!=set(want): print("guests differ from 4e's expected:", sorted(got)); sys.exit(1)
for n,k in want.items():
    if got[n]!=("running",k): print("guest", n[:10], got[n]); sys.exit(1)
p=h.get("pool")
ok = p and p.get("budget")=={"memMiB":65536,"cpuPct":1600} and p.get("free")=={"memMiB":60160,"cpuPct":1300} and p.get("allocated")=={"memMiB":5376,"cpuPct":300} and p.get("overcommitted") is False and p.get("guests")==3
if not ok: print("pool:", p); sys.exit(1)
print("guestd ok: pool64, 3 canaries running with 4e's expected keys")
PY
}
# public_ok against 4e's expected keys: 200 over valid public TLS, SPKI = the expected key; one retry each (S0's rule)
public_ok4() {
  local n=0 lab key
  while read -r lab key; do
    pub1 "$lab" "$key" || { local t=$(( $(date +%s) + 10 )); while [ $(date +%s) -lt $t ]; do sleep 2; done
      pub1 "$lab" "$key" || { say "public FAIL $lab (after one retry)"; return 1; }; say "public $lab recovered on its one retry"; }
    n=$((n+1))
  done < $KEYS4
  [ $n = 3 ] || { say "public checked $n canaries, not 3"; return 1; }
}
pub1() {   # $1 label, $2 expected SPKI sha256
  local host=$1.app.enclave.host r spki
  r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$host/ 2>/dev/null)
  spki=$(timeout 20 openssl s_client -connect $host:443 -servername $host </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64)
  [ "$r" = "200/0" ] && [ "$spki" = "$2" ]
}
cert_serial() { timeout 20 openssl s_client -connect $1:443 -servername $1 </dev/null 2>/dev/null | openssl x509 -serial -noout 2>/dev/null | sed 's/^serial=//'; }
cert_names() { timeout 20 openssl s_client -connect $1:443 -servername $1 </dev/null 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | tr '\n' ' '; }
# the relay's expected-guest image for $FULL under release 79c5ecf2, and whether it is admitted
expected_rel() { curl -sS --max-time 20 "https://api.enclave.host/v1/expected-guest?id=$1" | python3 -c "import json,sys; r=json.load(sys.stdin); i=[x for x in r.get('images',[]) if x.get('release')=='$REL' and x.get('releaseAdmitted') is True]; sys.exit(1) if len(i)!=1 else print(i[0]['measurement'])"; }
# a serial with control codes stripped, CR removed
serial_clean() { sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' "$1" | tr -d '\r'; }
# lines that are neither the front/init's (DOM ..., the front's Go log: "YYYY/MM/DD hh:mm:ss DOM|http: ..."), the kernel's,
# nor blank: on a release guest (stdio discarded) there must be none
serial_foreign() { serial_clean "$1" | grep -vE '^\s*$|^DOM |^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9:]{8} (DOM |http: )|^\[ *[0-9]+\.[0-9]+\] ' || [ $? = 1 ]; }
