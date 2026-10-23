# Custody code admission: original committee vs new committee (worker R, 2026-10-23)

**Status: source-only preparation, as root's `ROOT-CODE-ADMISSION-PLAN.txt` asked.**
- Nothing was signed, voted, proposed or sent. No keys, hardware, endpoints or production state were touched.
- Every check ran through the unchanged queue at ≤ 512 MiB (`logs/`).
- The live reads were read-only `eth_call` / `getCode` / `getBlock` calls on two public RPCs.
- The dashboard and the site builds were not touched.

## Answer

**The corrected image cannot be admitted to the original committee `0x4774`, now or later, with the running custodian.**
- There is no code proposal to prepare and no seven-day clock to start.
- Any plan that shows "propose code on `0x4774`, wait 7 days, hand over" is not executable. The missing approval cannot be
  produced, and it must not be fabricated.

The only supported route to the corrected code is a NEW committee in the SAME original vault.
- It is not an upgrade of `0x4774`. It does not bypass `0x4774`'s code delay.
- Existing policies and bundles stay on `0x4774`, served by the untouched original custodian, until each owner moves
  their own deployment (§3).
- That route is itself blocked on metal0's owner enrollment. Enrollment needs operator gas, and there is no funding
  workaround (§2).

## 1. Why `0x4774` can never admit new code (exact sources, live state, contract test)

**Contract** (`contracts/EnclaveSecretVaultV2.sol`, git blob `7a385bbc`, unchanged from 9d43e63e8 to the dashboard
line).
- My test compiles it with the deployed settings and the production immutables. The runtime keccak equals production's
  `0x4b949b37…`. Every finding below is therefore about the deployed bytes; a mutant could not pass that check.
- `proposeCode(cid, m, approvers, approvals)` needs approval weight ≥ t, counted over distinct seats of the CURRENT epoch.
  Each approval is an EIP-191 signature over
  `codeDigest = keccak256(abi.encode("enclave-custody-v2 code", 8453, vault, cid, epoch, m, add))`.
- Results on anvil (chain id 8453, vault at `0xE486…`), from `tools/original-code-path.test.mjs`, 21/21 checks, peak
  169 MiB:

| case | result |
|---|---|
| no approvals | `Weight(0,1)` |
| a machine outside the epoch | `NotMachine()` |
| the member's handover signature, or a code approval for another epoch | `BadSignature()` |
| the member's signature over `codeDigest` | accepted, `activeAt = block.timestamp + 604800` exactly |

**Live state** (`tools/live-read.mjs`; block 53001067 `0x20850dfe…`, both RPCs agree):
- Code hash `0x4b949b37…`. `CODE_DELAY` 604800, `HANDOVER_TTL` 86400.
- `0x4774` is at epoch 1, t 1, W 1. Its only machine is `0xF0F8078459c051a89197fac73Ff689c6DF96506a` (Enclave seat), and no
  handover is pending.
- `codeActiveAt(2530eda0…)` = 1792017007 (genesis). `codeActiveAt(fbe2f581…)` = 0.
- `eth_call proposeCode` today: no approvals → `Weight(0,1)`. The live machine with a zero signature → `BadSignature()`.

**The only possible approver cannot sign it** (`tools/static-original.mjs`, `evidence/original-daemon-static.json`).
- I checked the running image's `/opt/custodian/custodian.mjs`: root's extraction, sha256 `7c2cd000…`, the
  manifest-verified running file. I also checked the 9d43e63e8 source (12 files, each equal to its git blob).
- It signs only the genesis, deal and ack digests, plus the handover digest (in `approve` / `coordinate`).
- It contains no `"enclave-custody-v2 code"` string, no `approveCode` and no `/v2/custody/code-approve` route.
- The source exports `codeDigest`, but nothing calls it; the bundler dropped it.
- The identity key exists only inside that image, sealed to its measurement.

**A handover cannot route around it.**
- `proposeHandover` and the final `ackHandover` refuse any machine whose code is not already active (test: `BadCode()`).
- So `0x4774` can only ever gain more `2530eda0` machines, and those cannot sign code approvals either. Its code set
  `{2530eda0}` is permanent.

