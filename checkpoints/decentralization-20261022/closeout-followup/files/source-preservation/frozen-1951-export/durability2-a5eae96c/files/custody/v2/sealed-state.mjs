// The custodian's sealed-state writes to its host (custody/v2/daemon.mjs), extracted so the exact write path can be tested.
// Writes run one after another in request order, and each seals the WHOLE state when its turn comes, so an older snapshot
// never lands after a newer one: a newer member save cannot be overwritten by an older DKG phase.
// The member part of a write is the member state as memberStore last WROTE it (or as loaded), never the live object: while a
// member write is pending its change is already in memory, and if that write fails the member rolls it back (member.mjs
// commit), so a concurrent checkpoint, host-policy or DKG write must not make the failed change durable. Resolving it at
// the write's turn (after every earlier member write has succeeded or failed) also never drops a member write that succeeded.
//   seal(state) -> sealed blob (the daemon's AES-GCM under the SNP derived key)
//   put(blob)   -> promise: the host's PUT /state (it keeps history and fsyncs: custody/v2/host.mjs)
export function createSealedStateWriter({ seal, put, state, log = () => {} }) {
  let writes = Promise.resolve();
  let written = state.member === undefined ? null : structuredClone(state.member);
  // member: the snapshot a member write carries; undefined = the last written member
  const write = (member) => {
    const next = writes.catch(() => {}).then(async () => {
      await put(seal({ ...state, member: member === undefined ? written : member }));
      if (member !== undefined) written = member;
    });
    writes = next; return next;
  };
  const saveNow = () => write(undefined);
  // the chain reader's block checkpoint: awaited by the reader
  const checkpoint = { load: () => state.chainCheckpoint, save: async (mark) => { state.chainCheckpoint = mark; await saveNow(); } };
  // the member engine's state (custody/v2/member.mjs): save RETURNS the write, which the member awaits before any
  // transaction or signature that relies on it (its durability barrier); a failed write is logged AND reaches the member
  const memberStore = { load: () => state.member, save: (m) => { state.member = m; return write(structuredClone(m)).catch((e) => { log(`STATE SAVE FAILED: ${e.message}`); throw e; }); } };
  // the platform host gate's accepted policy (network/platform-host-policy.mjs): deliberately not a barrier. The gate enforces
  // a newly anchored policy (a ban) at once; the record only carries its anti-rollback high-water across restarts
  const hostPolicyStore = { load: () => state.hostPolicy || null, save: (v) => { state.hostPolicy = v; saveNow().catch((e) => log(`STATE SAVE FAILED: ${e.message}`)); } };
  return { saveNow, checkpoint, memberStore, hostPolicyStore };
}
