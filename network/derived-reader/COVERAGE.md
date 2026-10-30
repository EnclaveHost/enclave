# Complete lease-event coverage (explicit v3 mode)

The reader can publish locally verified, complete lease16 event ranges alongside
its derived anchor. This is implemented, with native build tests and composition
checks (33 focused Node tests, including 13 coverage tests). The actual native
binary also refused malformed witness, wrong-chain and interval-2 inputs under
the pinned library loader. Positive real Base witness, performance/resource and accepted-image
qualification remain pending. It does not activate a relay, change a contract,
automatically reclaim a lease or weaken custody freshness policy.

## Configuration and source

Use `config.v3.example.json` with the separately pinned
`derivation_harness_lease_v3` binary and `native.resultVersion: 3`. Version 2 remains
the default and accepts only its existing build/format; it cannot implicitly gain
coverage. Version 3 requires intermediateBlockInterval 1 and range 1..1800. It
uses a 16 MiB total native stdout cap. This larger cap is selected only by v3 in
the production provider; version 2 keeps its range-derived bound.

Native v3 r2 source manifest:
`c990e67156f32992ab0c10d7e9c7d4ad98ea94485125eb2a57df538701f6deb0`.
Binary SHA256:
`49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa`.
Root build receipt commit: `8594bc1ee`; 14 Rust tests passed, zero failed,
ignored or filtered, Cargo.lock unchanged. Native execution recomputes the
receipt and transaction roots, derives transaction hashes from executed bytes,
and examines every executed receipt. Python/Node source checks alone did not
qualify this binary. The source protocol is
`derivation-lease-coverage-stage/r2/PROTOCOL.md` in the coordinated build evidence.

The reader checks all common v2 bindings plus the v3 coverage format/filter,
contiguous block numbers including empty-event blocks, every sampled output root,
the final executed header, and ordered unique log indices with the correct block
hash. Completeness comes from the pinned native execution, not from hashing
host-selected logs. The compiled filter covers Claimed/Renewed/Released topic0
at **every emitting address**, preserving administrator ledger migrations.
A one-topic log from another contract is still valid coverage; ABI interpretation
belongs to the confirmed-ledger consumer, not the global coverage validator.

## Exact local capability

```js
const value = await reader.readDerivedLogs({
  address,                 // lowercase 20-byte hex, confirmed ledger
  topic0s,                 // unique nonempty subset of LEASE_TOPICS
  topic1: deployment,      // lowercase 32-byte hex
  fromBlock, toBlock,      // inclusive, safe integers
  anchor: { number, hash },// exact snapshot Base anchor; lowercase hash
  signal,
});
```

Successful return:

```js
{
  format: 'enclave-derived-logs/v1',
  logs: [{ address, blockNumber, blockHash, logIndex, topics, data, txHash }],
  anchor: { tier: 'l1-finalized-derived', base: { /* full reader anchor */ }, l1: { /* full reader anchor */ } },
  filter: { address, topic0s, topic1, fromBlock, toBlock },
  coverage: {
    format: 'enclave-lease16-coverage/v1', filterId: 'lease16-events/v1',
    fromBlock, toBlock, complete: true, availableFromBlock, availableToBlock,
  },
}
```

This is an in-process capability. No HTTP log route exists, and copying its JSON
elsewhere does not authenticate it. The requested anchor must match the reader's
current anchor, and toBlock must not exceed it. `complete` refers to precisely the
returned filter and inclusive range. An empty logs array can be complete.

Inside the lifecycle snapshot callback, use its supplied block number/header:

```js
await snapshot(async (client, blockNumber, header) => {
  const row = await client.readContract(rowRead);
  const events = await reader.readDerivedLogs({
    address: ledger, topic0s: LEASE_TOPICS, topic1: deployment,
    fromBlock, toBlock: Number(blockNumber),
    anchor: { number: Number(blockNumber), hash: header.hash }, signal,
  });
  return validateWriterGeneration(row, events);
});
```

If derivation advances between the two calls, the log query refuses the old
anchor. Retry the entire snapshot; never combine an old row with new logs.
Readers reject stale anchors, changed L1 authority, missing ranges, unknown
filters, cancellation and altered chunk files. A 30-second deadline covers the
log read and its before/after authority checks. The response cap is 16 MiB;
oversize queries refuse without truncation. A consumer can explicitly request
smaller complete block ranges, always against the same snapshot anchor. To discover
the covered start, first query [B,B] at that anchor and use its availableFromBlock
for the next query. If no Claimed event is found in the complete covered range,
the earlier claim stays unproven.

## Persistence, recovery and limits

Version 3 has a separate private coverage store under its state directory, with
a kernel lock, immutable content-addressed chunks and an atomic hash-linked
manifest. The manifest is fsynced before the anchor journal, and both precede
publication. A failed/uncertain write fences the process, including its previous
anchor. On restart the greater of the anchor/coverage saved floors restricts
publication, covering interruption between their writes.

Saved files are never evidence of complete history. Only chunks revalidated by
native derivation in the current process can answer queries. Restart starts from
a freshly authenticated ASR root and derives contiguously through the saved floor
before publishing. Existing chunk bytes can be reused only when they match a new
locally verified result. If the new bootstrap is later, older retained files stay
unqualified. Claims below the first runtime-verified block remain unproven until
explicit authenticated historical backfill; no auto-claim or implied coverage.

`historyMaximumBytes` defaults to and cannot exceed 4 GiB. It is a ceiling, not a
preallocation. Of it, 32 MiB is reserved for two maximum manifests during atomic
replacement. Each chunk and manifest is bounded by 16 MiB; at most 16,384 manifest
entries are retained. Orphan chunks and interrupted chunk writes count against
the quota. There is **no automatic eviction**, including on capacity exhaustion.
Full quota or manifest capacity refuses further progress and needs an explicit
retention/recovery decision. The ceiling accounts for file bytes and the manifest write reserve; storage
provisioning must also account for filesystem allocation/metadata overhead.
Query processing reads one bounded chunk at a time.
The response is bounded independently; the whole 4 GiB is never loaded at once.

These caps are policy, not real-workload sizing results. Large matching-event
bursts can require smaller derivation ranges. The native 1536 MiB memory default
and 1/30/1800-block costs still need real witness qualification. Native witness
scratch is separately bounded by the existing witness-size policy.

Changing version/build/checkpoint/interval/history budget changes the journal
binding. Use reviewed enrollment or migration preserving the external recovery
floor; do not delete state to bypass it. The coverage journal is not a substitute
for the accepted domain's protected disk-rollback floor and clock.
