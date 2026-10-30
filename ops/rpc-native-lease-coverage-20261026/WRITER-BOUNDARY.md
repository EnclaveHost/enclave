# Finalized writer authority and custody v2 under the derived reader: adapter boundary

**Status: FINAL BOUNDARY REPORT. No code. Both features blocked; KVM API requests in §4.**

**Verdict:** neither feature can be completed against KVM's derived reader as it is today. Each needs one specific capability that it does not expose; the requests are in §4. Until then both features stay fail-closed. **This is not completion.**

**Sources read (all read-only):**
- candidate `rpc-final-candidate-20261026/tree` @ `64156dcd9`;
- KVM worktree `enclave-deployment-lifecycle` @ `cc8c9bd4f` plus its untracked `network/derived-reader/*` and `network/lifecycle-finality-bridge.mjs`. `network/verified-chain.mjs` is byte-identical in both trees.

**Not done:** no edits, SSH, network, commits or tests.

## 1. Why `writer_authority_unproven` (relay/api-relay.js:2519-2530)
**The fact:** `ENCLAVE_WRITER_AUTHORITY` is `lease16` `{chainId, ledger, deployment, claimBlock, claimLogIndex}`. It names the CURRENT lease generation's last `Claimed` log. The guest parses exactly this format (`isolation/m2/front` `ParseWriterAuthority`, measured).

**What producing it requires** (legacy `relay/lease-generation.mjs:208-317`):
- **(a)** the ledger row at a block B: active, runner, runnerOperator, leaseUntil (schema 16);
- **(b)** the last `Claimed` log for the deployment, and **every** `Renewed`/`Released` after it up to B (**completeness**), replaying exactly to the row's `leaseUntil`;
- **(c)** the claim's block is **finalized** and canonical.

Completeness is essential. I checked this against the contract, `contracts/EnclaveDeployments.sol`:
- **The contract rules:**
  - `claim` requires `block.timestamp > leaseUntil`, so the same runner may re-claim after an expiry, with no `Released`;
  - a paid `renew` extends from `leaseUntil`;
  - a free renewal (rate 0) sets `now + leaseSec`.
- **Why replay alone doesn't catch omission:** a source that omits the re-`Claimed` (and any `Released`) but keeps the later `Renewed` logs passes the replay with the OLDER generation. The replay checks only the runner, no `Released`, and the last `leaseUntil` equal to the row's. That defeats writer fencing.
- **This contradicts the module comment.** `relay/lease-generation.mjs:12-15` says omitted logs "cannot replay to the row". The legacy reader is actually protected only by provider agreement.
- **Continuity checks are partial.** Checking that each renewal block's time is ≤ the previous `leaseUntil`, plus the paid-lease `burned6/rate` arithmetic, catches some omissions. They do not catch a free-lease release+re-claim inside the old window. So complete logs are required.

**Today's sources:**
- **Legacy relay:** two or more distinct-host public RPCs that agree, plus their `finalized` tag. This is endpoint trust.
- **Guest fallback when the relay has no fact** (`front/provision.go relayPathFacts`): its *measured public RPC quorum*. Under a public-RPC blackout this also fails: no fact means no app, for every app whose config names `ENCLAVE_WRITER_AUTHORITY`. **So the feature is blocked under blackout today.**
- **Verifier mode:** refused. The helios opstack tier is unsafe, and `eth_getLogs` proves inclusion, not completeness.

## 2. What KVM's derived reader actually offers (and doesn't)
- **`readAnchor()`:** returns `{tier:'l1-finalized-derived', base:{number, hash, stateRoot, messagePasserStorageRoot, outputRoot, timestamp}, l1:{…}}`. It is produced only by a successful local native derivation and is L1-finalized.
- **`createLifecycleFinalitySnapshot(...)(read)`:** the bridge. It runs the existing local verifier at exactly the derived hash (it re-matches hash and stateRoot before and after the read) and hands `read` a `pinnedClient`.
  - Offered: `getBlock`, `readContract`, `getStorageAt`, `getCode`, `getBalance`, and `call` if allowed.
  - **Not offered: logs or receipts.**
