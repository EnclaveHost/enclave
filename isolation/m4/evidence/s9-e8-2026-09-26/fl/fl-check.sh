#!/usr/bin/env bash
# One of Steven's apps' FIRST LAUNCH (on whichever admitted release guestd's tree built: 5db18199 after S8, aee2059f after S9), checked READ-ONLY (started by fl-watch.sh at its setConfig). Never acts,
# never retries: a failure is a HOLD reported to enclave-87. Proofs:
#   A guest: guestd's release guest for it, running, release:true, verdict attested; measurement = the relay's 52156652
#     prediction for the id = expected-measurement.sh --pin 52156652 over the bundle that guest runs (a second derivation)
#   B relay: exactly ONE "released to a verified guest ... (runtime ccadb38a"; "(ticket kept)" lines only before it (<= 60 s);
#     no REFUSED / burned; plus the node's exactly one "release ticket handed to guest <gid>"
#   C serial: "DOM release: deployment 0x<id8>... envelope <sha256(on-chain envelope)[:16]>... N allowed origin(s), 0 refused,
#     config M bytes" < "DOM app config: M bytes" < "DOM serving ... spki = guestd's key"; no line but the front's/init's/kernel's
#   D certificate: the node installed a CA certificate for <id8>.app.enclave.host on that key, guest attested, no refusal
#   E public: <id8>.app.enclave.host via us-west, valid TLS on the guest's key, the certificate names the host
# Only sizes, counts and hashes are printed: never a config or secret byte.
set -uo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh; source ~/enclave-bench/fl-20260926/lib-fl.sh
app "${1:-}" || { echo "usage: fl-check.sh a69dcbba|d9798e4c|a77d0c57|7ae476a3"; exit 2; }
D=$FST/$AID-detected; [ -r $D ] || { say "no $D"; exit 2; }
T0=$(grep '^T0=' $D | cut -d= -f2-); ENVSHA=$(grep '^ENVSHA=' $D | cut -d= -f2-)
hold() { say "FIRST LAUNCH $AID HOLD: $* (nothing done; report to enclave-87)"; exit 25; }
RELAY=$(grep '^RELAY=' $D | cut -d= -f2-)
say "first launch $AID: checking from T0 $T0 UTC (envelope sha ${ENVSHA:0:16}, network.relay ${RELAY:--})"
# enclave-87: 7ae476a3's envelope must KEEP {"network":{"relay":"us-west"}} beside the new isolation.require
[ "$AID" != 7ae476a3 ] || [ "$RELAY" = us-west ] || hold "the envelope lost network.relay us-west (${RELAY:--})"
up() { vms4 >/dev/null && E=$(entry4 $AFULL) && python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['status']=='running' and e.get('release') is True else 1)" "$E"; }
wait_for 1800 up || hold "A: no running release guest for $AID within 30 min of its setConfig (claim or spawn: see the node journal)"
GID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E"); KEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['transportKeySha256'])" "$E")
MEAS=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['measurement'])" "$E"); VC=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['vcpus'])" "$E")
say "first launch $AID: release guest $GID running (vcpus $VC, key ${KEY:0:16})"
python3 -c "import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get('verdict')=='attested' else 1)" "$E" || hold "A: guestd's verdict is not attested"
# WHICH release: while two are admitted (52156652 and the hardened f7888d86, enclave-87: "both are safe"), the guest runs
# whichever tree guestd had at its spawn. The relay's admitted image whose measurement is the guest's names it; exactly
# one must match, and the independent derivation below uses THAT release's own tree and pinned release dir
declare -A RDIR=( [52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1]=/home/steven/enclave-prod/release-4cdd5169
                  [f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca]=/home/steven/enclave-prod/release-b63c2def
                  [5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77]=/home/steven/enclave-prod/release-0c087de8
                  [aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532]=/home/steven/enclave-prod/release-4cd26e58 )
declare -A RTREE=( [52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1]=/home/steven/enclave-prod/iso-4cdd5169
                   [f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca]=/home/steven/enclave-prod/iso-b63c2def
                   [5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77]=/home/steven/enclave-prod/iso-0c087de8
                   [aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532]=/home/steven/enclave-prod/iso-4cd26e58 )
