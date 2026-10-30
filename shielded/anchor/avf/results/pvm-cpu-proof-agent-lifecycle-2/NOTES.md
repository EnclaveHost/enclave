# The runner lifecycle agent on the Pixel 10, run 2 (2026-09-25 08:38Z-08:50:45Z): the agent at 5d2d115d

**Not production.** This is the same device check as run 1 (results/pvm-cpu-proof-agent-lifecycle), with the same
chain, phone, build and rules.
- **The chain:** a LOCAL anvil chain mining a block every 2 s, with the real contracts. The lease clock was moved with
  `evm_increaseTime`, and the VM's 60 s signing gap was waited out in real time.
- **The operator** was a fresh random key held in memory only, found nowhere in the results by the run's own scan. The
  registration values and the payout address were synthetic lab values.
- **The phone:** the installed proof-key build (APK `113ca8f8…`, code `fe734cb8…`). App data was kept, and the app was
  stopped at the end.
- **The code exercised:** before starting, the harness confirmed that `runner/` and `relay/` equal the committed
  **5d2d115d**. That revision includes 20054bab (the registered measurement is the fresh statement's `codeHash`), which
  enclave-99 accepted and pinned, plus earnings withdrawal.

## Steps (all as expected)

- **The owner's steps, by the agent:**
  - start: it attested the key the VM logged, `0xa91a5300…`;
  - register: exactly the attested key, and **the measurement is exactly the attested build `0xfe734cb8…`**;
  - claim.
- **Proving and renewing:**
  - prove-1;
  - a heartbeat when due;
  - a renew inside the margin with a recent proof;
  - three approach steps: proofs, with a heartbeat when due, and no renew.
- **The interruption:**
  - renew-interrupted: the renew was journaled, never delivered, and the agent stopped;
  - renew-recovered: the restarted agent delivered the SAME bytes once. The tenant's balance fell 99697600 →
    99546400, exactly that renew's burn;
  - after-renew: no second renew.
- **The end:**
  - release: a final proof, then release;
  - payout: an agent with the owner's payout config (claiming off) withdrew **all 220698 earned** to the payout address,
    once.

## Result: `check.txt` PASS (runtime/conformance/check-runner-agent.mjs)

It checks everything run 1's checker did (the carrier one to one, statements and checkpoints re-verified, every
transaction decoded against its intent, and the chain's events reconciled with the journal both ways), plus two new
checks:
- every `Updated` event's measurement is `"0x"` plus the run's pinned build;
- exactly one `EarningsWithdrawn`: from the operator to the owner's payout address, for all earned, which leaves
  `earned6` at 0.

test/pvm-runner-agent-checker.test.mjs mutates this run 15 ways, and each must fail at its check (16/16 including the
unmutated PASS).

## What this is not

- It is not production: no Base transaction, and no real key, entry, lease, price or payout address.
- It does not use the relay route: the carrier was the lab hub.
- It covers one phone and one VM (Pixel 10). A Pixel 11, and several app VMs at once, are not validated.