One correction to an assumption I had to check: the original daemon's peer check (`allowedMeasurements:
[p.measurement]`) uses the CANDIDATE's own report and then requires that code to be active on chain. If the code ever were
active, the old daemon would accept such a peer. The approval signature is the one and only blocker.

**Reference only, not submittable** (`evidence/code-admission-plan.json` §A):
- `codeDigest` (add) for `0x4774` / epoch 1 / `fbe2f581…` = `0xa39fd1d7f9dd47c7d53ddd34a97fcf652b14123e2225f2abbdf72d0a7f7f4b64`.
- Its EIP-191 hash is `0x0a74a7fe…`.
- The calldata with empty approvals is included. A valid call would need a signature by `0xF0F8…` that no code can
  produce.

## 2. The supported route: a new committee in the original vault (root/human prerequisites)

It uses the corrected custodian: source `ab589bf8`, release package `23f7e51`, SNP measurement `70aadff5…`, vault
measurement field `fbe2f581…` (sha256 checked in the test).
- Its genesis code set is `[fbe2f581]`, active at the genesis block **for that committee only**.
- Facts already proven: genuine SNP startup, startup on 503, and reopen. The **full secret lifecycle is NOT done.**

**Blocked prerequisites (exact; none can be fabricated):**
1. **Owner enrollment of metal0.** The corrected host side refuses an unowned host, and code permits for the Enclave seat
   need the accepted owner.
   - TX1 `proposeOwner` is signed by operator `0xc9d0…e6ab`. Its balance is 376 132 087 579 wei, against an upper bound of
     1 038 286 650 790 wei (`custody-v2-live/evidence/operator-fees-confirmed.json`), so it is **blocked**. No funding
     workaround is allowed.
   - TX2 `acceptOwner` is signed by admin `0x0b2d…ee61` (human).
2. A public HTTPS origin and direct ingress for the canary custodian. The relay tunnel cannot carry a direct image.
3. A funded host submitter. The upper bound for `createCommittee` is 6.544e12 wei at block 53001067.

**Steps after those** (§B of the plan):
- The operator signs the host binding off-chain.
- The new machine signs genesis inside its TEE, and the submitter sends `createCommittee`.
- Then the **full lifecycle canary** runs on a dedicated deployment and EOA: save, release, rotate, pause, migrate,
  restart.

The admin book entries (`secretVaultV2`, `sessionVaultFactory`) are separate and stay gated. The factory page (39672)
still awaits the human.

## 3. Existing deployments and the original service

**Nothing in either route touches the original service:**
- committee `0x4774`;
- its machine `0xF0F8…`;
- the `c866…` image;
- its sealed state;
- the relay tunnel `/t/custody-metal0`.

**Existing policies stay on `0x4774`.**
- The vault's policy names its committee; only the policy OWNER can switch it, with an `update` carrying a bundle
  encrypted to the new committee.
- The known policy is canary `0x4e62…` (EOA `0x2947…`). The exhaustive scan is still incomplete.

**Per-owner options:**
- Re-enter the values to the new committee, or
- run the existing owner-authorized rewrap (`custody/v2/rewrap.mjs`, image `f01a7166`). The owner signs three things:
  1. a rules update admitting the rewrap image;
  2. an EIP-712 Rewrap authorization (≤ 3 days);
  3. the final switch update.

  The old custodian serves the rewrap guest through its normal release path. This path is proven only on anvil with
  synthetic attestation, not on hardware.

**Availability-only option (root decision; it does not change code).** The original coordinator can hand over to a
fresh-identity `2530eda0` machine that joins.
- An Enclave-paid machine is still one seat.
- This improves availability, not the corrected owner/admin checks.

## 4. Future code changes (only on a committee running the corrected code)

This is the real seven-day path, with the corrected source's CLI. It applies to the §2 committee once it exists.
1. `node scripts/independent-custody.mjs code-permit --chain-id 8453 --vault 0xe486… --committee <new> --measurement <next> --add --expires-in <≤2592000> --rpcs R1,R2 --out code.json`
2. The **admin `0x0b2d` signs** the permit digest. It is valid only while `0x0b2d` is the host's accepted owner.
3. `… code --request code.json --permits permits.json --rpcs R1,R2 --out tx.json`. The machine signs `codeDigest` inside
   its TEE, at `/v2/custody/code-approve`.
4. Any funded submitter sends `proposeCode` (≈ 1.24e12 wei upper bound). **The clock starts at that block:**
   `activeAt = ts + 604800`.
5. After `activeAt`, the candidate POSTs `/join`, and the coordinator proposes the handover. Upper-bound costs:
   - `proposeHandover` ≈ 7.35e12 wei;
   - `postDeal` ≈ 5.50e12 wei;
   - each `ackHandover` ≈ 2.28e12 wei.

**Expiry, cancel and rollback** (all tested on the original bytes):
- A code proposal does NOT expire.
- A handover at `activeAt − 1` reverts; at `activeAt` it succeeds.
- `removeCode` needs the same approval weight and takes effect immediately. It also stops the final ack of a pending
  handover to that code, so the committee stays at its epoch and the old machines keep serving.
- Removal burns the add digest for that epoch: the same measurement **cannot be re-proposed until an epoch change**.
- A pending handover expires after 1 day and can then be replaced.

**Why not propose before the full canary:**
- Starting the clock early gains nothing: the delay runs from the proposal block anyway.
- An unreviewed measurement, once proposed, can only be removed. That removal blocks re-adding it for the rest of the
  epoch.
- So the safe order is: full lifecycle canary on the exact next measurement → fresh two-RPC read (`codeActiveAt` = 0,
  nothing pending) → a short permit → re-simulate `tx.json` at an agreed block → submit → check that the `CodeProposed`
  `activeAt` equals block ts + 604800.

**Costs.** Base fee was 5 000 000 wei at the agreed block. The cost figures are upper bounds:
- L2 cap = gas used × 1.25 × (2 × base fee + 0.001 gwei);
- plus the oracle's L1 upper bound;
- the operator fee is 0.

Gas was measured on the original bytes, with stand-in book and registry contracts.

## 5. Files
- **`orig-9d43/`:** git archive of 9d43e63e8 (the vault, `custody/v2`, the spec and tests), read-only.
- **`tools/`:**
  - `compile.mjs` (solc 0.8.35, viaIR, 200 runs; peak 295 MiB);
  - `original-code-path.test.mjs`;
  - `live-read.mjs`;
  - `static-original.mjs`;
  - `q.sh` (the unchanged queue).
- **`evidence/`:**
  - `original-code-path.json`;
  - `live-code-state.json`;
  - `original-daemon-static.json`;
  - `code-admission-plan.json` (sections A/B/C).
- **`logs/`:** `compile1`, `codepath1`, `liveread1`, `static1`/`static2`.
