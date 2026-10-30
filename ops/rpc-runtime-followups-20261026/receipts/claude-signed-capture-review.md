# Review: KVM `signed-payload-capture-stage/r1` (read-only)

**Stage:** `/home/steven/Documents/Codex/2026-10-23/it/work/signed-payload-capture-stage/r1`. SHA256SUMS is **73e43b1d…** and verified clean.

**Dependencies:** `enclave-deployment-lifecycle/network/op-head-relay.mjs` (ed71c069) and `rpc-identity.mjs` (5c5a4335). Both match `INPUTS.json`.

**Scope:** `capture.mjs`, `evaluate.mjs`, and the dependencies they use for positive mainnet usability, trust, pinned inputs, authority, command execution and path leakage.

**Not done:** no tests, queue jobs, live access, edits or commits.

**Root 1310's 6/6 PASS** is a synthetic-envelope refusal path only. As `PROTOCOL.txt:84` says itself, it is not proof.

## Findings (prioritized; concrete defects only)

### H1. The pinned native 581d is a **debug** build, under hard 60 s CPU / 90 s wall / 2 GiB bounds. Real positive mainnet execution is likely unusable.
- **Where:**
  - `test.sh:12`: `…/target/debug/examples/signed_payload_candidate`.
  - `evaluate.mjs:5`: `PIN=581d…`.
  - `evaluate.mjs:33`: `prlimit --as=2147483648 --cpu=60`.
  - `evaluate.mjs:38`: `setTimeout(stop,90000)`.
- **The risk:** a full Base mainnet block (hundreds of transactions; revm plus trie work over the witness) in an unoptimized debug profile is likely to exceed 60 s CPU. The synthetic test passes because it refuses early, at the fabricated header. **Not measured.** This is a risk to positive usability, not an observed failure.
- **Remediation:**
  - Build the same candidate source and lock with the **release** profile.
  - Pin that sha in `evaluate.mjs` `PIN` and in `INPUTS.json`.
  - Measure CPU, RSS and wall time for one real block under the shared guard before fixing the bounds.
  - Keep the bounds explicit; do not raise them implicitly.

### H2. Capture loads its signature/parse dependencies from a mutable sibling worktree at runtime, with no pin check.
- **Where:**
  - `capture.mjs:8`: `import … from '../../enclave-deployment-lifecycle/network/op-head-relay.mjs'`.
  - `capture.mjs:9-10`: `createRequire(…/enclave-deployment-lifecycle/package.json)` → `viem`.
  - `op-head-relay.mjs:21-22`: imports `viem` and `./rpc-identity.mjs`.
- **The gap:** `INPUTS.json:3-7` pins are checked only by `test.sh:5-11`, not when `capture.mjs` runs online. The `viem` installed tree (`node_modules`) is not pinned at all; only `package-lock.json` is.
- **Consequence:** the KVM worktree changes over time, so a later capture can run different signature-recovery and parsing code than root qualified.
- **Mitigation already present:** native re-verifies the signature and executes, so this is not an authority bypass. It is an evidence-provenance and reproducibility defect.
- **Remediation:** before any network call, `capture.mjs` should either:
  - verify the sha256 of `op-head-relay.mjs`, `rpc-identity.mjs`, `package-lock.json` and a recorded tree sha of `node_modules/viem` (plus its `@noble/*` closure); or
  - vendor those files into the stage under SUMS and import them by stage-relative path.

  Refuse on mismatch.

### M1. The unsafe signer is taken from the plan, with no pin.
- **Where:**
  - `capture.mjs:146`: context fields include `unsafeSigner`.
  - `capture.mjs:154`: `signedInput(commitment, c.unsafeSigner)`.
  - `op-head-relay.mjs:102`: compares against whatever `signer` is passed.
