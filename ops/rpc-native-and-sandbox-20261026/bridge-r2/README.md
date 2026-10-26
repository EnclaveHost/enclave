# derivation-schedule-auth-stage/integration-r2 (50cf; PREPARED; integration-r1 frozen): reader → r4 native trusted input (10 keys)

**Change from r1:** the trusted input now has 10 keys. The 10th, `intermediateBlockInterval`, is required by upstream `BootInfo::load` (a non-zero u64, refused if zero). Both it and `agreedL2BlockNumber` are **caller-authorized** and never come from the host witness.

**Upstream sampler rules, enforced before any run:** (claim − agreed) must be a **non-zero multiple** of the interval (`IntermediateRootSampler`: `EmptyRange`/`PartialInterval`). The JS side bounds the interval to a safe integer, which is stricter than u64.

**`acceptNativeResult(result, buildTrustedInput(...))` additionally binds:**
- `intermediateBlockInterval`;
- `l2PreBlockNumber` == the agreed block;
- `intermediateRoots`: exactly (claim − agreed)/interval whole roots, the last == the claimed root.

**Commitment effect:**
- **Committed:** `BootInfoStruct` commits the interval and the concatenated roots into `bootInfoAbi`/`bootInfoKeccak`.
- **Not committed:** the interval is not in the on-chain proposal journal.
- **Aggregation:** upstream aggregation requires one interval across ranges.
- **Scope:** it selects which roots are committed and never changes the derived chain.

**Not a lifecycle provider.** `test/bridge.test.mjs`: 14 offline tests (the mocks and native shapes are test doubles only).
