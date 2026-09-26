# The owner-grace relay window (enclave-87's ruling, 09-26): relay/owner-grace (5d GO) onto main as ONE fast-forward = ONE relay
# deploy = ONE api-relay restart, AFTER d1's final NucBox soak summary and BEFORE the v42 reboot acceptance. Only nan's
# enclave-api-relay loads the changed files (tunnel.js via api-relay.js); us-west and the SNI relays never do. No env value printed.
B=${B_DIR:-$HOME/enclave-bench/relay-window-owner-grace}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HEALTH=$H/../hvnode-owner-only-rollout/health.sh   # KAT, canaries on boot keys, us-west, the live listing; CERT_SEPARATE=1
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
PC=64186b97d481b8774f637984b5dfef6e948b6643   # relay/owner-grace: 2 commits on main 3212f1470 (9268236f grace, 64186b97 bind log; 5d GO)
BASE=$(git -C $MAIN rev-parse "$PC~2" 2>/dev/null || echo unknown)
REVIEW_BASE=3212f1470   # 5d reviewed the 2 commits on f14612717 (62469d05 + 9aa2f366); re-cut onto 3212f147 patch-identical
# the REVIEWED patches, in order (git patch-id --stable): 62469d05 + 9aa2f366 (5d GO); a re-cut must reproduce them exactly
PATCHIDS="f0aa3b480242c802eea72dfd5a62392ada93245b 00f1e8a8a4a85b97c5a5f7bf916c786962e22ed9"
FILES="relay/api-relay.js relay/tunnel.js test/relay-hvnode-owner-only.test.mjs"
declare -A SHA=(
  [tunnel.js]=df9afd1e343dff12db5e8de6a96378d3f15500768e32452ec1ab5bbf9cf0f6db
  [api-relay.js]=7f4d60929701fc22c46340a924d2826aabf4ffab0c8bde8f392a24330e6eeb1d
)
RF=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77   # the admitted release (since rs-10)
HV=nucbox-k11                     # the owner-only hv-node box (test 1 served over nan's /x)
SOAK_END=2026-09-26T16:01:05Z     # d1's soak loop end, from its start record (04:01:05.221Z + 43200 s); a hard floor
# the SOAK gate (enclave-5d's REQUIRED fixes): prints open|closed, or a REFUSING reason with status 2 for a DRY other than exactly
# 0 or 1 (DRY=true must never read as a live run) or a floor that does not parse (it must never fail OPEN). $1 = now in epoch
# seconds - og-push passes $(date +%s); never taken from the environment - $2 DRY, $3 SOAK_DONE, $4 SOAK_END.
soak_gate() {
  local now=$1 dry=${2:-0} done=${3:-0} end=${4:-} floor
  case "$dry" in 0|1) ;; *) echo "REFUSING: DRY must be exactly 0 or 1 (got '${dry:0:12}')"; return 2;; esac
  # a strict UTC literal first: `date -d ""` (and other odd strings) parse as a time too, which would fail OPEN
  [[ "$end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && floor=$(date -u -d "$end" +%s 2>/dev/null) && [[ "$floor" =~ ^[0-9]+$ ]] \
    || { echo "REFUSING: SOAK_END '${end:0:40}' does not parse to a time"; return 2; }
  [[ "$now" =~ ^[0-9]+$ ]] || { echo "REFUSING: now '${now:0:20}' is not a time"; return 2; }
  if [ "$now" -ge "$floor" ] && [ "$done" = 1 ]; then echo open; else echo closed; fi
}
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
context_moved() { git -C "$1" diff --name-only $REVIEW_BASE origin/main -- relay/ site/ scripts/; }
files_are_pc() { local f got; for f in "$@"; do got=$($NAN "sha256sum < /opt/nan-relay/$f" | cut -c1-64); [ "$got" = "${SHA[$f]}" ] || { echo "$f is ${got:0:12}, not ${SHA[$f]:0:12}"; return 1; }; done; }
last_restart_age() { local t; t=$($NAN "systemctl show enclave-api-relay -p ActiveEnterTimestamp --value"); echo $(( $(date +%s) - $(date -d "$t" +%s) )); }
listed_ids() { $NAN "grep -E '^SECRETS_RELEASE_DEPLOYMENTS=' /etc/nan-relay/api-relay.env | cut -d= -f2 | tr ',' '\n' | grep -xE '0x[0-9a-f]{64}'"; }
# the hv-node row on the PUBLIC /enclaves: "<mode> <ownerOnly> <served id> …" (served ids sorted), or "absent"
hv_row() {
  curl -sS -m 20 https://api.enclave.host/enclaves | python3 -c '
import json, sys
name = sys.argv[1]; rows = [e for e in json.load(sys.stdin).get("enclaves", []) if e.get("name") == name]
if not rows: print("absent"); sys.exit(0)
e = rows[0]; ids = sorted(d.get("id", "") for d in (e.get("servesDeployments") or []))
print(e.get("mode") or "-", "true" if e.get("ownerOnly") is True else "false", *ids)' "${1:-$HV}"
}
# the hv-node box's attach line in THIS invocation's journal (empty = not attached in it)
hv_attach_line() { $NAN "journalctl _SYSTEMD_INVOCATION_ID=$1 --no-pager -o short-iso-precise | grep -m1 -F '[tunnel] ${2:-$HV} attached via attestation(hv-node)'" || true; }
# owner-grace's state-change and env-complaint lines in THIS invocation's journal: a count (0 expected after a clean restart)
GRACE_RE='owner-only serving SUSPENDED|owner-only starts SUSPENDED|owner read FAILED: serving on|TUNNEL_OWNER_(GRACE|RECHECK)_MS=.* is not a whole number'
grace_lines() { $NAN "journalctl _SYSTEMD_INVOCATION_ID=$1 --no-pager -o cat | grep -cE '$GRACE_RE'" || true; }
# INSTANT predictor check right after a restart (as pacing): 0 predicting, 2 a PROBLEM (predictor_unconfigured), 1 no answer in 120 s
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