- **The gap:** the relay already exports the reviewed pin `BASE_MAINNET.unsafeSigner = 0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a` (`op-head-relay.mjs:26`). Capture accepts any plan-supplied signer, and the same value flows into `context.json` for native.
- **Remediation:** refuse unless `c.unsafeSigner === BASE_MAINNET.unsafeSigner`, until the documented L1-verified signer policy exists (`INTEGRATION.txt:5`, "signer policy/version"). That later policy is pending design, not this finding.

### M2. Static reviewed pins for config and schedule are not enforced at capture.
- **Where:** `capture.mjs:148-153`. These lines check only that `expectedRollupConfigHash` and `expectedScheduleId` are 32-byte words, and that `rollupConfig` is an object.
- **The reviewed values exist today:** KVM `network/derived-reader/qualification.json` has `native.rollupConfigHash = 0x1607709d…3c57` and `schedule.id = 0x3d6185fc…c896`.
- **Remediation:**
  - Refuse unless both equal the reviewed pins.
  - Record the sha of the canonical `rollupConfig` in CAPTURE.json.
  - In `evaluate.mjs`, require the native result to echo the same config hash and schedule id.
  - If native r2 already enforces them, cite the native line in PROTOCOL and keep the capture check as an early refusal.
- **Not covered by this finding:** L1 head, agreed root and the parent's qualification remain documented caller obligations.

### M3. `evaluate.mjs` executes `prlimit` through the caller's `PATH`.
- **Where:** `evaluate.mjs:33` `spawn('prlimit', …)` and `evaluate.mjs:35` `env:{PATH:process.env.PATH, …}`.
- **The risk:** a hostile or accidental `PATH` substitutes the resource limiter, and with it the bounds.
- **Remediation:** `spawn('/usr/bin/prlimit', …)` with `env:{PATH:'/usr/bin:/bin', LANG:'C'}`. Optionally record `prlimit --version` and its sha in EVALUATION.json.

### M4. Captured evidence lacks the provenance PROTOCOL requires.
- **Required by:** `PROTOCOL.txt:89`, "Retain all source/capture/binary/result pins".
- **Where:** `capture.mjs:175-181` (receipt) and `capture.mjs:201` (only output-file shas).
- **Missing from CAPTURE.json:**
  - sha256 of `capture.mjs` and its dependencies (H2);
  - sha256 of the input plan, commitment and bootstrap-witness bytes;
  - the exact endpoint origin;
  - `capturedAt` (start and finish);
  - Node version.
- **Remediation:** add these fields. `evaluate.mjs:51-53` should copy them into EVALUATION.json.

### L1. `evaluate.mjs` assumes offline but never checks.
- **The gap:** PROTOCOL (`:78`) requires a new network namespace.
- **Remediation:** refuse when a non-loopback route exists, using the same check as root's jobs.

### L2. Staging and log handling in `evaluate.mjs`.
- `evaluate.mjs:28-29` stages an executable copy and full input copies inside the capture evidence directory. That fails on `noexec` mounts, and every run leaves up to 128 MiB of witness copies behind. Use a private tmp outside the evidence dir, and keep only logs and results there.
- `evaluate.mjs:40` kills native when stderr exceeds 64 KiB. A verbose refusal then becomes a SIGKILL and loses its tail. Truncate the stored stderr (head + tail) instead of killing.

### L3. Early refusals and runtime notes in `capture.mjs`.
- `capture.mjs:64` builds advisory attributes without `unsupportedTxType()` (`op-head-relay.mjs:79`). A 0x79/0x7D transaction then fails in the node or native instead of being refused clearly at capture. Add an early refusal.
- `capture.mjs:131` `AbortSignal.any` requires Node ≥20.3. That is fine on host Node 22, but it throws on guest Node 18. Document the runtime, or replace it with a manual combined controller.

### L4. Path leakage and relocatability.
- `INPUTS.json:4-6`, `test.sh:3,12` and the `../../` imports tie the tool to the workstation layout under `/home/steven/...`.
- That is acceptable for root's offline test. A deployable capture needs a relocatable, sha-manifested bundle, as done for `historical-capture-deployment-stage`.

