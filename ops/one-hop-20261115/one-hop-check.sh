#!/bin/bash
# One hop, read only, for any time: where the owner's policy for the app is and whether the app's circuits are one hop.
# It changes nothing and needs no root. It is the check after the last step of the release (the owner's signature of
# enclaveNetwork.guard:false), and before that step it says which parts are not there yet and ends with 1.
#
#   one-hop-check.sh [deployment id]        the KVM Box app when none is given
#
# What it reads:
#   the relay (public API)        the policy it holds for the app: nonce, guard
#   each of the four edges (ssh)  the same policy in the edge's own directory (it must be the same nonce: the policy
#                                 bridge on the control VM copies it there, and the host reads it from the directories),
#                                 and how many of the edge's provider's peers are hosts without a guard (peers.direct)
#   the relay (public API)        what the app's host last reported: the policy nonce it runs, whether its operator
#                                 allows one hop for the app, each circuit's guard and exit
# An edge is reached by its ssh alias; no address is read, kept or printed. Of a provider's answer only the one count
# is used.
set -euo pipefail
APP=${1:-0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b}
[[ $APP =~ ^0x[0-9a-f]{64}$ ]] || { echo "usage: $0 [0x<64 hex, lower case>]" >&2; exit 2; }
API=${API:-https://api.enclave.host}
EDGES=(${EDGES:-us-west ca-east eu-central ap-southeast})
# the region a provider gives itself, for the edge it runs on
declare -A REGION=([us-west]=sfo3 [ca-east]=tor1 [eu-central]=fra1 [ap-southeast]=sgp1)
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
MISSING=()
miss() { MISSING+=("$1"); }

# "<nonce> <guard>" of a directory's policy answer on stdin ({envelope:{policy}}), "none none" when it holds none, "- -" when it is no such answer
policy() { python3 -I -c '
import sys, json
try:
    d = json.load(sys.stdin)
    if "envelope" not in d: raise ValueError("not a policy answer")
    p = (d["envelope"] or {}).get("policy")
    print(p["nonce"], str(p["enclaveNetwork"].get("guard", True)).lower()) if p else print("none none")
except Exception:
    print("- -")'; }

status=$(curl -s -m 20 "$API/v1/network/status/$APP" || true)
read -r R_SET R_NONCE R_GUARD < <(python3 -I -c '
import sys, json
try:
    d = json.loads(sys.argv[1]); p = d["policy"]
    print(str(bool(d.get("policySet"))).lower(), p["nonce"], str(p["enclaveNetwork"].get("guard", True)).lower())
except Exception:
    print("- - -")' "$status")
[ "$R_SET" != - ] || { say "STOP: the relay did not answer $API/v1/network/status/${APP:0:10}"; exit 1; }
if [ "$R_SET" = true ]; then say "relay: holds the owner's policy, nonce $R_NONCE, guard $R_GUARD"
else say "relay: holds no policy of the owner for this app (the default applies: guard true)"; fi
[ "$R_SET" = true ] && [ "$R_GUARD" = false ] || miss "the owner has not signed guard:false (the last step)"

declare -A DIRECT
for e in "${EDGES[@]}"; do
  got=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$e" "curl -s -m 8 http://127.0.0.1:${DIRPORT:-8188}/v1/network/policy/$APP; echo; curl -s -m 8 http://127.0.0.1:${CONTROL:-51822}/v1/info; echo" 2>/dev/null || true)
  read -r D_NONCE D_GUARD < <(sed -n 1p <<<"$got" | policy)
  DIRECT[$e]=$(sed -n 2p <<<"$got" | python3 -I -c '
import sys, json
try: print(int(json.load(sys.stdin)["status"]["peers"]["direct"]))
except Exception: print("-")')
  case "$D_NONCE" in
    -) say "$e: its directory did not answer"; miss "$e: directory not read" ;;
    none) say "$e: directory holds no policy for this app; provider's hosts without a guard: ${DIRECT[$e]}"
      [ "$R_SET" != true ] || miss "$e: the relay's policy is not in this directory" ;;
    *) say "$e: directory holds nonce $D_NONCE, guard $D_GUARD; provider's hosts without a guard: ${DIRECT[$e]}"
      [ "$D_NONCE $D_GUARD" = "$R_NONCE $R_GUARD" ] || miss "$e: its directory's policy is not the relay's (nonce $D_NONCE, guard $D_GUARD)" ;;
  esac
  [ "${DIRECT[$e]}" != - ] || miss "$e: its provider does not report peers.direct (not on this release, or not answering)"
done

# the host's last report: "<age s> <ready> <policy nonce> <oneHop> <circuits> <without a guard> <exit regions of those>"
read -r H_AGE H_READY H_NONCE H_ONE H_N H_DIRECT H_EXITS < <(python3 -I -c '
import sys, json, time
try:
    d = json.loads(sys.argv[1]); h = d.get("host")
    if not h: print("none - - - 0 0 -"); raise SystemExit
    cs = [c for c in h.get("circuits") or [] if c.get("kind", "network") != "direct"]
    one = [c for c in cs if not c.get("guard") and c.get("exit")]
    at = d.get("hostReportedAt"); age = int(time.time() - at / 1000) if isinstance(at, (int, float)) else "-"
    print(age, str(bool(h.get("ready"))).lower(), h.get("policyNonce", "-"), {True: "yes", False: "no"}.get(h.get("oneHop"), "unreported"), len(cs), len(one), ",".join(sorted({c["exit"].get("region") or "?" for c in one})) or "-")
except SystemExit: pass
except Exception: print("- - - - 0 0 -")' "$status")
if [ "$H_AGE" = none ] || [ "$H_AGE" = - ] && [ "$H_READY" = - ]; then
  say "host: the relay has no report from the app's host"; miss "no host report"
else
  say "host: reported $H_AGE s ago, ready $H_READY, runs policy nonce $H_NONCE, its operator allows one hop for this app: $H_ONE; circuits $H_N, of them without a guard $H_DIRECT"
  while IFS= read -r line; do say "$line"; done < <(python3 -I -c '
import sys, json
for c in (json.loads(sys.argv[1]).get("host") or {}).get("circuits") or []:
    if c.get("kind", "network") != "direct": print("  circuit: guard %s, exit %s, %s" % ((c.get("guard") or {}).get("region") or "none", (c.get("exit") or {}).get("region") or "none", "healthy" if c.get("healthy") else "NOT healthy"))' "$status" 2>/dev/null || true)
  [ "$H_ONE" = yes ] || miss "the host does not report that its operator allows one hop for this app (the NucBox agent step, or an agent that is not on this release)"
  [ "$R_SET" != true ] || [ "$H_NONCE" = "$R_NONCE" ] || miss "the host runs policy nonce $H_NONCE, not the relay's $R_NONCE (it reads the directories about once a minute)"
  [ "$H_N" -gt 0 ] && [ "$H_DIRECT" = "$H_N" ] || miss "$((H_N - H_DIRECT)) of the app's $H_N circuits have a guard"
  # the provider at the far end of a one-hop circuit counts this host among its peers without a guard
  for e in "${EDGES[@]}"; do
    case ",$H_EXITS," in *",${REGION[$e]:-?},"*) [[ ${DIRECT[$e]} =~ ^[1-9] ]] || miss "$e is the exit of a one-hop circuit but its provider counts no host without a guard" ;; esac
  done
fi

if [ "${#MISSING[@]}" = 0 ]; then say "ONE HOP: the app's circuits have no guard, and the relay, the four directories, the host and the exits agree"; exit 0; fi
say "not one hop yet (${#MISSING[@]}):"; for m in "${MISSING[@]}"; do say "  - $m"; done
exit 1
