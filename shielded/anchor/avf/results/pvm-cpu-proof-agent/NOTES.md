# The posting agent on the Pixel 10: a device check against the real contracts on a local chain (2026-09-25 07:06:37Z-07:18:17Z)

**Not production.** This is the device check of the owner-side posting agent (runner/proof-agent.mjs; PROOF-KEY.md "The
posting agent"), run through cpu/proof-agent-run.mjs. Times are UTC.
- **The chain** was a LOCAL anvil chain mining a block every 2 s, like Base. It ran the real EnclaveRegistry,
  EnclaveDeployments, EnclaveProofOfTime and EnclaveAddressBook, compiled with the repo's solc-js at the production
  settings, with a mock USDC. There was no network, no funds and nothing public.
- **The operator** was a fresh random key made for this run and held only in memory. The run scanned every result file
  for it and found it nowhere.
- **The phone:** enclave-5d cleared it first. The already-installed proof-key build was used, APK `113ca8f8…`, code hash
  `fe734cb8…`, with no reinstall. App data was kept, and the script stopped the lab app at the end.

## What ran

- **The VM signs; the agent does everything else.** For each proof the agent:
  - reads the lease;
  - picks the anchor, the parent of the newest block;
  - asks the VM through the real hub and web carrier (with a recording proxy in front, which can turn hostile);
  - verifies the answer against the attested key and its own request;
  - simulates it;
  - signs the transaction locally and journals it;
  - sends it, then follows it to a confirmed (2 blocks), still-canonical receipt.
- **The lease.** The tenant created and funded deployment `0x0999ac32…`. The runner id is keccak256 of
  `https://api.enclave.host/t/pixel10-pvm-cpu`, which is `0xc6a1c08a…`. Before its first proof, the owner's steps (not the
  agent's) registered exactly the key the agent had attested and claimed the lease.
- **Both boots** logged the same instance and proof key as the 09-24 runs: instance `ccd79db1…`, proof key
  **`0xa91a5300…`**.

## Result: `check.txt` PASS (runtime/conformance/check-proof-agent.mjs, from the run's own records)

| # | step | outcome | what it shows |
|---|---|---|---|
| 1 | start-a | attested | The contracts resolved through the address book, and their frozen bindings were cross-checked. The VM's statement re-verified under Google's roots over the agent's own nonce. |
| 2 | unclaimed | not-our-lease | Before the lease was the runner's, the VM was NOT asked for a proof. |
| 3 | a1 | landed | Nonce 2, block 85; provenUntil 1790320117. |
| 4 | replay | checkpoint-refused | The carrier handed back the previous, genuinely signed answer (1790320117, block 83) for a request of (1790320183, block 116). It was refused before any chain saw it. |
| 5 | replace | landed | Block production was paused, so the send did not mine. The agent replaced it at nonce 3, bidding 25 % more. Exactly one mined (block 149). |
| 6 | reorg | landed | After the agent had seen the receipt, block 182 holding it was reorganized away. The agent recorded the reorganization and rebroadcast the SAME bytes, which landed in block 184. |
| 7 | crash | stuck | An agent whose sends never reach the chain was stopped with nonce 5 in flight. |
| 8 | recover | landed | The next agent, from the same journal, rebroadcast the same bytes. They landed (block 221) without asking the VM for any new proof. |
| 9 | stuck | stuck | Sends that never reach the chain (the original plus 3 replacements) outlived their anchor (21 blocks, with the run's limit at 20). |
| 10 | fresh | landed | The next tick asked the VM for a FRESH proof and put it in the SAME nonce 6, outbidding the stuck transactions (block 310). |
| 11 | start-b | attested | After the VM restart, the same proof key was vouched for by the new boot's transport key. |
| 12 | b1 | landed | Nonce 7, block 367; provenUntil 1790320677. |

**Records.** Every exchange the agent made is the hub's recorded exchange with the VM, one to one (12 of 12). The only
exception is the swapped answer, which is byte-equal to an earlier genuine one.
- Every accepted checkpoint re-verifies (7 of 7).
- Every journaled transaction is keccak256 of its bytes, signed by the operator at its nonce, carrying exactly its
  checkpoint (11 of 11).
- The landings are exactly the plan's 6. Each has a successful canonical receipt with the Checkpointed event, and
  provenUntil strictly increases. No other Checkpointed event is on chain.

**Tests of the checker.** test/pvm-proof-agent-checker.test.mjs mutates a copy of this run 15 ways, and each must FAIL at
the check that covers it:
- a removed or changed step;
- a deleted or differing exchange;
- the replay not recorded;
- a forged statement key, and a forged checkpoint signature (both copies);
- swapped transaction bytes;
- a reverted landing, and an unrecorded Checkpointed event;
- a removed reorganization or recovery;
- a stuck transaction recorded as mined;
- a changed restart key;
- a missing key scan.
The unmutated copy must PASS: 16 of 16.

## Run 1, kept as it is (results/pvm-cpu-proof-agent-run1)

Its checker FAILS at the reorg step.
- **What happened.** The harness's hook reorganized the proof's block away BEFORE the agent's first receipt poll. The
  agent therefore saw a send that never mined, and correctly replaced it at the same nonce. That proof landed.
- **Why it fails.** That is not the confirmation-wait path the step exists for.
- **The fix, in the harness only.** The hook now waits until the agent's own receipt read returned the receipt.

## What this is not

- It is not production. Nothing was posted to Base, and no real operator key, registry entry or lease was touched.
- The carrier was the lab hub. A production agent needs the owner's route to the VM's evidence port: the relay's
  `/x/<id>/pvm/evidence` with `PVM_SERVING` set, or the owner's own.
- PROOF-KEY.md "Exactly what production still needs" lists the inputs only the owner has.
- It is one phone and one VM (Pixel 10). A Pixel 11, and several app VMs at once, are not validated.
