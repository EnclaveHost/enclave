#!/usr/bin/env bash
# hv-node attach flip (A): attach-only, on nan's api relay. Runs from warden-host.
#   hv-attach.sh on|off
# Before: the three SNP canaries' public TLS keys are recorded (the flip relaunches nothing, so after it each must serve
# 200 with the SAME key). Then hv-attach-remote.sh runs on nan as root (one line-wise edit, one restart, instant
# rollback if the relay does not stay up). After: hv-attach-accept.sh.
# WINDOW (enclave-87): only when d1 and 63 say no SNP canary observe or 4b step is running - releases go through this
# relay, and its restart drops every tunnel for about a minute.
set -euo pipefail
MODE=${1:?usage: hv-attach.sh on|off}; H=$(cd "$(dirname "$0")" && pwd)
OUT=${HV_OUT:-$HOME/enclave-bench/hvnode-attach-20260925}; mkdir -p "$OUT"
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; echo "$m" >> "$OUT/flip.log"; }
CANARIES="0ddbd824 395bed3e 4e62e60d"
spki() { timeout 20 openssl s_client -connect "$1.app.enclave.host:443" -servername "$1.app.enclave.host" </dev/null 2>/dev/null \
         | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64; }
: > "$OUT/keys-before-$MODE.txt"
for c in $CANARIES; do
  r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' "https://$c.app.enclave.host/" || true)
  [ "$r" = "200/0" ] || { say "REFUSING: canary $c answers $r before the flip (the fleet is not steady: not a window)"; exit 2; }
  echo "$c $(spki "$c")" >> "$OUT/keys-before-$MODE.txt"
done
# what the relay publishes from rows' own words, BEFORE (enclave-bf): the relay roster and the public volumes aggregate
# (-f: a 503 body - /v1/relays answers one WITHOUT labels when its ledger read fails - is never a snapshot; enclave-bf)
curl -sSf -m 20 https://api.enclave.host/v1/relays > "$OUT/relays-before-$MODE.json" \
  && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['relays'] and isinstance(d.get('labels'), dict) and d['labels']" "$OUT/relays-before-$MODE.json" \
  || { say "REFUSING: /v1/relays is not a 200 with relays AND a non-empty labels map before the flip"; exit 2; }
curl -sSf -m 20 https://api.enclave.host/availability > "$OUT/availability-before-$MODE.json" && python3 -c "import json,sys; json.load(open(sys.argv[1]))['volumes']" "$OUT/availability-before-$MODE.json" \
  || { say "REFUSING: /availability is not readable before the flip"; exit 2; }
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$OUT/inv0-$MODE.txt"
say "hv-attach $MODE: canary keys recorded; running the remote edit (invocation before: $(cut -c1-12 "$OUT/inv0-$MODE.txt"))"
set +e; $NAN "MODE=$MODE STAMP=$(date -u +%Y%m%dT%H%M%SZ) bash -s" < "$H/hv-attach-remote.sh" > "$OUT/remote-$MODE.txt" 2>&1; rc=$?; set -e
cat "$OUT/remote-$MODE.txt" | tee -a "$OUT/flip.log"
say "hv-attach $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: hv-attach-accept.sh $MODE")"
exit $rc
