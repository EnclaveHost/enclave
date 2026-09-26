# 4e AGAIN, on the FIXED release (enclave-87): the 3 canaries, RELEASE guests on 79c5ecf2 since 4e, relaunch one at a time
# onto 52156652 (front console guard 4cdd5169: nothing but the front's own DOM statements reaches the host console), by
# the owner's restart (the agent wallet), AFTER the S5 tree switch put guestd's -isolation on iso-4cdd5169. Derived from
# lib-e4.sh. Sourced AFTER ../pool-rollout-20260925/lib.sh, ../s4c-20260925/lib4cc.sh and ../release-on-20260925/lib-ro.sh.
# The expected state (state/) starts as 4e's final one (the canaries' current keys), one key replaced per acceptance.
# Each canary's NEW measurement is not a constant: it is the relay's /v1/expected-guest answer for that id under
# 52156652, read before the restart and again after (e3's predictor admits it).
E4=~/enclave-bench/e5-20260926; LOG4=$E4/e5.log; ST=$E4/state
KEYS4=$ST/canary-keys.txt; TSV4=$ST/canaries.tsv
REL=52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1; RUNTIME=ccadb38a
OLDREL=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4; NEWT=/home/steven/enclave-prod/iso-4cdd5169
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
# id8 -> full id, LEGM = its CURRENT measurement (the 79c5ecf2 release guest's, from 4e), the app's own stdout marker (must
# stay absent: both releases discard the app's stdio), PREV (the order), CFGB (the version config it gets, unchanged), and
# RELM: its 52156652 measurement computed INDEPENDENTLY (enclave-bf, enclave-87: never only the relay's own prediction) with
# the installed tree's expected-measurement.sh --pin 52156652 ~/enclave-prod/release-4cdd5169 <the canary's app.bundle> 1;
# the same command --pin 79c5ecf2 release-aa6c985c reproduced the LIVE 79c5ecf2 measurements (2317370d, 6de87365) exactly
# CFGB: the config the relay releases. ENABLEMENT's "config:null" was a mis-prediction (0ddbd824, 23:50Z): the canaries'
# on-chain envelope is {"isolation":{"require":"snp-guest-per-app"}} (45 bytes, sha256 42c6f115f763f544...: the serial's
# envelope tag), which names no config, so the relay releases the catalog VERSION's inline config verbatim
# (versionConfigFor): only its public "_media" tile art (hookbin 0xf7e65a8f.../4 177 bytes sha256 f9beac1f...;
# 0x5356e8bd.../4 194 bytes f2486114...; read by enclave-d1 and enclave-e3 from two RPCs). The standard runner delivers the
# same (site/js/core/catalog.js), so it is parity. The one allowed origin is the relay's, always present (egress/policy.go).
canary() {
  case $1 in
    0ddbd824) FULL=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76
              LEGM=2317370df6562d5b03f2b4b78c297e0b14cf81cc0e53704f893e86dc305bf397e92233b226868bd219ca9246721262ea
              MARK='^\[hookbin'; PREV=; CFGB=177
              RELM=f4fb208aedddf04b29f65039f9f86008c7c65e4fd69bdb59fce6ffc3c9aa3c1d5e3ed14558f9728e0799357ab91dc11f;;
    395bed3e) FULL=0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595
              LEGM=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25
              MARK='^Serving HTTP on '; PREV=0ddbd824; CFGB=194
              RELM=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e;;
    4e62e60d) FULL=0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
              LEGM=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25
              MARK='^Serving HTTP on '; PREV=395bed3e; CFGB=194
              RELM=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e;;
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
