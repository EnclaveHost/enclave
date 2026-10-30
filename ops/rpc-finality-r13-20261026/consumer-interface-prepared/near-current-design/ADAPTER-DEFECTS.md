# Defects in ../src/finalized-anchor.mjs (sha 40cea262…; PREPARED, never integrated). Recorded, not hardened (superseded by the route question)

1. **Forged anchor accepted.** `readAnchorAccount` and `checkHeadAgainstAnchor` accept ANY object with `format === "enclave-base-finalized-anchor/v1"` and a hash-shaped `stateRoot`. A deserialized or forged JSON anchor, for example from the RPC VM, passes.
   - **Fix:** an unforgeable brand, i.e. a module-private `WeakSet` of objects returned by `authenticateFinalizedAnchor` (as the candidate's `VERIFIER_CLIENT` symbol does), checked by both functions.
2. **Omitted proof slots.** `readAnchorAccount` passes the source's `storageProof` to `checkProofResponse`, which proves only the entries **present**. A source that omits a requested slot yields `storage` without it, and a caller can misread that as zero.
   - **Fix:** require the proven slot set to equal the requested slots exactly (as `runA1` does with `proof_slots`).
3. **Future signed head accepted.** `checkHeadAgainstAnchor` only checks `now - head.timestamp <= maxHeadAgeMs`, so a head timestamped in the future passes.
   - **Fix:** deny unless `-futureSkewMs <= now - ts <= maxHeadAgeMs`.
4. **Minor.** Unvalidated `hdr.timestamp` / `headers[i].number` go straight to `BigInt` and throw generic errors rather than coded refusals.
