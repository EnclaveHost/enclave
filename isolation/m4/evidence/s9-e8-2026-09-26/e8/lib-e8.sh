# e8: the 3 canaries, RELEASE guests on 5db18199 since e7 (hookbin relaunched again on 5db18199 by n2acc), relaunch one at a
# time onto aee2059f (53's cut from 4cd26e58: the runtime's seccomp filter STATED at attest, b4's v44 manifest items 7-8)
# by the owner's restart, AFTER S9 put guestd.4cd26e58 on iso-4cd26e58 and N2-b put the node on N2 (fab9c6c7).
# Derived from lib-e7.sh. LEGM = each canary's CURRENT (5db18199) measurement (e7's RELM); RELM = its aee2059f
# measurement, computed INDEPENDENTLY (e8-pins.sh, the installed iso-4cd26e58's expected-measurement.sh; = e3's and bf's).
# The state is SEEDED from the latest accepted keys: n2acc's (hookbin's new key) once it accepted, else e7's.
E4=~/enclave-bench/e8-20260926; LOG4=$E4/e8.log; ST=$E4/state
KEYS4=$ST/canary-keys.txt; TSV4=$ST/canaries.tsv
REL=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532   # the runtime: from the relay prediction at the restart (before.json), never a constant
OLDREL=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; NEWT=/home/steven/enclave-prod/iso-4cd26e58; NBIN=/home/steven/enclave-prod/bin/guestd.4cd26e58
NODEM=fab9c6c76aca8d7650c05d5efdddc27b4b5aa76e7d81cd5c97365458513aedcf70ffe7d2817ac3836575b34917954bb0; NODEC=6845565a9dc0df5d8b469b8f2e74699c1aaa3444   # N2
SECF=d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66   # the expected app filter (b4 item 7: 71 instructions)
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
# id8 -> full id, LEGM = its CURRENT measurement (the 5db18199 release guest's, from e7), the app's own stdout marker (must
# stay absent: both releases discard the app's stdio), PREV (the order), CFGB (the version config it gets, unchanged), and
# RELM: its aee2059f measurement computed INDEPENDENTLY (enclave-bf, enclave-87: never only the relay's own prediction) with
# the installed tree's expected-measurement.sh --pin aee2059f ~/enclave-prod/release-4cd26e58 <the canary's app.bundle> 1
# (e8-pins.sh re-derives and checks them after the S9 install; e8-restart.sh refuses without its record)
# CFGB: the config the relay releases. ENABLEMENT's "config:null" was a mis-prediction (0ddbd824, 23:50Z): the canaries'
# on-chain envelope is {"isolation":{"require":"snp-guest-per-app"}} (45 bytes, sha256 42c6f115f763f544...: the serial's
# envelope tag), which names no config, so the relay releases the catalog VERSION's inline config verbatim
# (versionConfigFor): only its public "_media" tile art (hookbin 0xf7e65a8f.../4 177 bytes sha256 f9beac1f...;
# 0x5356e8bd.../4 194 bytes f2486114...; read by enclave-d1 and enclave-e3 from two RPCs). The standard runner delivers the
# same (site/js/core/catalog.js), so it is parity. The one allowed origin is the relay's, always present (egress/policy.go).
canary() {
  case $1 in
    0ddbd824) FULL=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76
              LEGM=6716ef1462e1ebabc4fd388c44dea5da1fe6902a60bedbc47aaaeae5199ee91003c8c842c34dde264b31d10c68d5871b
              MARK='^\[hookbin'; PREV=; CFGB=177
              RELM=3facefd88284eac612f9b4e71ee35fc7b200d74f352c4d8d20e8b35e4a9599a456b88716d3d4f0bf579ee156c0cb57f4;;
    395bed3e) FULL=0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595
              LEGM=be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b
              MARK='^Serving HTTP on '; PREV=0ddbd824; CFGB=194
              RELM=8a291bbf99818bdb6339ee34020d194d1de385c9f4597db60525c8cef0cc0318943e41d4d6d5ee4c3a98c4972b279504;;
    4e62e60d) FULL=0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
              LEGM=be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b
              MARK='^Serving HTTP on '; PREV=395bed3e; CFGB=194
              RELM=8a291bbf99818bdb6339ee34020d194d1de385c9f4597db60525c8cef0cc0318943e41d4d6d5ee4c3a98c4972b279504;;
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
# the relay's expected-guest image for $FULL under release $REL (aee2059f), and whether it is admitted
expected_rel() { curl -sS --max-time 20 "https://api.enclave.host/v1/expected-guest?id=$1" | python3 -c "import json,sys; r=json.load(sys.stdin); i=[x for x in r.get('images',[]) if x.get('release')=='$REL' and x.get('releaseAdmitted') is True]; sys.exit(1) if len(i)!=1 else print(i[0]['measurement'])"; }
# the same image's runtimeId (64 hex): the runtime the relay predicts for aee2059f, recorded at the restart
expected_rt() { curl -sS --max-time 20 "https://api.enclave.host/v1/expected-guest?id=$1" | python3 -c "import json,sys,re; r=json.load(sys.stdin); i=[x for x in r.get('images',[]) if x.get('release')=='$REL' and x.get('releaseAdmitted') is True]; sys.exit(1) if len(i)!=1 or not re.fullmatch('[0-9a-f]{64}', i[0].get('runtimeId','')) else print(i[0]['runtimeId'])"; }
# a serial with control codes stripped, CR removed
serial_clean() { sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' "$1" | tr -d '\r'; }
# lines that are neither the front/init's (DOM ..., the front's Go log: "YYYY/MM/DD hh:mm:ss DOM|http: ..."), the kernel's,
# nor blank: on a release guest (stdio discarded) there must be none
serial_foreign() { serial_clean "$1" | grep -vE '^\s*$|^DOM |^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9:]{8} (DOM |http: )|^\[ *[0-9]+\.[0-9]+\] ' || [ $? = 1 ]; }