- **Native v2 result:** binds `intermediateRoots`, the output roots of every block in the derived range when the interval is 1. That would authenticate every block hash/header in the range. But `bindNativeV2` keeps only the final root; **nothing persists or exposes the intermediate roots.**
- **Requirements that stay explicit:**
  - in-domain use only; loopback HTTP is diagnostics;
  - `acceptedImageQualified:false` and `livePositiveBaseDerivation:false` (`qualification.json`).

**What maps cleanly onto the writer authority:**
- (a) is provable now, as the row read at derived B;
- (c) is provable for any claim block ≤ B with an authenticated hash. EIP-2935 storage at B (`getStorageAt`, slot `C % 8191`) covers B−C ≤ 8191 blocks.

**What is missing:**
- **(b) completeness, plus inclusion of the claim log.**
  - Completeness can't be rebuilt consumer-side at reasonable cost. Base `logsBloom` is saturated (hundreds of logs per block), so a bloom-negative skip almost never applies. Proving "no other lease log in (C, B]" means fetching and root-checking every receipt of every block: about 900 blocks per lease quantum, and leases renew indefinitely.
  - Only the native derivation, which executes every block, sees all receipts at no extra trust.

## 3. Custody v2 (`custody/v2/quorum.mjs:42-45`, `build-config.mjs:25,51,56`)
**The refusal** (`chain_verifier_unsupported`): v2 needs same-block evidence `{blockHash, requireCanonical:true}`. The pinned unsafe verifier drops `requireCanonical`, and hash→number translation is not A-B-A-safe.

**The derived bridge addresses that specific concern for reads at its anchor:**
- the anchor is L1-finalized;
- the bridge re-matches number→hash on the verifier before and after the read.

**It is still not an adapter by itself:**
1. **Measured image:** custodian v2 is a measured SNP image. `rpcs: MEASURED_RPCS` (4 public), `minAgree: 3` and `maxAgeSec: 120` are part of the measurement. Changing its chain source is a **new accepted custodian image and committee handover**, owned by root/custody, not a config switch.
2. **Domain:** the derived reader must run inside the consumer's accepted domain, or reach it over an attested channel. The README says remote consumers "need its attested channel", which does not exist. So either the reader (L1 light client, native binary, checkpoint, library closure) goes into the custodian image, or KVM provides the attested channel.
3. **Freshness:** a finalized anchor is about 15-30 min behind (up to `maxAnchorAgeSec` 1800), against today's 120 s. Taken alone, owner pause and revocation would act only after finality. Lowering `maxAgeSec` is **not** acceptable. The sound composition is: grant only on the derived-finalized read **and** deny if the local unsafe verifier head shows a pause or revocation (unsafe data may only deny). This is a custody policy decision; I'm documenting it, not implementing it.

## 4. Concrete KVM API requests (I add no proof source of my own)
- **R1, native log extraction** (new native build and pin, owned by KVM/native).
  - For a reviewed, compiled-in filter `topic0 ∈ {Claimed 0xa8cc21eb…, Renewed 0xc3f167f2…, Released 0x0e334fd1…}`, the native verifier emits every matching log of every executed block in (agreed, claimed]: `{address, blockNumber, blockHash, logIndex, topics, data, txHash}`.
  - **Every emitting address is included, not only the live ledger.** The live ledger `0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b` (`contracts/deployments/contract-pins-production-base.json`, `isolation/m2/bootstrap/pins.go`) is resolved through the admin AddressBook, and an admin book migration must stay covered without a new native build. The consumer filters by its own confirmed ledger.
  - These logs come from its own execution and are bound to `intermediateRoots`/block hashes in the v2→v3 result.
  - Volume: lease events only (renewals about every 30 min per deployment).
