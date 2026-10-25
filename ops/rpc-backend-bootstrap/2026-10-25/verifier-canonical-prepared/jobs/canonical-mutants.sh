#!/usr/bin/env bash
# Negative controls: a mutant is KILLED only if it COMPILES (cargo test --no-run ok) and each named test FAILS with a
# panic; a compile error is INVALID (not a kill). M0 runs the cache tests on the UNPATCHED base (must fail by assertion).
# Root, after canonical-tests PASSES (q-exit-status.sh NAME MIB CMD...):
#   ./jobs/q-exit-status.sh canonical-mutants 2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-mutants.sh
# Exit 21 CLOSURE failure / 22 DEV-CACHE-MISSING (explicit blocker) / 23 CACHE-REUSE-REFUSED (optional
# CANONICAL_CACHE_FROM, see common.sh) happen before any mutant and are never verdicts.
. "$(dirname "$0")/common.sh"
X=$S/run/mutants-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1; cd $X/helios; closure_check $X; rc=0
verdict() {   # $1 name, $2 test binaries, rest: test names that must fail
  local n=$1 bins=$2; shift 2
  timeout -k 10 5400 cargo test --offline --locked -p helios-core $bins --no-run > $X/$n.build 2>&1 || { echo "$n: INVALID (does not compile; not a kill)"; rc=1; return; }
  timeout -k 10 1800 cargo test --offline --locked -p helios-core $bins -- --test-threads=1 > $X/$n.out 2>&1
  # killed ONLY by each named test's own assertion panic (check_cargo_output.py mutant); a compiler error is INVALID
  python3 $S/jobs/check_cargo_output.py mutant $X/$n.out "$@" > $X/$n.verdict; local v=$?; cat $X/$n.verdict
  case $v in 0) echo "$n: KILLED ($*)";; 3) echo "$n: INVALID (compiler error)"; rc=1;; *) echo "$n: SURVIVED"; rc=1;; esac
}
mutate() { python3 - "$@" <<'PY'
import sys, pathlib; f, a, b = sys.argv[1:4]; p = pathlib.Path(f); s = p.read_text(); assert s.count(a) == 1, (f, s.count(a)); p.write_text(s.replace(a, b))
PY
}
restore() { git -C $X/helios checkout -q -- . && git -C $X/helios clean -qfd && git -C $X/helios apply $S/canonical-block.patch && (sha256sum -c --quiet $S/PATCHED.sha256) || { echo "[FAIL] restore"; exit 9; }; }
G=core/src/client/canonical.rs; C=core/src/execution/providers/block/block_cache.rs; A=core/src/execution/ancestry.rs; N=core/src/client/node.rs; R=core/src/execution/providers/rpc.rs
T_GATE="--test canonical_block_gate"; T_NODE="--test node_canonical_methods"; T_CACHE="--test block_cache_exact_hash"
mutate $G '    if h.require_canonical == Some(true) {' '    if false {'
verdict M1-gate-ignores-require-canonical "$T_GATE" gate_true_on_known_noncanonical_refuses_not_canonical gate_root_counterexample_retained_descendant_refused gate_other_branch_below_head_refused_by_ancestry; restore
mutate $G '    if b.header().hash() != h.block_hash {' '    if false {'; verdict M2-gate-accepts-any-block-for-hash "$T_GATE" gate_wrong_block_for_hash_refused_for_every_flag; restore
mutate $G '    if delay > MAX_HEAD_AGE_SECS {' '    if false {'; verdict M3-gate-no-head-age "$T_GATE $T_NODE" gate_true_stale_head_refuses_false_passes node_stale_head_refuses_true_only; restore
mutate $C '                        .filter(|b| b.header().hash() == hash)
' ''; mutate $C '            for n in stale.into_iter().chain(replaced.then_some(block_number)) {' '            for n in std::iter::empty::<u64>() {'
verdict M4-cache-stale-index "$T_CACHE" reorg_a_to_b_unindexes_a aba_resolves_only_the_current_block multi_height_reorg_drops_stale_descendants; restore
mutate $A '            .get_block(BlockId::Hash(parent.into()), false)' '            .get_block(alloy::eips::BlockNumberOrTag::Number(cur.header().number() - 1).into(), false)'
mutate $A 'if next.header().hash() != parent || ' 'if '; verdict M5-ancestry-by-number "--test ancestor_block_hash" ancestor_follows_pinned_chain_not_canonical_by_number; restore
mutate $N '        self.recheck_canonical(&block_id).await?;
        value' '        value'; verdict M6-node-storage-post-check-removed "$T_NODE $T_GATE" node_reorg_during_read_refuses_every_method every_block_id_method_is_gated_before_and_after; restore
mutate $C '            let stale: Vec<u64> = blocks.range(block_number + 1..).map(|(n, _)| *n).collect();' '            let stale: Vec<u64> = Vec::new();'
verdict M7-cache-no-descendant-drop "$T_CACHE $T_GATE $T_NODE" multi_height_reorg_drops_stale_descendants finalized_conflict_drops_unsafe_branch_and_clears_latest block_cache_root_counterexample_refused node_root_counterexample_retained_descendant_refused; restore
mutate $G '        let at = ancestor_at::<N, E>(execution, &head, b.header().number(), block).await?;' '        let at = execution.get_block(BlockNumberOrTag::Number(b.header().number()).into(), false).await.map_err(|_| ClientError::BlockNotCanonical(*block))?.ok_or(ClientError::BlockNotCanonical(*block))?;'
verdict M8-gate-by-height "$T_GATE" gate_root_counterexample_retained_descendant_refused gate_other_branch_below_head_refused_by_ancestry gate_never_uses_height_lookup; restore
mutate $G '        if next.header().hash() != parent || next.header().number() + 1 != cur.header().number() {' '        if false {'; verdict M10-gate-no-link-check "$T_GATE" gate_forged_ancestry_link_refused; restore
mutate $R '        if let Some(block) = self.block_provider.get_block(block_id, full_tx).await? {
            exact(&block)?;' '        if let Some(block) = self.block_provider.get_block(block_id, full_tx).await? {'
verdict M11-provider-no-exact-postcondition "--test rpc_exact_hash_postcondition" provider_refuses_a_different_block_for_a_hash; restore
mutate $N '            BlockId::Hash(h) if h.require_canonical == Some(true) => self.check_block_id(block).await,' '            BlockId::Hash(_) => Ok(()),'
verdict M12-node-recheck-disabled "$T_NODE" node_reorg_during_read_refuses_every_method; restore
echo "== informational (expected SURVIVE: defence in depth)"
mutate $C '                        .filter(|b| b.header().hash() == hash)
' ''; (verdict I1-cache-filter-only-removed "$T_CACHE" reorg_a_to_b_unindexes_a) || true; restore
mutate $C '            for n in stale.into_iter().chain(replaced.then_some(block_number)) {' '            for n in std::iter::empty::<u64>() {'; (verdict I2-cache-unindex-only-removed "$T_CACHE" reorg_a_to_b_unindexes_a) || true; restore
mutate $G '    if number > top || top - number > MAX_CANONICAL_DEPTH {' '    if top.saturating_sub(number) > MAX_CANONICAL_DEPTH {'; (verdict I3-gate-no-above-head-check "$T_GATE" gate_root_counterexample_retained_descendant_refused) || true; restore
echo "== M0: the cache tests on the UNPATCHED base eeffcc9 (must fail by assertion: the stale-index defect)"
git -C $X/helios checkout -q -- . && git -C $X/helios clean -qfd && cp $S/patched/core/tests/block_cache_exact_hash.rs $X/helios/core/tests/
verdict M0-base-eeffcc9 "--test block_cache_exact_hash" reorg_a_to_b_unindexes_a aba_resolves_only_the_current_block multi_height_reorg_drops_stale_descendants finalized_conflict_drops_unsafe_branch_and_clears_latest
lock_unchanged $X
echo "MUTANTS rc=$rc"; exit $rc
