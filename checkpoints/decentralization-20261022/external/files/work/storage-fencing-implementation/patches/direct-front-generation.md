# Direct (relay-free) fronts: the writer-authority fact from the guest's own chain reads

**Owners:** the isolation/m2 front and bootstrap owners. This is a request plus a specification; I edited no shared
file.

**Applies to** the direct builds: `bootstrapdirect`, SNP direct, and `shielddirect` (Shield/VBS). They already read the
deployment row themselves, through a measured RPC set: `bootstrap.Reader`, `chain.go` `readAt` / `read` /
`leaseCurrent`. No relay sits in their path, so the relay patch (`relay-front-generation-binding.patch`) does not
reach them.

## What to add

1. **Reader.** In the same agreed snapshot as the row (same block, same RPC quorum):
   - `deploymentsSchema()` on the ledger.
   - If the schema is 17 or above: `leaseOf(id)` (selector 0x621d2b97, served by the ledger's fallback; see
     `work/lease-generation-interface.txt` section 4). It returns `(runner, runnerOperator, leaseUntil, generation)`.
     Require `runner` to equal the row's runner, then
     `writerAuthority = {"source":"lease17","chainId","ledger","deployment","generation"}`.
   - Otherwise (rev 16): `eth_getLogs` for `Claimed(bytes32 indexed id, bytes32 indexed enclaveId, ...)` with
     `topics = [Claimed topic0, id, runner]` and `toBlock = the agreed block`. Take the LAST log, then:
     - require its block number to be at or below the `finalized` block that every agreeing RPC reports;
     - `writerAuthority = {"source":"lease16","chainId","ledger","deployment","claimBlock","claimLogIndex"}`.
   - A disagreement, an unavailable quorum, a non-finalized claim, or a `generation == 0`: no fact. Never guess.
2. **Front.** Put the fact into the config substitution map under the reserved name `ENCLAVE_WRITER_AUTHORITY`, and
   `ENCLAVE_INSTANCE_ISOLATION` = `"snp"` (SNP direct) or `"vbs"` (shielddirect), a constant of the build. Refuse any
   owner value under either name: the same `withReleaseFacts` rule as in the relay patch.
3. **The fact is fixed at app start.** It is the lease the guest STARTED under. The front's existing per-minute
   Refresh revokes names on an ended or changed lease. sia-s3 needs nothing more: a later claim raises a higher
   generation, and the indexers' fences stop this instance.

## Why the guest's own read is enough, and its limits

- **No new authority.** The fact orders who may preempt; it is not what makes writes safe. Safety comes from the
  indexers' exact fences.
- **Under one lease, a wrong or stale fact can only lose.** A lower generation never preempts a higher one, and every
  instance under the current lease reads the same generation.
- **A forged fact needs the RPC quorum to lie.** That is the same trust the direct front already places in it for
  `Authorize`.
- **Same-lease restarts by a host (churn) are not bounded by this fact.** Each restart under the same lease preempts
  the previous instance.
  - The relay path can bound releases per (deployment, generation).
  - The direct path has no such counter.

  Recommendation: the direct front refuses to start the app if the deployment's runner key signed no start
  authorization for this boot. That is an operator decision, and it is left open here.
