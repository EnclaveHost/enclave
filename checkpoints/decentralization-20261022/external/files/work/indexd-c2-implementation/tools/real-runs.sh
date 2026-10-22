#!/bin/bash
# REAL SDK (C2-4 snapshot driver, bin/sdk-c2-4-driver) + REAL indexd interop: the SDK worker's C2-4 case list, one
# fresh run directory and one shared-queue allocation (768 MiB) per run, retried while the queue answers 98.
#   tools/real-runs.sh <run-prefix>        writes logs/real-<prefix>.summary and runs/<prefix>{c,o,r,b}/
set -u
cd "$(dirname "$0")/.." || exit 2
p=${1:?run prefix (lowercase letters/digits)}
export DRIVER=$PWD/bin/sdk-c2-4-driver SIAS3_REAL_INDEXD=c2 EXACT=1 QUEUE_MIB=768
sum=logs/real-$p.summary
: > "$sum"
run() { # run <id> <harness> <indexd-src> <tests...>
  local id=$1 h=$2 s=$3; shift 3
  local rc
  for i in $(seq 1 120); do
    HARNESS=$h INDEXD_SRC=$s tools/run-sdk-case-c2.sh "$id" "$@" > "logs/real-$id.out" 2>&1; rc=$?
    [ $rc -ne 98 ] && break; sleep 30
  done
  echo "== $id rc=$rc harness=$(sha256sum "$h" | cut -c1-16)" >> "$sum"
  grep -E "^test |test result" "logs/real-$id.out" >> "$sum"
}
C2=$PWD/bin/harness-c2 SRC=$PWD/src
OLD=$PWD/../storage-real-indexd/bin/harness-block OLDSRC=$PWD/../indexd-replica-rollout/src
run "${p}c" "$C2" "$SRC" \
  real_fencing::real_c2_a_post_raise_copy_can_neither_read_stale_nor_acknowledge_a_conflicting_create \
  real_fencing::real_c2_two_new_identical_writes_with_both_first_replies_lost_exactly_one_succeeds \
  real_fencing::real_c2_one_invocation_copied_after_its_nonce_is_applied_once \
  real_fencing::real_c2_a_held_mutation_delivered_after_its_replay_is_not_applied_twice \
  real_fencing::real_c2_an_old_v3_client_cannot_mutate_or_take_over_an_enrolled_account
run "${p}o" "$OLD" "$OLDSRC" \
  real_fencing::real_c2_an_indexer_without_cas_and_op_nonce_is_refused
run "${p}r" "$C2" "$SRC" \
  real_fencing::real_fence_endpoint_semantics_exact_receipt_and_refusals \
  real_fencing::real_fence_delayed_old_writer_pins_are_refused_after_a_new_install \
  real_fencing::real_fence_listing_after_install_sees_an_unpublished_acknowledged_pin \
  real_fencing::real_fence_two_starters_same_counter_one_writer
run "${p}b" "$C2" "$SRC" \
  real_fencing::real_fence_blocked_acknowledged_key_never_becomes_an_empty_successful_listing \
  real_fencing::real_fence_blocked_acknowledged_version_is_never_read_stale_or_repaired_back
echo "== done" >> "$sum"