### L5. Prototype bounds versus real Base witnesses.
- **Bounds:** 24 MiB raw preimages and 150 000 entries (`capture.mjs:98`). The 64 MiB execution response (`:160`) is shared with the seed bootstrap.
- **Risk:** a real Base block witness plus the L1/BootInfo seed may exceed these.
- PROTOCOL already says that this is availability, not truncation (`:69`). **Measure on one real block before positive qualification.**

## Checked and correct (no change needed)
- **Signature parity:** `capture.mjs:70` `Number(yParity)` is safe. `normalizeCommitment` (`op-head-relay.mjs:89-93`) maps `v` 27/28, hex or number to `yParity` 0x0/0x1.
- **V4 SSZ offsets** (`capture.mjs:60-72`) match ExecutionPayload V3 + withdrawalsRoot. The values are feeRecipient 32, stateRoot 52, prevRandao 372, gasLimit 412, timestamp 428, extraData 436, blockHash 472, txs 504, withdrawals 508, withdrawalsRoot 528, fixed size 560. The OutputRootV0 is `keccak(0^32 ‖ stateRoot ‖ withdrawalsRoot ‖ blockHash)`.
- **extraData:** Holocene (version 0, 9 bytes) and Jovian (version 1, 17 bytes, with `minBaseFee`).
- **Parent binding** (`:155-156`): the signed head must extend the caller's parent at `parentNumber + 1`. The claimed number and output root must equal the signed payload's.
- **Ancestor walk** (`:168-173`): 256 headers (parent…parent−255), which is exactly the BLOCKHASH window. That makes 257 calls, within `MAX_CALLS` 258. Each header is checked for keccak = expected hash, height and canonical RLP.
- **Preimages** (`:83-99`): the 31-byte digest tail is checked for Keccak256 and Sha256. Local keys are stripped; other key types and conflicting duplicates are refused.
- **RPC** (`:126-140`): only two methods; loopback/RFC1918 IP literals only; no credentials, path, query or redirect. Per-request and aggregate byte budgets; id and jsonrpc checked; 15 s per request and 120 s overall.
- **Outputs:** `wx` and 0600. FAILED.txt is written on error, and a CAPTURE receipt is never written after a failure. Receipts say `authority:false`.
- **EVALUATION** (`:48-53`) binds native hash, parent, outputRoot and a single-block coverage. Every qualification flag is false.
- **The owned access path exists:** the r14 witness bridge allowlists `debug_executePayload` and `debug_getRawHeader` (`base-finality-proof-stage/r14-witness/witness/witness_rpc_bridge.py:21`), so no public endpoint is needed.

## Documented pending, not counted as defects
These items are already documented as pending; a concrete defect that overlaps one is cross-referenced by its finding ID.
- **Caller qualification:** the qualified parent, L1 head, agreed root, branch selection and epoch fencing (`INTEGRATION.txt:1-8`; PROTOCOL `:31-36`).
- **Unsafe signer:** the L1-verified signer policy (M1 covers only the static pin).
- **Bootstrap:** complete BootInfo/L1 seed collection, with no safe automatic `debug_dbGet` (PROTOCOL `:100-105`).
- **Image:** accepted SNP image qualification.
- **Preserved, no conflict:** accepted administrators/admin controls (`INTEGRATION.txt:7`) and the 120 s snapshot freshness (`INTEGRATION.txt:5`). r1 neither weakens nor implements either.

## Recommended minimal order for KVM
1. **H2 + M4:** pin and record provenance.
2. **M1 + M2:** static pins.
3. **M3:** absolute `prlimit`.
4. **H1:** a release build plus one measured real-block run under root's guard.
5. **L1–L5** as convenient.

**None of these makes the stage an authority.** Positive qualification still needs real execution compared against an independent node, plus the mutation refusals (PROTOCOL `:88-94`).
