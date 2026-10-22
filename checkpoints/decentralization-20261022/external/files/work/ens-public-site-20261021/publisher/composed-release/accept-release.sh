#!/bin/bash
# READ-ONLY post-activation acceptance of the IPNS Publisher release (root runs it ONCE after the config step mined):
#   cd work/ens-public-site-20261021/publisher/composed-release
#   python3 ../../../claude-test-queue.py --mib 512 --log accept-release.guard.log -- bash accept-release.sh > accept-release.out 2>&1
# Exit 0 PASS | 2 RETRY-ONCE (only a VALIDATED cache lag: gateway answers complete but not yet exact, and/or the delegated
# router still serving the valid previous record; rerun once at the printed time) | 1 FAIL (anything else, including any
# timeout, transport error, missing/invalid output or missing gate/route). Every verdict is made by accept-decide.py.
# Phases run sequentially, each bounded by `timeout`; a FAIL in A (chain/publisher/record) or B (discovery) stops before
# the gateway phase. Never signs, writes, logs in, POSTs or restarts anything. Output: public data only.
#   A accept-gates.mjs  C1 C2 (chain, 2 RPCs) P1 P2 P3 (publisher status) R1 (delegated record, signature verified)
#   B accept-index.py   I1 crawl host, I2 cid.contact last ad == publisher head, I3 provider records (root + 6 children)
#   GW public-assets/probe.py (unchanged), sequential GETs with curl --max-time 45, on eth.link then eth.limo, over the
#      exact route list (accept-decide.py routes: / + every first-paint resource and navigation page), sha256 vs export
# Tests only: ACCEPT_STUBS=<dir> replaces the three phase commands with <dir>/A, <dir>/B, <dir>/GW; ACCEPT_OUT=<dir> moves
# the outputs; ACCEPT_T_A/B/GW shorten the timeouts. Root sets none of them.
set -u
cd "$(dirname "$0")"
OUT=${ACCEPT_OUT:-.}
T_A=${ACCEPT_T_A:-300}; T_B=${ACCEPT_T_B:-240}; T_GW=${ACCEPT_T_GW:-1500}
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
verdict() { echo "end $(ts)"; python3 accept-decide.py final "$SA" "$SB" "$SG1" "$SG2" | tee "$OUT/accept-verdict.json"; v=${PIPESTATUS[0]}
  case $v in 0) echo "RELEASE ACCEPT PASS";; 2) echo "RELEASE ACCEPT RETRY-ONCE: rerun once at $(date -u -d '+300 seconds' +%Y-%m-%dT%H:%M:%SZ) or later (caches live up to 300 s)";; *) echo "RELEASE ACCEPT FAIL";; esac
  exit $v; }
state() { python3 accept-decide.py "$@" | tee -a "$OUT/accept-decisions.jsonl" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['state'])" 2>/dev/null || echo fail; }
SA=skipped; SB=skipped; SG1=skipped; SG2=skipped
rm -f "$OUT"/accept-gates.json "$OUT"/accept-index.json "$OUT"/accept-gw-*.json "$OUT"/accept-decisions.jsonl "$OUT"/accept-verdict.json
echo "start $(ts)"
if [ -n "${ACCEPT_STUBS:-}" ]; then RUN_A=("$ACCEPT_STUBS/A"); RUN_B=("$ACCEPT_STUBS/B" "$OUT/accept-gates.json"); RUN_GW=("$ACCEPT_STUBS/GW")
else RUN_A=(node accept-gates.mjs); RUN_B=(python3 accept-index.py "$OUT/accept-gates.json"); RUN_GW=(python3 ../../public-assets/probe.py); fi

timeout -k 5 "$T_A" "${RUN_A[@]}" > "$OUT/accept-gates.json"; rc=$?
SA=$(state A "$OUT/accept-gates.json" $rc); echo "A $SA (exit $rc) $(ts)"
python3 -c "
import json; d=json.load(open('$OUT/accept-gates.json'))
for k,g in d['gates'].items(): print(' ', 'PASS' if g.get('pass') is True else 'FAIL', k, g.get('title',''), g.get('error',''))" 2>/dev/null
[ "$SA" = fail ] && verdict

timeout -k 5 "$T_B" "${RUN_B[@]}" > "$OUT/accept-index.json"; rc=$?
SB=$(state B "$OUT/accept-index.json" $rc); echo "B $SB (exit $rc) $(ts)"
python3 -c "
import json; d=json.load(open('$OUT/accept-index.json'))
for k,g in d['gates'].items(): print(' ', 'PASS' if g.get('pass') is True else 'FAIL', k, g.get('error',''))" 2>/dev/null
[ "$SB" = fail ] && verdict

mapfile -t ROUTES < <(python3 accept-decide.py routes) || true
i=0
for g in https://enclavehost.eth.link https://enclavehost.eth.limo; do
  i=$((i+1)); o="$OUT/accept-gw-$i.json"
  timeout -k 5 "$T_GW" "${RUN_GW[@]}" "$g" "$o" "${ROUTES[@]}" | sed "s#^#  $g #"; rc=${PIPESTATUS[0]}
  s=$(state GW "$o" $rc "$g"); echo "GW $g $s (exit $rc, ${#ROUTES[@]} routes) $(ts)"
  [ $i = 1 ] && SG1=$s || SG2=$s
done
verdict
