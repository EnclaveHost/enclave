# The lease proof key on the Pixel 10: a device check against the real contracts on a local chain (2026-09-24 21:02:08Z-21:07:08Z)

**Not production.** This is the device check of PROOF-KEY.md, run through cpu/proof-key-run.mjs. The chain is a LOCAL
anvil chain: the real EnclaveRegistry, EnclaveDeployments and EnclaveProofOfTime, compiled with the repo's solc-js at the
production settings, with a mock USDC. There was no network, no funds and nothing public. It was directed in this
session. The isolation owner (enclave-5d) cleared the phone and the ports first. Times are UTC.

## What ran

- **Build.** The APK `113ca8f8…`, code hash `fe734cb8…`. The payload carries PROOFPINS, PROOFKEY and CHECKPOINT; pvm-rt
  carries the typed ProofOfTime signer, `src/proof.rs`, which matches viem byte for byte.
- **The lease** (run.json).
  - The tenant created and funded deployment `0x0999ac32…`.
  - The runner id is keccak256 of `https://api.enclave.host/t/pixel10-pvm-cpu` = `0xc6a1c08a…`.
  - The operator is a SEPARATE anvil account `0x70997970…`: the gas wallet for register and claim.
  - The VM was launched with pins for exactly this lease.

## Result: `check.txt` PASS

The VM captures (`vm/*.log`) had trailing blanks on two diagnostic lines, which were stripped for the repository's
whitespace gate. `check.txt` was produced after that.

Coverage comes from the run's own records. The 8 planned calls are each in calls.jsonl once, in order, and each is the
carrier's recorded exchange with the same request and answer.
- **Statement A.** The VM's own PROOFKEY statement re-verifies with the canonical `verifyPvmProofKey`: a real v3 envelope
  under Google's roots, over its own nonce, for this build, this deployment and the VM's logged instance
  `ccd79db1…`. It attests the proof key the VM logged: **`0xa91a53000dcdcc3dd40e18b21023b4bdc0f3b0fc`**.
- **Registration.** The operator registered exactly that attested key under the runner id, and claimed the lease.
- **Checkpoints A1 and A2.** Signed by the device, re-verified offline by `verifyPvmCheckpoint`, and **ACCEPTED by the
  real EnclaveProofOfTime**: provenUntil went 1790283839 → 1790284139 → 1790284509.
- **Refusals.**
  - The same checkpoint posted again: REFUSED by the chain ("nothing to prove").
  - The VM's own refusals, in its words: "at most one checkpoint every 60 s", "request is CHECKPOINT …" (malformed),
    and "upto must strictly increase".
- **Restart.** The same pins and a new boot, with another transport key. The VM logged and attested the SAME proof key,
  and checkpoint B1 was ACCEPTED: provenUntil → 1790284924.
- **No private key** anywhere in the results. The proof key's private half exists only in the VM process.

**Tests of the checker.** test/pvm-proof-key-checker.test.mjs mutates a copy of this run 13 ways, and each must FAIL at
the check that covers it:
- a deleted exchange, a removed call and a duplicated call;
- swapped answers;
- a forged statement key and a forged checkpoint signature, both copies edited consistently;
- a removed chain outcome, a checkpoint recorded as refused, and another registered key;
- a replay recorded as accepted;
- a changed restart key;
- a refusal replaced by a signature;
- the missing call record.
The unmutated copy must PASS.

## Attempt 1, kept as it is (results/pvm-cpu-proof-key-attempt1)

Attempt 1 stopped at its first checkpoint. The device signed it, and the checkpoint re-verified offline (the attested
key, the right pins). But the transaction posted to the local chain was mined and REVERTED, and the harness recorded
only "checkpoint reverted".
- **What the harness did then.** It posted with viem's default gas estimate, and simulated only after the fact.
- **What it does now.** It simulates FIRST, which returns the contract's own reason, and posts with an explicit gas limit.
  With that change all 3 device checkpoints of this run were accepted.
- **The cause is NOT established.** The production supervisor also posts with the default estimate, and its proofs
  land on Base (per the Linux isolation owner). The one revert was local and not reproduced.
- **For the phone's posting agent:** simulate, then post with a gas margin.

## Not shown

- A public chain, real funds or a real registry entry. The chain id, addresses and lease are the local chain's
  (run.json).
- The owner-side posting agent that would run these steps on Base: it is not built.
- Re-provisioning (a new instance gets a new proof key): it wipes the lab app's data.
- The lease's value to anyone: a checkpoint is the VM's own account of running and serving, not reachability
  (PROOF-KEY.md).
