# The runner lifecycle agent on the Pixel 10: a device check against the real contracts on a local chain (2026-09-25 08:06:12Z-08:18:37Z)

**Not production.** This is the device check of the runner LIFECYCLE agent (runner/runner-agent.mjs; RUNNER-AGENT.md),
run through cpu/runner-agent-run.mjs. Times are UTC. (The directory name is inside the scan allowlist that already covers
the posting agent's runs, whose engine this agent uses.)
- **The chain** was a LOCAL anvil chain mining a block every 2 s. It ran the real EnclaveRegistry, EnclaveDeployments,
  EnclaveProofOfTime and EnclaveAddressBook, with a mock USDC. There was no network, no funds and nothing public.
- **Lease time.** The lease's clock (a 1800 s quantum, a 900 s heartbeat) was moved forward with `evm_increaseTime`. The
  VM's own 60 s signing gap was waited out in real time.
- **The operator** was a fresh random key held in memory only, found nowhere in the results by the run's own scan. The
  registration values were synthetic: repo `lab/pvm-runner-device`, the build's code hash as measurement, a lab price.
  No production value was used or invented.
- **The phone:** the already-installed proof-key build, APK `113ca8f8…`, code `fe734cb8…`. App data was kept, and the
  script stopped the lab app at the end. No other phone plans existed (enclave-5d had cleared the earlier window, and
  the Pixel lane is this session's).
- **The agent code the run exercised was cd939a7a,** as committed when the run started (Node loaded the modules then).
  The later edits on this branch are not in this run: `codeHash` in the verifier's claims, and `register` publishing
  exactly the attested build. They are covered by the local suites.

## What ran: nothing pre-registered, nothing pre-claimed. The agent did every owner step

| step | the agent's lifecycle transaction | the proof | lease left after |
|---|---|---|---|
| start | (attested `0xa91a5300…`, the key the VM logged) | | |
| register | register, with exactly the attested key | not asked: not the runner's lease yet | |
| claim | claim | landed | 1794 s |
| prove-1 | none due | landed | 1428 s |
| heartbeat | heartbeat (due) | landed | 895 s |
| renew | renew, inside the margin, with a recent proof | landed | 2352 s |
| approach-0..2 | a heartbeat when due, no renew | landed ×3 | 652 s |
| renew-interrupted | renew journaled, **never delivered**; the agent stopped | | 554 s |
| renew-recovered | the restarted agent delivered the SAME bytes once; the tenant's balance fell 99697600 → 99546400, exactly that renew's burn (151200) | not asked | |
| after-renew | none: no second renew | landed | 2284 s |
| release | final proof, then release | landed (final) | released |

## Result: `check.txt` PASS (runtime/conformance/check-runner-agent.mjs, from the run's own records)

- **Exchanges.** The agent's 13 exchanges are the hub's 13, one to one. All 4 statements re-verify over their own
  nonces.
- **Proofs and transactions.**
  - 9 accepted checkpoints re-verify, each answering exactly its request.
  - 17 transactions are each keccak256 of their journaled bytes, sent from the operator at their nonce, and carry
    exactly their intent or checkpoint.
- **The chain's own events, reconciled with the journal both ways** (17 events, 17 landings):
  - the one ProofKeySet names the attested key;
  - one Registered and one Claimed;
  - exactly two Renewed;
  - three Heartbeats;
  - one Released, mined after the last Checkpointed.
  The ledger row ends released.
- **The checker's own coverage.** test/pvm-runner-agent-checker.test.mjs mutates a copy of this run 13 ways, and each
  must fail at its check (14/14 with the unmutated PASS).

## What this is not

- It is not production. No Base transaction was sent, and no real key, registry entry, lease or price was used.
- It does not use the relay route. The carrier was the lab hub; production needs the owner's route (RUNNER-AGENT.md,
  PROOF-KEY.md).
- It covers one phone and one VM, the Pixel 10. A Pixel 11, and several app VMs at once, are not validated.
