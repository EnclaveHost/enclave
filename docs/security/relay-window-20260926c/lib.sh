# The relay window after the canaries are on 5db18199 (enclave-87): 1 rs-10 (retire f7888d86; retire-f7888d86/) -> >=10 min ->
# 2 push the pre-warm PACING (pace-push.sh: relay/prewarm-pacing, bf GO). One api-relay
# restart per >=10 min (the NucBox soak); hold for any first launch of Steven's apps (63's watcher). No env value printed.
B=${B_DIR:-$HOME/enclave-bench/relay-window-20260926c}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HEALTH=$H/../hvnode-owner-only-rollout/health.sh   # KAT, canaries on boot keys, us-west, the 7 listed; CERT_SEPARATE=1 after step 3
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
NR="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 root@46.62.128.36"
PC=0a512d93e4b88ed0abe37e2d73457505133370f2   # relay/prewarm-pacing: 2 commits on main 317b31527 (e85019c6 pacing, 0a512d93 unref; bf GO)
BASE=$(git -C $MAIN rev-parse "$PC~2" 2>/dev/null || echo unknown)
REVIEW_BASE=317b31527   # the main bf reviewed the 2 commits on (release-prewarm 5/5, secrets-release 22/22)
# the REVIEWED patches, in order (git patch-id --stable): e85019c6 + 0a512d93 (bf GO); a re-cut must reproduce them exactly
PATCHIDS="bf8d7e578134a232038e409be493a420e8347939 199519b2e08ab9186c00a3b6af1b67f7aabfc20a"
FILES="relay/secrets-release.mjs test/release-prewarm.test.mjs"
declare -A SHA=(
  [secrets-release.mjs]=ff2bebd797e57097980e5a7a45823325294ea40e3b811961afaebc96c0dda052
)
RF=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77   # the admitted release after rs-10
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
