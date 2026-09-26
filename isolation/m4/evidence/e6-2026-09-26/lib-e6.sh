# e6: the 3 canaries, RELEASE guests on 52156652 since e5, relaunch one at a time onto the HARDENED f7888d86 (image
# b63c2def: dominit holds yama ptrace_scope 2, user.max_user_namespaces 0, kernel.io_uring_disabled 2 and drops the app's
# privileges, on top of the console guard), by the owner's restart, AFTER the S7 tree switch put guestd on iso-b63c2def.
# Derived from lib-e5.sh. LEGM = each canary's CURRENT (52156652) measurement; RELM = its f7888d86 measurement computed
# INDEPENDENTLY with expected-measurement.sh --pin f7888d86 over the canary's live bundle (= e3's prediction, 03:07Z).
E4=~/enclave-bench/e6-20260926; LOG4=$E4/e6.log; ST=$E4/state
KEYS4=$ST/canary-keys.txt; TSV4=$ST/canaries.tsv
REL=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; RUNTIME=ccadb38a
OLDREL=52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1; NEWT=/home/steven/enclave-prod/iso-b63c2def
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG4"; } 2>/dev/null || true; }
# id8 -> full id, LEGM = its CURRENT measurement (the 52156652 release guest's, from e5), the app's own stdout marker (must
# stay absent: both releases discard the app's stdio), PREV (the order), CFGB (the version config it gets, unchanged), and
# RELM: its 52156652 measurement computed INDEPENDENTLY (enclave-bf, enclave-87: never only the relay's own prediction) with
# the installed tree's expected-measurement.sh --pin 52156652 ~/enclave-prod/release-4cdd5169 <the canary's app.bundle> 1;
# here with --pin f7888d86 over 53's release dir (byte-equal to e3's predictions at 03:07Z)
# CFGB: the config the relay releases. ENABLEMENT's "config:null" was a mis-prediction (0ddbd824, 23:50Z): the canaries'
# on-chain envelope is {"isolation":{"require":"snp-guest-per-app"}} (45 bytes, sha256 42c6f115f763f544...: the serial's
# envelope tag), which names no config, so the relay releases the catalog VERSION's inline config verbatim
# (versionConfigFor): only its public "_media" tile art (hookbin 0xf7e65a8f.../4 177 bytes sha256 f9beac1f...;
# 0x5356e8bd.../4 194 bytes f2486114...; read by enclave-d1 and enclave-e3 from two RPCs). The standard runner delivers the
# same (site/js/core/catalog.js), so it is parity. The one allowed origin is the relay's, always present (egress/policy.go).
canary() {
  case $1 in
    0ddbd824) FULL=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76
              LEGM=f4fb208aedddf04b29f65039f9f86008c7c65e4fd69bdb59fce6ffc3c9aa3c1d5e3ed14558f9728e0799357ab91dc11f
              MARK='^\[hookbin'; PREV=; CFGB=177
              RELM=a0101960e272080545e5c0ba7b32c74bbf16849050871b33cb9d52d5749c4b2df082b14148f27bc217ae02bf09f6541a;;
    395bed3e) FULL=0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595
              LEGM=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e
              MARK='^Serving HTTP on '; PREV=0ddbd824; CFGB=194
              RELM=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e;;
    4e62e60d) FULL=0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
              LEGM=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e
              MARK='^Serving HTTP on '; PREV=395bed3e; CFGB=194
              RELM=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e;;
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
# the relay's expected-guest image for $FULL under release $REL (f7888d86), and whether it is admitted
expected_rel() { curl -sS --max-time 20 "https://api.enclave.host/v1/expected-guest?id=$1" | python3 -c "import json,sys; r=json.load(sys.stdin); i=[x for x in r.get('images',[]) if x.get('release')=='$REL' and x.get('releaseAdmitted') is True]; sys.exit(1) if len(i)!=1 else print(i[0]['measurement'])"; }
# a serial with control codes stripped, CR removed
serial_clean() { sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' "$1" | tr -d '\r'; }
# lines that are neither the front/init's (DOM ..., the front's Go log: "YYYY/MM/DD hh:mm:ss DOM|http: ..."), the kernel's,
# nor blank: on a release guest (stdio discarded) there must be none
serial_foreign() { serial_clean "$1" | grep -vE '^\s*$|^DOM |^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9:]{8} (DOM |http: )|^\[ *[0-9]+\.[0-9]+\] ' || [ $? = 1 ]; }
