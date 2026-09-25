# Reconnect in place through the combined U7 relay on the Pixel 10 (2026-09-25 14:15Z-14:36:53Z): the regression at 48c6efb3

**What this is.** The ONE bounded Pixel and local-chain regression that enclave-99 approved for review/pvm-u7-integration at
exactly **48c6efb3**. That revision is U7 18772bf7 (approved by enclave-d1 and enclave-5d) plus the pVM runner branch
742d1b01, with the pVM carve-out narrowed to enclave-99's conditions (shielded/anchor/avf/U7-INTEGRATION.md).
- **The run:** the same harness and plan as results/pvm-cpu-relay-reconnect (cpu/relay-reconnect-run.mjs, run from this
  worktree, so the relay is THIS tree's relay/api-relay.js). The only changes are the relay and U7.
- **The tree:** it equalled HEAD 48c6efb3 when the run started.
- **The APK is the same one** (`955d7ebb…`, code hash `15d9f8c7…a76a`). The payload, host, runner, harness and client dist
  at 48c6efb3 are byte-identical to 742d1b01's, and the payload and host are unchanged since the APK was built at 48030dd5.

**LAB, not production:**
- a local anvil chain with the real contracts, and no Base;
- fresh random operator keys held in memory (the run's own scan found neither in the results);
- a loopback lab relay started 9 times from an allowlisted environment, with `PVM_SERVING` on in the lab process only;
- the owner's authorized Pixel 10;
- ONE VM boot for the whole run.
Nothing was deployed, and no production setting was touched.

## Result: 43 of 43 steps as expected; `check.txt` PASS (runtime/conformance/check-relay-reconnect.mjs)
The same plan as the pre-U7 run, now through the U7 relay:
- **A:** attach; the row (tier pvm-cpu from the boot self-test, NOT eligible under U7); the bootstrap route through the
  carve-out; register; claim; `/x` through the carrier's own resolver; a proof; the client served as bound.
- **R1:** three relay drops, each re-attached in place by the running VM 3-16 s after the relay returned; the client
  served and a proof landed each time; one row with no tier.
- **R2:** a frozen relay; the phone's watchdog after 98 s; exactly one tunnel after the thaw.
- **R3:** down, wrong-operator and stale co-signatures refused in order, then the owner's accepted; the accepted attest
  frame replayed on a fresh connection refused on its challenge.
- **R4:** a request cut by a drop signed nothing (a due heartbeat went out: it needs no VM); the undelivered checkpoint
  (`0x01c8ff25…`) landed once across a drop and an in-place re-attach.
- **R5:** the old-build relay refused the in-place attach; the right relay accepted it; no tier, not eligible, not
  serving, `/v1/enclaves` 503.
- **D:** a final proof, then release.

The checker's accounting is exact:
- 12 REATTACHes = 8 accepted in place + 4 refused by the hub + 0 without a certificate;
- 10 owner co-signatures re-verify offline, each with the BOOT transport key;
- statements and checkpoints re-verify;
- every attestation chain hangs off one provisioned AVF key.

**What the regression adds over the pre-U7 run.** The pVM runner's whole lifecycle works unchanged through the U7 relay:
- the pVM path is the narrow carve-out (exact raw path, POST only, no query, the carrier's own resolver, sandboxed
  answers);
- the phone row is never eligible, so U7 refuses it every tenant path, which test/pvm-u7-integration.test.mjs shows on
  this same revision.

**Not shown:**
- nothing on Base or the production relay;
- not a Pixel 11, and not several app VMs at once;
- not a merge to main: enclave-99 notes the branch carries the whole pVM lane's tree beyond U7, and landing any of it is a
  separate decision with its own deploy audit.