pick() { EG=$(curl -sS --max-time 30 "https://api.enclave.host/v1/expected-guest?id=$AFULL") && IMG=$(python3 -c "import json,sys; r=json.loads(sys.argv[1]); i=[x for x in r.get('images',[]) if x.get('releaseAdmitted') is True and x.get('measurement')==sys.argv[2]]; sys.exit(1) if len(i)!=1 or not i[0].get('runtimeId') else print(i[0]['release'], i[0]['runtimeId'])" "$EG" "$MEAS"); }
wait_for 300 pick || hold "A: no single ADMITTED relay image for $AID has guestd's measurement ${MEAS:0:16} (the relay's prediction disagrees, or it is still warming)"
GREL=${IMG%% *}; RTID=${IMG##* }; M=$MEAS
# enclave-bf: once a switch has run (its restart time recorded in state/s<N>-switched-epoch), a guest CREATED after it
# must be that switch's release; one on anything else means the switch did not take. The newest switch is checked first:
# after S9 a new guest must be aee2059f; else after S8 5db18199; else after S7 f7888d86. Each rollback removes its epoch.
CA=$(python3 -c "import json,sys; print(int(json.loads(sys.argv[1])['createdAt']))" "$E")
[[ "$CA" =~ ^[0-9]{10}$ ]] || hold "A: $GID's createdAt is missing or not an epoch ('${CA:-none}'): the switch guard cannot place it"   # bf: never skip the guard (v6 failed open here)
for sw in "s9 aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532" "s8 5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77" "s7 f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca"; do
  sn=${sw%% *}; srel=${sw##* }
  [ -r $FST/$sn-switched-epoch ] || continue
  SW=$(cat $FST/$sn-switched-epoch); [[ "$SW" =~ ^[0-9]{10}$ ]] || hold "A: state/$sn-switched-epoch is not an epoch"
  [ "$CA" -gt "$SW" ] || continue
  [ "$GREL" = "$srel" ] || hold "A: $GID was created after the ${sn^^} switch but runs release ${GREL:0:8}, not ${srel:0:8}"
  break
done
[ -n "${RDIR[$GREL]:-}" ] && [ -d "${RDIR[$GREL]}" ] && [ -d "${RTREE[$GREL]}" ] || hold "A: the guest runs release ${GREL:0:12}, which has no installed tree/release dir here to derive it independently"
# the RUNTIME comes from that same prediction, never a constant (enclave-bf), and guestd must agree
GRT=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('runtimeId',''))" "$E")
[ "$GRT" = "$RTID" ] || hold "A: guestd's runtimeId ${GRT:0:16} is not the relay's predicted ${RTID:0:16}"
B=$PROD/guestd-root/$GID/app.bundle
IM=$(sh ${RTREE[$GREL]}/isolation/m4/expected-measurement.sh --pin $GREL ${RDIR[$GREL]} "$B" "$VC" 2>/dev/null | sed -n 's/^measurement //p')
[ "$IM" = "$MEAS" ] || hold "A: the independent expected-measurement.sh (release ${GREL:0:8}) over the guest's bundle gives '${IM:0:16}', not ${MEAS:0:16}"
# enclave-87 (S8): a guest on 5db18199 states its W^X self-test AT ATTEST, covering the runtime. guestd's own judge run
# (its workdir's verify.txt, iso-0c087de8's client.mjs) must say wx_coverage=runtime-covered, and the attested
# runtimeSelfTest must name runtime=<n>=1 or more, with the roles adding up to maps (as judge.mjs checks). On SNP the
# roles are runtime and root only (enclave-b4, front/runtime.go:138-144); the check accepts any judge.mjs role
WXC=-
if [ "$GREL" = 5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77 ] || [ "$GREL" = aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532 ]; then
  VT=$PROD/guestd-root/$GID/verify.txt
  grep -qx 'RESULT wx_coverage=runtime-covered' "$VT" 2>/dev/null || hold "A: guestd's verify.txt for $GID does not say wx_coverage=runtime-covered"
  grep -q '^VERDICT attested' "$VT" && grep -qx 'RESULT gate=open' "$VT" || hold "A: guestd's verify.txt for $GID lacks VERDICT attested or RESULT gate=open"
  WXC=$(python3 - "$VT" <<'PY2'
import json,re,sys
ln=[l for l in open(sys.argv[1]) if l.startswith('RESULT runtime_selftest=')]
assert len(ln)==1
st=ln[0].split('=',1)[1].strip(); st=json.loads(st) if st.startswith('"') else st
f=dict(p.split('=',1) for p in st.split())
roles=[r for r in ('runtime','front','init','root','other') if r in f]
assert f.get('wx')=='clean' and all(re.fullmatch(r'\d+',f[r]) for r in roles) and int(f.get('runtime','0'))>=1
assert sum(int(f[r]) for r in roles)==int(f['maps'])
print(st)
PY2
) || hold "A: $GID's attested runtime self-test does not cover the runtime (runtime>=1, roles = maps, wx=clean)"
fi
# b4's v44 manifest items 7-8 (S9): a guest on aee2059f STATES its runtime's seccomp filter; the attested self-test must
# carry seccomp=d4d17c9f… (the expected filter, 71 instructions) and guestd's verify.txt say the runtime is under it
if [ "$GREL" = aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532 ]; then
  grep -qF 'seccomp=d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66' <<<"$WXC" || hold "A: $GID's attested self-test does not state seccomp=d4d17c9f… ('$WXC')"
  grep -qF 'under the seccomp filter with program sha256 d4d17c9f' "$VT" || hold "A: guestd's verify.txt for $GID does not say the runtime is under the seccomp filter d4d17c9f…"
fi
say "first launch $AID A ok: attested on release ${GREL:0:8}, measurement ${MEAS:0:16} = the relay's admitted prediction = expected-measurement.sh (that release) over its bundle; runtime ${RTID:0:12} (guestd = the relay's); W^X self-test: ${WXC}"
SER=$PROD/guestd-root/$GID/$GID.serial
sv() { [ -r "$SER" ] && serial_clean "$SER" | grep -qE '^DOM serving vsock=443 spki_sha256=[0-9a-f]{64} '; }
wait_for 300 sv || hold "C: $GID's serial never reached DOM serving"
C=$(serial_clean "$SER")
rl=$(grep -nE "^DOM release: deployment 0x$AID\.\.\. envelope ${ENVSHA:0:16}\.\.\. [0-9]+ allowed origin\(s\), 0 refused, config [0-9]+ bytes\$" <<<"$C" | cut -d: -f1 || true)
[[ "$rl" =~ ^[0-9]+$ ]] || hold "C: no single 'DOM release' line naming the on-chain envelope ${ENVSHA:0:16} with 0 refused"
CB=$(sed -nE "${rl}s/.* config ([0-9]+) bytes\$/\1/p" <<<"$C"); NO=$(sed -nE "${rl}s/.*\.\.\. ([0-9]+) allowed origin.*/\1/p" <<<"$C")
cl=$(grep -nx "DOM app config: $CB bytes (ENCLAVE_CONFIG)" <<<"$C" | cut -d: -f1 || true)
sl=$(grep -nE '^DOM serving vsock=443 spki_sha256=[0-9a-f]{64} ' <<<"$C" | cut -d: -f1 || true)
[[ "$cl" =~ ^[0-9]+$ ]] && [[ "$sl" =~ ^[0-9]+$ ]] && [ "$rl" -lt "$cl" ] && [ "$cl" -lt "$sl" ] && [ "$CB" -gt 0 ] || hold "C: release ($rl) < app config $CB bytes (${cl:-none}) < serving (${sl:-none}) does not hold"
SPKI=$(sed -nE "${sl}s/^DOM serving vsock=443 spki_sha256=([0-9a-f]{64}) .*/\1/p" <<<"$C"); [ "$SPKI" = "$KEY" ] || hold "C: the serial serves ${SPKI:0:16}, not guestd's ${KEY:0:16}"
# b4's items 7-8 on the serial (aee2059f): init states the installed filter; none of the seccomp refusal lines
if [ "$GREL" = aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532 ]; then
  grep -qx 'DOM seccomp: app filter installed (sha256 d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66, 71 rules)' <<<"$C" || hold "C: the serial lacks 'DOM seccomp: app filter installed (sha256 d4d17c9f…, 71 rules)'"
  ! grep -qE "^DOM ERROR the app gave no seccomp statement|held init's seccomp statement pipe past its exec|seccomp statement is malformed|could not record the app's seccomp statement|seccomp filter could not be installed" <<<"$C" || hold "C: a seccomp refusal line in the serial"
fi
Fo=$(serial_foreign "$SER"); [ -z "$Fo" ] || hold "C: $(grep -c . <<<"$Fo") line(s) in the serial that are neither the front's, init's nor the kernel's"
say "first launch $AID C ok: DOM release (envelope ${ENVSHA:0:16} = the on-chain envelope, $NO allowed origin(s), 0 refused, config $CB bytes) < app config $CB bytes < serving on ${KEY:0:16}; no foreign lines"
RJ=$($NANX "journalctl -u enclave-api-relay --since '$T0 UTC' --no-pager -o short-iso-precise") || hold "B: the relay journal could not be read"
grep -iE "\[secrets-release\] ($AFULL:|ticket for $AFULL |ticket for 0x[0-9a-f]{64} presented for $AFULL:)" <<<"$RJ" > $FST/$AID-relay-lines.txt || true
p1=$(awk '/^p1=\$\(python3 - /{f=1;next} /^PY1$/{f=0} f' ~/enclave-bench/e5-20260926/e5-proofs.sh | python3 - $FST/$AID-relay-lines.txt "$AFULL" "${RTID:0:12}") || hold "B: the relay's lines are not the accepted shape: ${p1:-unreadable} ($AID-relay-lines.txt)"
NJ=$(journalctl --user -u enclave-metal-iso.service --since "$T0 UTC" --no-pager -o cat) || hold "B: the node journal could not be read"
grep -F "[isolation] 0x$AID:" <<<"$NJ" > $FST/$AID-node-lines.txt || true
[ "$(grep -cF "release ticket handed to guest $GID" $FST/$AID-node-lines.txt || [ $? = 1 ])" = 1 ] && ! grep -qE 'did not take the release ticket|release ticket pump for|release ticket for ' $FST/$AID-node-lines.txt || hold "B: not exactly one ticket handed to $GID"
say "first launch $AID B ok: $p1; one ticket handed to $GID"
certd() { NJ=$(journalctl --user -u enclave-metal-iso.service --since "$T0 UTC" --no-pager -o cat) && grep -qF "[isolation] 0x$AID: certificate for $AHOST installed in guest $GID (key ${KEY:0:16}…" <<<"$NJ"; }
wait_for 900 certd || hold "D: no certificate installed for $AHOST in $GID on key ${KEY:0:16} within 15 min"
grep -F "[isolation] 0x$AID:" <<<"$NJ" > $FST/$AID-node-lines.txt || true
grep -F "installed in guest $GID" $FST/$AID-node-lines.txt | grep -qF '; guest attested)' && ! grep -qE 'REFUSED|not an eligible|is no predicted image' $FST/$AID-node-lines.txt || hold "D: the certificate line is not 'guest attested', or a refusal line"
say "first launch $AID D ok: CA certificate installed in $GID for key ${KEY:0:16}, guest attested"
dns=$(getent ahostsv4 $AHOST | awk '{print $1}' | sort -u | paste -sd,)
tlsok() { local v s; v=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$AHOST/ 2>/dev/null); s=$(timeout 20 openssl s_client -connect $AHOST:443 -servername $AHOST </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64); HC=$v; [[ "$v" =~ ^[1-5][0-9][0-9]/0$ ]] && [ "$s" = "$KEY" ]; }
wait_for 300 tlsok || hold "E: https://$AHOST/ is not valid public TLS on the guest's key (last $HC; DNS $dns)"
cert_names $AHOST | grep -qF "$AHOST" || hold "E: the certificate does not name $AHOST"
say "first launch $AID E ok: https://$AHOST/ -> ${HC%/*} over valid TLS on $GID's key (DNS $dns), serial $(cert_serial $AHOST)"
say "FIRST LAUNCH $AID SERVING: all five checks pass (guest $GID, measurement ${MEAS:0:16})"
