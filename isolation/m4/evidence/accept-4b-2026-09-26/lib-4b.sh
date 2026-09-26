# Step 4b (ENABLEMENT.md rev 6.1, 154b41a9): the config- and secret-bearing acceptance deployment, the agent wallet's own,
# non-sensitive per-run values. enclave-5d's accept-4b.sh (083464ae; reviewed by enclave-63 and enclave-e3) does prepare,
# bin, deploy, proofs 3-7 and teardown; THIS package (enclave-63) does the rest: the record check, the negative control
# (refused while unlisted), the relay listing (relay-list.sh, as root on nan, under the release lock), proofs 1, 2, 8
# and 9, and the post-teardown check. Sourced AFTER ../pool-rollout-20260925/lib.sh, ../s4c-20260925/lib4cc.sh,
# ../release-on-20260925/lib-ro.sh and ../e4-20260925/lib-e4.sh.
B4=~/enclave-bench/accept-4b-20260926; LOGB=$B4/4b.log
CLIWT=$B4/cliwt; ACC=$CLIWT/isolation/restore/accept-4b.sh; ACC_SHA=083464aeba88ee9344ca5cd3b5d60e3265629dfc21bf9292c1a6a8c0ac1005dd
ACC_COMMIT=154b41a9; RL=$B4/relay-list.sh
A69M_HEAD=20319b02; A69M_TAIL=ef47       # a69dcbba's 79c5ecf2 prediction as ENABLEMENT records it (a69dcbba holds no lease now, so the relay answers not_leased)
APPREF='catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0'
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGB"; } 2>/dev/null || true; }
# relay-list.sh on nan: the same private-dir + sha + flock path as nan_run, with its two (validated, public) arguments
nan_list() {   # add|remove 0x<64 hex>
  local act=$1 id=$2 d s
  [[ "$act" =~ ^(add|remove)$ ]] && [[ "$id" =~ ^0x[0-9a-f]{64}$ ]] || return 93
  d=$($NANX 'umask 077; mktemp -d') && [[ "$d" =~ ^/tmp/tmp\.[A-Za-z0-9]+$ ]] || return 90
  $NANX "cat > $d/s.sh" < "$RL" || { $NANX "rm -rf $d" || true; return 91; }
  s=$($NANX "sha256sum $d/s.sh") && [ "${s:0:64}" = "$RL_SHA" ] || { $NANX "rm -rf $d" || true; return 92; }
  $NANX "flock -E 75 -w 600 /run/enclave-relay-release.lock sh $d/s.sh $act $id > $d/out 2>&1; rc=\$?; cat $d/out; rm -rf $d; exit \$rc"
}
RL_SHA=3afbae85c63e7314f52eff3960a2e32ea48ac4bf231c11ed7066eb3255ea5600
run_id() { grep '^ID=' "$1/state.env" | tail -1 | cut -d= -f2-; }
