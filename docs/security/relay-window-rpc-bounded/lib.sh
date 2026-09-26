# The rpc-bounded relay window (enclave-87 09-26): relay/rpc-bounded (bf GO @ 323d89db: retryCount 1 on the agreeing-RPC clients +
# the slow-step line) onto main as ONE fast-forward = ONE relay deploy = ONE api-relay restart, AFTER rs-12. Mid-soak allowed:
# the NucBox mutex is taken with the peer's ACK before starting, and nucbox-k11 attach must be ACCEPTED. No env value printed.
B=${B_DIR:-$HOME/enclave-bench/relay-window-rpc-bounded}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HEALTH=$H/../hvnode-owner-only-rollout/health.sh   # KAT, canaries on boot keys, us-west, the 7 listed; CERT_SEPARATE=1 after step 3
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
PC=b291c6c0eddc3b1759dda94da0685db0d4daac91   # relay/rpc-bounded: 1 commit on main c6347dd20 (bf GO)
BASE=$(git -C $MAIN rev-parse "$PC~1" 2>/dev/null || echo unknown)
REVIEW_BASE=c6347dd20   # the main bf reviewed the commit on (relay-rpc-bounded 1/1, secrets-release 23/23)
# the REVIEWED patch (git patch-id --stable): 323d89db (bf GO); a re-cut must reproduce it exactly
PATCHIDS="7f8cc934bff3c9cbc5ce60820c3067b41a76a0ab"
FILES="relay/api-relay.js relay/secrets-release.mjs test/relay-rpc-bounded.test.mjs test/secrets-release.test.mjs"
declare -A SHA=(
  [api-relay.js]=5b6c7e36022d464ea71cdd41bb4a818247b61e165f2985b6db8685bd711edc79
  [secrets-release.mjs]=81d3f62358b576d764e8f8fa62d7fb440af1bc4ca2ca7f3d55679194dd4731f8
)
RF=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532   # the admitted release after rs-12 (R alone)
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
context_moved() { git -C "$1" diff --name-only $REVIEW_BASE origin/main -- relay/ site/ scripts/; }
files_are_pc() { local f got; for f in "$@"; do got=$($NAN "sha256sum < /opt/nan-relay/$f" | cut -c1-64); [ "$got" = "${SHA[$f]}" ] || { echo "$f is ${got:0:12}, not ${SHA[$f]:0:12}"; return 1; }; done; }
last_restart_age() { local t; t=$($NAN "systemctl show enclave-api-relay -p ActiveEnterTimestamp --value"); echo $(( $(date +%s) - $(date -d "$t" +%s) )); }
# the release listing, DERIVED from the live env (enclave-87 item 4: never hardcoded): the listed deployment ids, one per line
listed_ids() { $NAN "grep -E '^SECRETS_RELEASE_DEPLOYMENTS=' /etc/nan-relay/api-relay.env | cut -d= -f2 | tr ',' '\n' | grep -xE '0x[0-9a-f]{64}'"; }
# INSTANT predictor check right after a restart (enclave-5d S1 / 87 item 2): a predictor problem shows at once on
# /v1/expected-guest as predictor_unconfigured (no KAT wait - a problem suppresses the start KAT). 0 = predicting, 2 = a
# PROBLEM, 1 = no answer in 120 s. Warming (503) is retried.
probe_predictor() {
  local id=${1:-0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76} end=$(( $(date +%s) + 120 )) b c
  while :; do
    b=$(curl -sS -m 40 -w '\n%{http_code}' "https://api.enclave.host/v1/expected-guest?id=$id" 2>/dev/null); c=${b##*$'\n'}; b=${b%$'\n'*}
    grep -q predictor_unconfigured <<<"$b" && { echo "PROBLEM: ${b:0:300}"; return 2; }
    [ "$c" = 200 ] && { echo "predicting (200)"; return 0; }
    [ "$(date +%s)" -ge $end ] && { echo "no answer in 120 s (last $c: ${b:0:200})"; return 1; }
    sleep 5
  done
}
# the NucBox (87's mid-soak rule), as rs-11/rs-12 check it
HV=nucbox-k11
hv_row() { curl -sS -m 20 https://api.enclave.host/enclaves | python3 -c '
import json, sys
r = [e for e in json.load(sys.stdin).get("enclaves", []) if e.get("name") == sys.argv[1]]
if not r: print("absent"); sys.exit(0)
e = r[0]; print(e.get("mode") or "-", "true" if e.get("ownerOnly") is True else "false", *sorted(d.get("id", "") for d in (e.get("servesDeployments") or [])))' "${1:-$HV}"; }
hv_attach_line() { $NAN "journalctl _SYSTEMD_INVOCATION_ID=$1 --no-pager -o short-iso-precise | grep -m1 -F '[tunnel] ${2:-$HV} attached via attestation(hv-node)'" || true; }
