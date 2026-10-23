# Windows feature-gap repair (continuation of the final runtime integration)

Written 2026-10-23, by F in a new isolated tree: work/windows-feature-gap-repair-20261023.

**Scope:**
- **Untouched for D:** the previous final tree and report (`work/windows-final-runtime-integration-20261023`: source 0de09415, evidence dda47a35, RESULT.md).
- **Not done:** no SSH, deployment, restart, native activation, wallet, funds, contracts, toolchain or Wine. No other worker's tree was edited.
- **Queue:** every test and scan went through `work/claude-test-queue.py` (unchanged floor, caps ≤ 1408 MiB).
- **Identity:** SteveDeFacto as author and committer, with hooks on.
- **No production claim.**

## Correction of the previous report (dda47a35 RESULT.md, "Pre-existing failures")

The previous report said `registry-reconcile` #8 showed "a real gap against the off-chain-heartbeat requirement, in the Linux supervisor". **That was wrong.**

- The only heartbeat sends in `supervisor.js` (lines ~9884-9885) are inside `if (process.env.OWNER_NOMINATION_SELFTEST) { … process.exit(0); }`.
- That block is an explicit one-shot self-test, used by `test/owner-nomination.test.mjs`. It loads the operator's transaction queue with heartbeats to test nonce concurrency, then exits.
- Routine owner nomination is gated by `!process.env.OWNER_NOMINATION_SELFTEST`.
- `REGISTRY_HEARTBEAT_SEC` survives only as the old name of the reconcile cadence (line 505: "no heartbeat is sent").
- **No routine writer sends a heartbeat.** The failure came from the test's blanket regex, which could not tell the self-test from a routine writer.
- That nonce-concurrency test is kept, and the off-chain requirement is not weakened.

## Final pins

**Source:** `candidate`, branch `gap/windows-feature-repair`, head **0ed6b6d953a018a585f5fe9fadc64e0d7eca9d46**, tree **dfb63eafaa76a5ea1ae808ae3d5b90c04471d6a2**. It is one commit on dda47a35 (= source 0de09415 + its evidence).

**Immutable patch:** `feature-gap-repair.patch` (`git format-patch`), sha256 **71ea8856ea8465092fcc87be387c75fcef3469034bcdee21aa99724895648a9d**.

**Included:** three test files only.

| File | Change |
|---|---|
| test/registry-reconcile.test.mjs | +62 / -1 |
| test/catalog-platform-enforcement.test.mjs | +47 / -8 |
| test/site-independent-account-startup.test.mjs | +43 / -7 |

**Omitted:**
- No product, policy, trust or bundle source changed, so no artifact, bundle or closure changes. The final runtime integration's 22 JS artifacts, admission bundle 6bd91351 and 89-file closure 783797c0 stand unchanged.
- **Composability:** the patch touches only these test files. dda47a35 differs from 0de09415 only under `checkpoints/`, so the patch applies to either base.

## 1. registry-reconcile: the heartbeat self-test vs routine writers

**The new assertions** (a placement invariant, labelled as such):
1. every `sendOperatorTx(… "heartbeat" …)` is inside the self-test block (a string- and comment-aware brace scan);
2. the block ends in `process.exit(0)`;
3. the self-test still sends heartbeats (the nonce-concurrency load is kept);
4. routine nomination is gated off under the self-test;
5. `REGISTRY_HEARTBEAT_SEC`'s only code use is the `RECONCILE_SEC` alias.

**Negative controls, in the same file:**
- an injected routine `setInterval` heartbeat after the block is caught (1 send outside);
- the REAL pre-change supervisor from this history (`9a307f3ea^:supervisor.js`, which has `REGISTRY_HEARTBEAT_SEC` and a timer heartbeat at its line 623) is caught.

**Behaviour on a real chain** is `test/offchain-heartbeat-writers.test.mjs`. In the previous J1b it passed 2/2 for the real supervisor and the real Windows node, with zero registry writes from routine timers.
- Its negative control, the base supervisor heartbeating on the same counting rig, ran here as job d3 using `9a307f3ea^:supervisor.js` (sha256 69bb3bd9…) staged as an uncommitted scratch file. **Result: PASS (1/1, 64.8 s, peak 401 MiB).** The pre-change supervisor's routine heartbeat reached the registry as a Heartbeat event, so the counter that measured zero for the current supervisor does see heartbeats. The scratch file was removed afterwards.
- It was not repeated broadly, per root.

**Baseline counterexample:** on dda47a35, #8 failed with "the supervisor sends no heartbeat" (previous J1 and J1b).

**Result:** registry-reconcile **4/4** (job d2).

## 2. catalog-platform-enforcement #2: the real Host over the real host admission

**Diagnosis: there is no product failure.**
- The harness extracted `walletPolicyRefusal` from host.mjs's text into a `vm` class. That broke when the method came to call the private `#walletPolicyState`, giving `SyntaxError: Private field '#walletPolicyState' must be declared in an enclosing class`.
- The behaviour itself is intact.

