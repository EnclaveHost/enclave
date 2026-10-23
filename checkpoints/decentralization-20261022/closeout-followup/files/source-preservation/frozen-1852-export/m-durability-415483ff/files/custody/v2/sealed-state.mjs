// The custodian's sealed-state writes to its host (custody/v2/daemon.mjs), extracted so the exact write path can be tested.
// Each write seals the WHOLE state at the moment it is requested and the writes run one after another in request order,
// so an older snapshot never lands after a newer one: a newer member save cannot be overwritten by an older DKG phase.
//   seal(state) -> sealed blob (the daemon's AES-GCM under the SNP derived key)
//   put(blob)   -> promise: the host's PUT /state (it keeps history and fsyncs: custody/v2/host.mjs)
export function createSealedStateWriter({ seal, put, state, log = () => {} }) {
  let writes = Promise.resolve();
  const saveNow = () => { const blob = seal(state); const next = writes.catch(() => {}).then(() => put(blob)); writes = next; return next; };
  // the chain reader's block checkpoint: awaited by the reader
  const checkpoint = { load: () => state.chainCheckpoint, save: async (mark) => { state.chainCheckpoint = mark; await saveNow(); } };
  // the member engine's state (custody/v2/member.mjs): save RETURNS the write, which the member awaits before any
  // transaction or signature that relies on it (its durability barrier); a failed write is logged AND reaches the member
  const memberStore = { load: () => state.member, save: (m) => { state.member = m; return saveNow().catch((e) => { log(`STATE SAVE FAILED: ${e.message}`); throw e; }); } };
  // the platform host gate's accepted policy (network/platform-host-policy.mjs): deliberately not a barrier. The gate enforces
  // a newly anchored policy (a ban) at once; the record only carries its anti-rollback high-water across restarts
  const hostPolicyStore = { load: () => state.hostPolicy || null, save: (v) => { state.hostPolicy = v; saveNow().catch((e) => log(`STATE SAVE FAILED: ${e.message}`)); } };
  return { saveNow, checkpoint, memberStore, hostPolicyStore };
}
