#!/usr/bin/env bash
# LEGACY-PATH TRIPWIRE (enclave-87, S8): the legacy path's acceptance is carried by b4's run of the new judge on the legacy
# form plus THIS: the FIRST legacy-image guest (legacyImage:true: a non-release deployment, built from the -legacy-isolation
# tree iso-03be27d6 and judged by the NEW tree's judge with -legacy-isolation-release 5c3561f9,6f14ce75) that guestd starts
# after S8 is checked READ-ONLY and the result reported to enclave-87, PASS or FAIL. Never acts, never retries.
# PASS = all of:
#   - guestd reports it running, verdict attested;
#   - its workdir verify.txt (guestd's own judge run, written at its start) says VERDICT attested,
#     RESULT wx_coverage=runtime-unmeasured (the legacy self-test accepted as runtime W^X UNMEASURED, not clean),
#     RESULT app_on_pinned_key=1 and RESULT refused_handshakes=0;
#   - served: https://<id8>.app.enclave.host/ answers over valid public TLS on the guest's transport key within 15 min;
#   - no refusal line for its deployment in the node journal (REFUSED / not an eligible / no predicted image).
# FAIL = the guest goes "failed" (guestd's error is quoted, first 200 chars), or any check above fails.
# Polls guestd's /vms (the supervisor's read-only seam) every 15 s. A failed start rests in "failed" between the
# supervisor's escalating retries, so it is seen. Ends after its report, when S8 is rolled back (state/s8-switched-epoch
# gone), or after 14 days. Only ids, hashes, codes and counts are printed.
set -uo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh
TW=~/enclave-bench/tw-legacy-20260926; TST=$TW/state; LOGT=$TW/tw.log; EPF=~/enclave-bench/fl-20260926/state/s8-switched-epoch
PROD=/home/steven/enclave-prod
tsay() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGT"; } 2>/dev/null || true; }
fin() { tsay "LEGACY TRIPWIRE $1: $2 (report to enclave-87)"; echo "$1" > $TST/result; exit 0; }
[ -r "$EPF" ] || { tsay "tripwire: no S8 epoch ($EPF): S8 has not run; not starting"; exit 2; }
SW=$(cat "$EPF"); [[ "$SW" =~ ^[0-9]{10}$ ]] || { tsay "tripwire: the S8 epoch is not an epoch"; exit 2; }
end=$(( $(date +%s) + 14*86400 ))
tsay "tripwire: watching guestd /vms for the first legacy-image guest created after S8 (epoch $SW)"
G=""
while [ $(date +%s) -lt $end ]; do
  [ -r "$EPF" ] || { tsay "tripwire: S8 was rolled back (the epoch is gone): ending, no report"; exit 0; }
  if guestd_seam > $TST/.g.json 2>/dev/null; then
    # prints the candidate's fields, or NONE; a read it cannot parse prints nothing (and is retried, never "vanished")
    r=$(python3 - $TST/.g.json "$SW" "$G" <<'PY' 2>/dev/null
import json,sys
vms=json.load(open(sys.argv[1]))[1]["body"]["vms"]; sw=int(sys.argv[2]); want=sys.argv[3]
def ca(v):
    x=v.get("createdAt")
    return int(x) if isinstance(x,(int,float)) and not isinstance(x,bool) else None
# a legacy guest created after S8, or one whose createdAt is missing/unreadable (enclave-bf: never left out)
c=[v for v in vms if v.get("legacyImage") is True and (ca(v) is None or ca(v)>sw)]
if want: c=[v for v in vms if v["id"]==want]
c.sort(key=lambda v:(ca(v) or 0,v["id"]))
if c:
    v=c[0]; print(v["id"], v["name"], v.get("status","") or "-", v.get("verdict","-"), v.get("transportKeySha256","-"), (v.get("error") or "-").replace("\n"," ")[:200].replace(" ","_"), "ca" if ca(v) is not None else "noca")
else:
    print("NONE")
PY
)
    # enclave-bf: the first legacy guest gone from /vms before it was running or failed is reported, not waited on
    [ "$r" = NONE ] && [ -n "$G" ] && fin FAIL "legacy guest $G vanished from guestd before it was running or failed"
    if [ -n "$r" ] && [ "$r" != NONE ]; then
      set -- $r; GID=$1; NAME=$2; STS=$3; VD=$4; KEY=$5; ERR=${6//_/ }
      [ -n "$G" ] || { G=$GID; echo "$GID $NAME" > $TST/first; tsay "tripwire: first legacy guest $GID for ${NAME:0:10}... ($STS)$([ "$7" = ca ] || echo '; no readable createdAt: taken as after S8')"; }
      case "$STS" in
        failed) fin FAIL "legacy guest $GID for ${NAME:0:10} FAILED to start: $ERR" ;;
        running) break ;;
      esac
    fi
  fi
  sleep 15
done
[ -n "$G" ] || { tsay "tripwire: 14 days without a legacy guest; ending, no report"; exit 0; }
[ "$VD" = attested ] || fin FAIL "$GID is running but guestd's verdict is '$VD'"
VT=$PROD/guestd-root/$GID/verify.txt
[ -r "$VT" ] || fin FAIL "$GID: no verify.txt in its workdir"
cp -p "$VT" $TST/$GID-verify.txt
grep -q '^VERDICT attested' "$VT" || fin FAIL "$GID: verify.txt has no VERDICT attested"
grep -qx 'RESULT wx_coverage=runtime-unmeasured' "$VT" || fin FAIL "$GID: verify.txt says $(grep -m1 '^RESULT wx_coverage=' "$VT" || echo 'no wx_coverage'), not runtime-unmeasured"
grep -qx 'RESULT app_on_pinned_key=1' "$VT" && grep -qx 'RESULT refused_handshakes=0' "$VT" || fin FAIL "$GID: the app did not answer on the pinned key, or a handshake was refused"
ST8=$(grep -m1 '^RESULT runtime_selftest=' "$VT" | cut -d= -f2- | cut -c1-120)
tsay "tripwire: $GID attested by the new judge, wx_coverage=runtime-unmeasured, self-test $ST8; app answered on key ${KEY:0:16}"
AHOST=${NAME:2:8}.app.enclave.host
tlsok() { local v s; v=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' https://$AHOST/ 2>/dev/null); s=$(timeout 20 openssl s_client -connect $AHOST:443 -servername $AHOST </dev/null 2>/dev/null | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64); HC=$v; [[ "$v" =~ ^[1-5][0-9][0-9]/0$ ]] && [ "$s" = "$KEY" ]; }
HC=-; wait_for 900 tlsok || fin FAIL "$GID: https://$AHOST/ is not valid public TLS on the guest's key within 15 min (last $HC)"
NJ=$(journalctl --user -u enclave-metal-iso.service --since "@$SW" --no-pager -o cat 2>/dev/null) || fin FAIL "the node journal could not be read"
grep -F "[isolation] 0x${NAME:2:8}:" <<<"$NJ" > $TST/$GID-node-lines.txt || true
! grep -qE 'REFUSED|not an eligible|is no predicted image' $TST/$GID-node-lines.txt || fin FAIL "$GID: a refusal line in the node journal ($TST/$GID-node-lines.txt)"
fin PASS "legacy guest $GID (${NAME:0:10}...) created after S8: running, attested by the new judge with the legacy self-test as runtime W^X UNMEASURED, app answered on its key, https://$AHOST/ -> ${HC%/*} on that key, no refusal lines"