**The replacement** uses the real `Host` (windows/node/host.mjs) and the real `createHostAdmission` (network/host-admission-runtime.mjs). Only the chain is a fixture: one agreed block of the host-ownership extension and the app catalog. It asserts:
- an approved version is admitted for any visibility;
- a **pending** version is admitted only for a ledger-private record (`isPublic === false`). `true`, `undefined`, `'false'`, `0` and `null` are refused (PRIVATE);
- **platform catalog moderation** binds public AND private records: a delisted app, a yanked version and an administrator-rejected version are all refused;
- the host owner's wallet denial is enforced (declines), then lifted;
- a non-catalog reference is a definite refusal;
- an unreadable chain is UNKNOWN ("host wallet policy unavailable: … chain quorum unavailable"), never admitted;
- the hold channel's `decision()` path gives the same answers.

**Unchanged:** test #1, the browser gate, which was passing.

**Baseline counterexample:** on dda47a35 the old harness failed with the SyntaxError above (previous J1; base 1f19ad15 identical).

**Result:** **2/2** (job d2).

## 3. site-independent-account-startup: Safe-held deployOnChain(prepareOnly) created zero records

**Captured outcome** (job d1, unmodified product; the test only captured the call):

```
{"ret":"undefined","error":null,"toasts":["Deploy refused: could not verify current catalog moderation. Please retry."],"lines":[]}
```

**Root cause: the fixture, not the Safe flow and not a product regression.**
- The test deployed `catalog://0x11…11/0`, an app the rig's catalog does not have.
- The browser's catalog moderation gate (`site/js/pages/deploy.js`, before any signature) reads the app and the version.
- `getVersion` on an unknown app reverts (out of bounds), so the gate fails closed.
- The flow never reached the passkey account.
- Passing the test without weakening moderation therefore needs a real listed, approved version.

**The fix (test only):**
- A third-party publisher (anvil #4) publishes a real version, which starts **pending**.
- Before any record exists, the test proves each refusal. Each leaves the ledger count unchanged and names its reason:
  - an unknown app: "could not verify current catalog moderation";
  - pending, for a public record: "requires catalog approval; pending versions may only be deployed PRIVATE";
  - after the administrator approves (the catalog owner, the rig's deployer), the publisher delists: "delisted";
  - relisted, then the administrator rejects: "rejected by the catalog owner".
- The administrator re-approves. The **Safe creates the record itself** with one passkey approval, waiting for owner-committed startup.
- **The Startup tab:** the Safe signs every storage upload itself (ERC-1271, upload v2; never the payer wallet). The passkey approves the Safe's own commit. The committed package verifies with the Safe as owner and holds the committed settings.
- `deployOnChain`'s return value, error, toasts and run-log lines go into the assertion messages.

**Result:** **1/1** (job d2), running all its assertions.

**Safe/passkey code:** the immutable offline fixture from 0de09415 (`test/fixtures/base-code/safe-passkey-code-base.json`). There is no public RPC in any test.
- **Signer singleton provenance (explicit):** 0x4e27b51350e6c2083ee19011120f50dafec5ca50.
  - Its bytes were agreed by two public RPCs at one block, and its address is embedded in the pinned factory's code.
  - That is **reproducibility evidence, not an independent security review**. It has no reviewed codeHash pin of its own. Its 11 sibling contracts do match reviewed pins.
- **Trust policy:** no production trust policy, moderation rule or site source was changed.

## Tests (each file alone, private loopback namespace, denial stubs; per-file aggregation)

| Job | What | Result |
|---|---|---|
| d1 | diagnostic: the startup test capturing the real outcome | 0/1, the counterexample above |
| d1 | registry-reconcile, before the cadence-alias fix | 3/4: my first draft asserted no `REGISTRY_HEARTBEAT_SEC` at all and was wrong; it is the reconcile-cadence alias |
| d2 | registry-reconcile | **4/4** |
| d2 | catalog-platform-enforcement | **2/2** |
| d2 | site-independent-account-startup | **1/1** |
| d3 | offchain-heartbeat-writers, negative control only (`--test-name-pattern 'negative control'`), base supervisor 9a307f3ea^ | **1/1** (64.8 s, peak 401 MiB); the base supervisor's heartbeat is counted |

**Not repeated:** the broader suites, because no product source changed. Not run: anything native.

## ROOT handoff notes (shared interfaces; not changed here)

- **Site UX (E/S, site owners):** for an app the catalog does not have, the browser gate says "could not verify current catalog moderation. Please retry". It fails closed, which is correct, but presents a definite non-existence as transient. This is a narrow site change if wanted.
- **Signer singleton:** root may want a reviewed codeHash pin for 0x4e27…ca50 (see above).
- **Owner-nomination self-test:** its nonce-concurrency heartbeats stay. Any future routine registry writer must be outside the self-test block, and the new invariant would then fail.

**Scans:** `scan-crypto-keys --range dda47a35..0ed6b6d9` 0, gitleaks: no leaks (job s2). Not pushed.