- **R2, journal coverage.** The journal keeps hash-linked, contiguous **derived log coverage** `[from, to]` with these logs and the same rollback floors.
  - A restart re-derives and never seeds coverage from JSON alone, matching the existing rule for anchors.
- **R3, capability.** `reader.readDerivedLogs({address, topic0s, topic1, fromBlock, toBlock, signal})` returns `{logs, anchor}`.
  - It refuses unless `[fromBlock, toBlock]` ⊆ contiguous coverage and `toBlock` ≤ the current `readAnchor()` block.
  - It is in-domain and never served over the HTTP API.
- **R4, backfill (decision needed).** Coverage begins at the reader's first ASR bootstrap. A lease whose current `Claimed` predates coverage stays unprovable (an explicit refusal) until it is re-claimed, unless KVM supports a one-time historical derivation. The live 16d ledger starts at block 52,515,705, which is the lower bound.
- **Alternative to R1, rejected as the default:** persist `intermediateRoots`, and let the consumer verify full receipts per block against authenticated `receiptsRoot`. It is sound, but bandwidth-prohibitive on Base.

## 5. Relay adapter once R1–R3 exist (precise boundary, mine to implement then)
- **Selection:** in `relay/api-relay.js:2526-2530` only, under `RELAY_CHAIN` with an explicitly configured in-process derived reader and bridge, `writerAuthoritySource = createDerivedWriterAuthority({snapshot, readDerivedLogs, ledger: confirmedLedger})`. Otherwise the existing refusal is unchanged; there is no implicit fallback, and provider lists stay refused.
- **Reads:**
  1. `snapshot(read)`: schema plus row at derived B (proof);
  2. `readDerivedLogs` over `[52,515,705 or the coverage start … B]` for the deployment;
  3. the existing replay rules (last `Claimed` names runner/operator; no `Released` after it; renewals replay to `leaseUntil`). Claim ≤ B means finalized.
- **The fact format is unchanged** (`lease16`), so the measured guest is unchanged.
- **Evidence label:** `{authority:'consumer-domain-derivation', tier:'l1-finalized-derived'}`. Nothing is labelled from the unsafe head or the HTTP status.
- **Tests (offline, 512 queue):**
  - parity of the fact with the legacy reader on the same rig history;
  - an omitted `Released`/`Claimed` → refusal;
  - coverage gap → refusal;
  - anchor rollback/contradiction → refusal;
  - a stale anchor → refusal;
  - verifier mode without the reader → `writer_authority_unproven` (the existing test `storage-front-binding-release.test.mjs:136` kept).

## 6. Interim option for root (operator decision, not implemented)
In legacy (non-verifier) relay mode, `SECRETS_RELEASE_CATALOG_RPCS` may name **two own Base nodes on distinct hosts**. The Base holder's retention plan keeps receipts since block 48,000,000, which covers the ledger's 52,515,705 start. This keeps the feature under public-RPC blackout with **own-node endpoint trust**, honestly labelled. It is not proof, and it is incompatible with the relay's verifier mode, which refuses provider lists by design.

## 7. Outcome of this task
- **No code; no stage directory created.** The coupling needs a KVM API change (R1–R3; native build and journal) for the writer authority. Custody v2 additionally needs an attested channel or an in-image reader, a new measured image and a policy decision. Writing an adapter against an API that does not exist would invent a proof source, which the task forbids.
  - `finalized-writer-integration-stage/` will hold the §5 adapter and its tests once KVM publishes R3, or a different concrete interface.
- **Tests:** none run, so there are no queue jobs and nothing was left running in the background.
- **For KVM:** R1–R4 (§4).
- **For root and custody owners:**
  - §3 (custody v2 image, domain and freshness policy);
  - §6 (the interim own-node option);
  - the module-comment correction in §1.
- **Status of both features under public-RPC blackout:** blocked and fail-closed. This is **not complete.**
