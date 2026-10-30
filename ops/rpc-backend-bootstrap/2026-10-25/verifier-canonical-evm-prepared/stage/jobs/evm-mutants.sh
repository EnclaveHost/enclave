#!/usr/bin/env bash
# Negative controls for the EVM tests: a mutant is KILLED only if it COMPILES (cargo test --no-run ok) and each named
# test FAILS with its own assertion panic and actual cargo exit 101 (validated strict r2 check_cargo_mutant.py).
# Root, after evm-tests PASSES (q-exit-status.sh NAME MIB CMD...):
#   ./jobs/q-exit-status.sh canonical-evm-mutants 2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-mutants.sh
# Exit 21/22/23 (closure / dev-cache / cache-reuse) happen before any mutant and are never verdicts; 0 = all critical
# mutants KILLED; 1 = any critical mutant INVALID or SURVIVED.
. "$(dirname "$0")/common.sh"
X=$S/run/evm-mutants-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1; cd $X/helios; closure_check $X; rc=0
verdict() {   # $1 name, rest: test names that must fail
  local n=$1; shift
  timeout -k 10 5400 cargo test --offline --locked -p helios-core $TESTS --no-run > $X/$n.build 2>&1 || { echo "$n: INVALID (does not compile; not a kill)"; tail -30 $X/$n.build; rc=1; return; }
  timeout -k 10 1800 cargo test --offline --locked -p helios-core $TESTS -- --test-threads=1 > $X/$n.out 2>&1; local trc=$?; echo "$trc" > $X/$n.rc
  python3 -I $S/jobs/check_cargo_mutant.py --out $X/$n.out --rc "$trc" --controls $S/EXPECTED-CONTROLS-EVM.txt --bins "$TESTS" "$@" > $X/$n.verdict; local v=$?; cat $X/$n.verdict
  case $v in 0) echo "$n: KILLED ($*)";; 1) echo "$n: SURVIVED"; rc=1;; *) echo "$n: INVALID (see verdict; never a kill)"; rc=1;; esac
}
mutate() { python3 - "$@" <<'PY'
import sys, pathlib; f, a, b = sys.argv[1:4]; p = pathlib.Path(f); s = p.read_text(); assert s.count(a) == 1, (f, s.count(a)); p.write_text(s.replace(a, b))
PY
}
restore() { git -C $X/helios checkout -q -- . && git -C $X/helios clean -qfd && git -C $X/helios apply $S/inputs/canonical-block.patch && git -C $X/helios apply $S/evm-tests.patch \
  && (sha256sum -c --quiet $S/inputs/PATCHED.sha256) && (sha256sum -c --quiet $S/EVM-TESTS.sha256) || { echo "[FAIL] restore"; exit 9; }; }
N=core/src/client/node.rs; P=revm-utils/src/proof_db.rs
# E1-E3: the node's requireCanonical post-check removed from each EVM method (killed by the reorg-during-proof-fetch tests)
mutate $N '        self.recheck_canonical(&block_id).await?;

        let res = match result {' '        let res = match result {'
verdict E1-call-post-check-removed evm_call_reorg_during_proof_fetch_refuses_require_canonical_true; restore
mutate $N '        self.recheck_canonical(&block_id).await?;

        Ok(result.tx_gas_used())' '        Ok(result.tx_gas_used())'
verdict E2-estimate-gas-post-check-removed evm_estimate_gas_binds_state_and_post_check_refuses_reorg; restore
mutate $N '        self.recheck_canonical(&block).await?;

        let access_list_result' '        let access_list_result'
verdict E3-create-access-list-post-check-removed evm_create_access_list_binds_state_and_post_check_refuses_reorg; restore
# E4: BLOCKHASH misbound to "the block at that height" (the base eeffcc9 lookup) instead of the pinned ancestry
mutate $P '                    let hash = helios_core::execution::ancestry::ancestor_block_hash::<N, E>(&*self.execution, self.block, number).await?;' \
          '                    let block_id = alloy::eips::BlockNumberOrTag::Number(number).into(); let hash = self.execution.get_block(block_id, false).await?.ok_or(ExecutionError::BlockNotFound(block_id))?.header().hash();'
verdict E4-blockhash-by-height evm_blockhash_is_pinned_parent_not_height_lookup; restore
# E5: call's exact-block pre-check removed (the EVM then pins whatever the upstream returned for the hash)
mutate $N '        self.check_block_id(&block_id).await?;
        let (result, ..) = N::transact(' '        let (result, ..) = N::transact('
verdict E5-call-pre-check-removed evm_unknown_hash_and_wrong_upstream_block_refused; restore
lock_unchanged $X
echo "RESULT: $([ $rc = 0 ] && echo 'ALL CRITICAL MUTANTS KILLED' || echo 'NOT ALL KILLED')"; exit $rc
