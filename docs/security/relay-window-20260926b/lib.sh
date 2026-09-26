# The relay window after the canaries are on f7888d86 (enclave-87): 1 rs-8 (retire 52156652; retire-52156652/) -> >=10 min ->
# 2 push pre-warm + cert-set-separate (pc-2-push.sh) -> >=10 min -> 3 SECRETS_RELEASE_CERT_RELEASES (cs-3-env.sh). One api-relay
# restart per >=10 min (the NucBox soak); hold for any first launch of Steven's apps (63's watcher). No env value printed.
B=${B_DIR:-$HOME/enclave-bench/relay-window-20260926b}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HEALTH=$H/../hvnode-owner-only-rollout/health.sh   # KAT, canaries on boot keys, us-west, the 7 listed; CERT_SEPARATE=1 after step 3
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
NR="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 root@46.62.128.36"
PC=18b2821801e3dd5f0186dc361a65eb11570cada7   # relay/prewarm-certset-window: 4 commits re-cut onto main 335b0d8e
BASE=$(git -C $MAIN rev-parse "$PC~4" 2>/dev/null || echo unknown)
REVIEW_BASE=335b0d8e2   # the main these 4 commits were re-cut onto and tested on (release-prewarm 3/3, measurement-predict 25/25, secrets-release 22/22, owner-only 9/9)
# the REVIEWED patches, in order (git patch-id --stable): 73662f6b + dc3a3ede (bf GO), f0759181 + 6e301b16 (5d GO); a re-cut must reproduce them exactly
PATCHIDS="5a8720264be28e97fef0caccbcfb084a4d366e5f 23fd282bbac7ebef51e92f2fb9f12a8bb854c832 a9b402d6e1d1d8b05c2bd7c0b7f68394c86b2c14 f99aa3b9276543092473f7200ff0b7a5c59e5d96"
FILES="relay/api-relay.js relay/measurement-predict.mjs relay/secrets-release.mjs test/measurement-predict.test.mjs test/release-prewarm.test.mjs"
declare -A SHA=(
  [api-relay.js]=f2247cd58730168c11400cbc6b57144de4098dd5f8affb6f2490cb5598b2a10e
  [secrets-release.mjs]=a9066d06a1c5c426edf6c470039574ea6dda38514e8b6740dd41a1623791a981
  [measurement-predict.mjs]=5ba4975689bcee056960c11f47bb1a8f54592957b6779aef6fec6f42af0a590b
)
RF=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
context_moved() { git -C "$1" diff --name-only $REVIEW_BASE origin/main -- relay/ site/ scripts/; }
files_are_pc() { local f got; for f in "$@"; do got=$($NAN "sha256sum < /opt/nan-relay/$f" | cut -c1-64); [ "$got" = "${SHA[$f]}" ] || { echo "$f is ${got:0:12}, not ${SHA[$f]:0:12}"; return 1; }; done; }
last_restart_age() { local t; t=$($NAN "systemctl show enclave-api-relay -p ActiveEnterTimestamp --value"); echo $(( $(date +%s) - $(date -d "$t" +%s) )); }
