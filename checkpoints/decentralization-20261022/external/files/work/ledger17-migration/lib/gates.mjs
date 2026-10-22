// The migration's refusal gates, shared by the CLI and the rehearsal (G4 retirement, import, seal).
// Each returns normally only when every prerequisite holds, and otherwise throws with the exact unmet condition.

/** G4: old.retire() is planned only after the replacement is proven complete. Retirement is one-way on Base. */
export function assertCanRetire(f) {
  const need = {
    'new ledger + libraries + dependents deployed with code equal to the verified builds': f.codeVerified,
    'owner parameters equal the live ledger': f.parametersEqual,
    'one-shot bindings set (prover, fee router, bandwidth router when live has one)': f.bindingsSet,
    'rehearsal passed on a fork of the same block (import parity, conservation, seal)': f.rehearsalPassed,
    'client readiness attested by their owners (supervisor + CLI read rev 17 and follow the book)': f.clientReadiness,
    'escrow re-backing plan computed from the live snapshot': f.escrowPlan,
  };
  const missing = Object.entries(need).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) throw Error('retirement refused: ' + missing.join('; '));
}

/** The final import reads snapshot F only from a RETIRED source: before that, records still change under it. */
export function assertCanImport({ sourceRetired }) {
  if (!sourceRetired) throw Error('import refused: the source ledger is not retired, so snapshot F would not be final');
}

/** sealImports / ownership handoff only after a complete, field-exact import. */
export function assertCanSeal(par) {
  if (!par || par.bad.length || par.ok !== par.total) throw Error(`seal refused: ${par ? par.bad.length + ' parity failure(s), ' + par.ok + '/' + par.total : 'no parity result'}`);
}

/** Platform escrow re-backing only after sealImports: before it, an owner-side fundEscrow credits ownerEscrow6. */
export function assertCanBack({ importsSealed }) {
  if (!importsSealed) throw Error('backing refused: imports are still open, so platform escrow would become owner-refundable');
}
