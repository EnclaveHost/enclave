# Custody v2 durability: persist-before-ack barrier (RESULT, 2026-10-23)

**Status.** A source-only fix, frozen for root review.
- Not built into any image; not measured.
- No live custody, SNP, SSH, network, signing, contract or install action.
- The audit (`custody-v2-rollout-audit-20261023` @ 8df7139) and release `custody-release/repo-b` are untouched.
- This fix changes the custodian's sources, so a FUTURE image has a new measurement and goes through root's build,
  quote and canary steps.

## 1. Source

- **Repo:** `repo/`, a shared clone of `custody-release/repo-b` at the quote-tested candidate
  `c635fd68515b46c53935ef344e3b4c4779d8067c`. Branch `custody/durability`, author and committer SteveDeFacto, the repo's
  `.githooks` pre-commit (crypto-key scan) active.

| commit | what |
|---|---|
| `ed0c536d` | extraction only: the daemon's `saveNow`, chain checkpoint, member and host-policy stores move verbatim to `custody/v2/sealed-state.mjs` (same fire-and-forget semantics), so the exact persist path is testable |
| `415483ff9784c38a88b273363a7efd0c227b95ce` | the barrier, handover retry safety, and `test/custody-v2-persist-barrier.test.mjs` |

- **Patch:** `custody-v2-durability.patch` (`git format-patch c635fd68..415483ff`), sha256
  `59c8245703e1814e1124c580bd27a76f2ac9f171dbd8bb54e1286a8fcacd1f17`.
- **Size:** 4 files, +331/−24. Non-test changes: `member.mjs` +52/−19, `sealed-state.mjs` (new, 18 lines),
  `daemon.mjs` (wiring only, +6/−5).
- **The image build:** bundles `custody/v2/daemon.mjs` (esbuild entry), so the new module is included without a file-list
  change.

## 2. The defect (root's F1, as on c635fd68)

- **The store discarded the write.** `daemon.mjs` 128:
  `store.save = (m) => { state.member = m; saveNow().catch(log); }` returned `undefined`.
- **The member never waited.**
  - `member.mjs` genesis: `putShares(...); save();` then signed and submitted `createCommittee` (115-119).
  - `handoverStep`: `putShares("pending", …); save(); // persisted BEFORE the ack` then `ackHandover` (444-447).
- **Effect:** the chain could count a share whose sealed write was still pending or had failed.
  - A failed write also left the share in memory; the daemon's `state.member` is the same object, so the NEXT unrelated
    write (e.g. a chain checkpoint) could persist it later.
  - A retry saw the in-memory pending share and returned "handover" without ever acking.

## 3. The fix

- **`sealed-state.mjs`:** `memberStore.save` RETURNS the write promise (logged and rethrown). `saveNow`'s serialized,
  whole-state-at-call-time write order is unchanged.
- **`member.mjs` `commit(change)`:**
  - Applies the change, then awaits `store.save`.
  - On failure it restores the in-memory state IN PLACE (`structuredClone` of the prior state, keys replaced on the same
    object) and throws `state not persisted: …`.
  - Commits run one at a time, so concurrent HTTP and engine paths cannot interleave a rollback with another change.
  - Changes are synchronous and never nest.
- **Every former `save()` is now an awaited `commit`:**

| site | durable before |
|---|---|
| `genesis` | `createCommittee` (epoch-1 share) |
| `handoverStep` | `ackHandover` (pending share) |
| `approve` | the approval signature leaves the machine |
| `adoptIndependentGenesis` | its result is returned |
| `tick` | promotion and erasure, then any deal or proposal |
| `setHostSig`, `join`, `coordinate` | the HTTP answer or the proposal |

- **Handover retry safety.** `st.pendingAcks[cid:epoch] = {nc, expires, acked}`.
  - A failed ack is re-sent from the SAME durable share.
  - A stale share from an earlier proposal for that epoch, with different new commitments, is durably replaced before the
    new ack.
  - An acked proposal is not re-acked.
  - A failed `acked` marker write only causes a duplicate ack, which the vault refuses (`BadAck`).
- **Unchanged:** the DKG/independent genesis service (`independent-runtime.mjs`) already awaits `persist: saveNow` before
  its phase responses. Its serialized snapshot ordering is preserved (test W1).
- **Platform host-policy store: inspected, deliberately unchanged.**
  - `network/platform-host-policy.mjs` `refresh()` sets `accepted` and its high-water in memory, then persists.
  - That is enforcement, not an acknowledgement to another party: a newly anchored policy (a BAN) must take effect at
    once, not wait for the disk.
  - A failed or late write only weakens the cross-restart anti-rollback high-water. The persisted record never admits
    anything by itself (persisted refusals are sticky; a persisted admit grants no cold-start grace, per the earlier
    review).
  - Making acceptance wait on durability would delay bans. No ack gap to fix there; the reason is documented in
    `sealed-state.mjs`.

## 4. Tests (all through `work/claude-test-queue.py`, unchanged queue, 256 MiB lane)

**`test/custody-v2-persist-barrier.test.mjs`** drives the REAL member (`createMember`) through the REAL writer
(`createSealedStateWriter`, the daemon's wiring), with:
- real share crypto (`protocol.mjs` genesis, deal, sealDeal, receiveHandover) and real signatures;
- a host disk the test holds, completes or fails;
- every submission recording what the host had durably at that moment.

| test | baseline (commit 1 `ed0c536d`, run `baseline-final`) | fix (`415483ff`, run `fixed-barrier-3`) |
|---|---|---|
| G1 no `createCommittee` while the share write is pending | FAIL: `write-start submit:createCommittee` | ok, and the share was durable at the submit |
| G2 rejected write: no submit, no share in memory, a later write cannot persist it | FAIL: genesis did not reject | ok |
| G3 a retry after a failed write waits again | FAIL | ok |
| H1 no `ackHandover` while the share write is pending | FAIL: `write-start submit:ackHandover` | ok, durable at the ack |
| H2 rejected write: no ack, no share in memory; the next tick persists, then acks once | FAIL: acked although the write failed | ok |
| H3 crash with the write pending: no ack left; the reopened member persists, then acks | FAIL: the ack left before durability | ok |
| H4 the ack fails after a durable write: re-sent from the SAME durable share; not re-acked once done | FAIL: never re-acked | ok |
| H5 a stale pending share (earlier proposal, 3-seat t=2 world) replaced durably before the new ack | FAIL: the new proposal never acked | ok |
| W1 serialized writes: a newer snapshot never replaced by an older one, even when the older write fails | ok (property preserved) | ok |
| W2 `memberStore.save` returns its write, and a failure reaches the caller | FAIL | ok |

- Baseline: 1 pass / 9 fail, all on the defect's own assertions (no harness errors), queue EXIT 1, peak 134 MiB.
- Fix: **10/10**, queue EXIT 0, peak 133 MiB.
- Earlier runs of the file had test bugs (late rejection handlers, a wrong state argument, a `t = 1` world where re-dealing
  cannot change the share, a last-index ordering check). They were fixed in the test before the final runs above.
  `logs/` keeps every run.

**Existing regressions on the fix (256 MiB):**
- `custody-independent-admission` 2/2 OK (member roster verification);
- `custody-v2-shield-daemon` 12/12 OK.

**`custody-v2-e2e`: the ONE root-approved 512 MiB run (ROOT-REGRESSION-ALLOCATION) FAILED, before any member code ran.**
- Run `fixed-e2e-512`: queue EXIT 1, peak 411 MiB, 0/1 (6.7 s).
- Failure: viem `AbiEncodingLengthMismatchError` deploying the vault, expected 2 constructor params, given 3 (test line 95
  via `deploy` line 89).
- **Cause, pre-existing and independent of this fix:**
  - At c635fd68 `contracts/EnclaveSecretVaultV2.sol` is the restored production source (bf467cca "Restore production
    custody source and isolate optional pinned variant"), with `constructor(address book_, address enclaveOwner_)`.
  - The test still deploys `[book, enclaveOwner, ownership]`, the pinned variant's constructor.
  - Neither file is in this fix's diff, and the deployment fails before genesis, so the outcome is identical on the
    unfixed tree by construction.
- **No contract-level regression of the member genesis/handover exists for this candidate as checked out.** This tree has
  no `custody-v2-original-vault-e2e`.
- Repairing the e2e for the restored production vault is a separate test-only round; not started (root: no unbounded
  new rounds).

**NOT run:**
- **`custody-v2-independent-runtime`.** Its `before()` runs a `cargo build` of the Rust DKG helper (OOM at 256). It uses
  a stub member and a no-op persist, so it does not exercise the changed code.
- **`custody-v2-independent-lifecycle` and the governance/identity anvil suites:** not run (lane).
- **The host-policy suites:** not run; the gate is unchanged.

## 5. Security limits (unchanged by this fix; no false claims)

- **F2:** the host still keeps 20 historical sealed blobs (`host.mjs` 65-72). A malicious host can hand back an older blob,
  which holds an older chain checkpoint and, after a handover, an older epoch's share. The barrier is about OUR writes
  completing before OUR acks; it is NOT anti-rollback against a malicious host. There is no hardware monotonic counter.
- **F4:** per-deployment high-water marks remain memory-only (`custodian.mjs`).
- **Durable means what the host accepted.** "Durable" = the host's PUT /state returned 200 (it fsyncs the file and the
  directory). An honest-but-crashing host is covered; a host that lies about the write is not.
- **Upgrade compatibility.**
  - Sealed states written by the old image have no `pendingAcks`. A pending share from them is recomputed, and its ack
    re-sent.
  - If the old image had already acked, the vault refuses the duplicate (`BadAck`) until the epoch activates or the
    proposal expires: harmless, but logged per tick.
- **Write volume unchanged:** one whole-state write per engine tick, as before. Failures now stop the tick instead of
  being logged and ignored.
- **The live custodian is untouched.** The live custodian (`2530eda0`, a single seat) never runs handovers. Its genesis
  happened on Oct 14 with the old code. This fix matters for the corrected image's future genesis (P2) and any handover.

## 6. For root

1. Review `415483ff` / the patch.
2. Decide whether to repair `custody-v2-e2e` for the restored production vault constructor (a test-only round), so that a
   real-contract genesis/handover regression exists before the image build.
3. Rebuild the corrected custodian image from this source with the existing build recipe. The new measurement must be
   quote-checked.
4. Then run the production SNP lifecycle, outage, restart and rollback canaries from the audit runbook (§8), on a
   dedicated canary custodian.

Nothing here is a production result.
