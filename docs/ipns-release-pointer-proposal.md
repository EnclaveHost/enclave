# Proposal: a CID-only release delegate for the ipns-publisher, anchored on chain (not implemented)

**Status:** proposal for review. It needs a new contract and ipns-publisher (Rust) changes; neither is implemented here.

**What already works:** a staging record held by the owner's vault, published by a session limited to
`deploy.setConfig` (`docs/site-release.md`, Publication). That path already uses an on-chain anchor (the deployment's
config). This proposal narrows the delegate to "choose a CID" and removes the staging and vault requirement.

**What is not automation parity:** one owner signature per release (`enclave config set` from the wallet).

## Why the earlier pointer design was not safe after state loss

The earlier draft proposed signed pointers fetched from untrusted sources, accepted when `pointer.seq` exceeds "the
IPNS sequence the publisher holds or has recovered". The publisher's own code shows that this floor is **best effort**
(`../enclave-apps/ipns-publisher/src/main.rs`):
- `load_state` reads `/data/ipns-publisher-state.json` only if the platform gave the app a durable volume.
- `enqueue_publish` queues a `Recover` per delegate. It runs the DHT walk (`RecoverDht`) only when there are **no**
  delegates and **no** durable state.
- `do_recover` logs and ignores every failure (`GET failed`, a non-200 answer, a record that fails verification).
  `do_recover_dht` treats "no record found" as a fresh name.
- `Sign` runs whatever recovery produced. With nothing recovered, the sequence is **0**.

So after total state loss, the floor can be 0. Total state loss here means no `/data`, the delegates unreachable or
stale, and the DHT partitioned or eclipsed from the host's network position. Any older, unexpired signed pointer then
passes `seq > floor` and the name rolls back.

Neither of the obvious fixes repairs this:
- **Expiry** only bounds how long an old pointer stays valid. To make replay harmless, `notAfter` must be short. Then
  the signer must re-sign every period, forever, with an online key: a liveness requirement, and still a replay window.
- **The IPNS sequence** is state the publisher holds, or learns from the very network the adversary may control. It is
  exactly what is lost.

To know which release is **latest** after losing everything, the publisher needs an authority whose freshness it can
check. Base is already a dependency (the deployment's config lives there), so the anchor goes there.

## Threat model

**The adversary can:**
- serve or replay any previously valid signed message;
- control the pointer sources and gateways;
- block or delay the publisher's delegates and DHT peers;
- control up to `n - k` of the `n` configured RPC endpoints;
- crash the publisher and wipe its state.

**The adversary cannot:**
- forge the owner's or the delegate's signatures;
- rewrite finalized Base history;
- control `k` of the configured RPCs at once.

The host executes the publisher (inside the TEE) and supplies its clock and network. A host that withholds the network
can stop publication (liveness). It must not be able to make the publisher publish an older CID (safety).

**Goal:**
- the name never moves to a CID older than the latest one the owner or delegate authorized;
- delegation is bounded to choosing a CID;
- the owner can revoke within a bounded time;
- the IPNS key and name are unchanged.

## Design

### 1. The anchor contract, on Base

One immutable contract per name (or one registry keyed by the IPNS name's hash). Its state is:

```
owner     the publisher deployment's owner (wallet or vault), fixed at deployment
signer    the CID-only delegate (an address), or 0
seq       uint64; starts at the owner-chosen floor; +1 on every change, never decreases
cid       bytes (a CIDv1)
```

| Function | Who may call | Effect |
| --- | --- | --- |
| `publish(cid, expectedSeq)` | `signer` or `owner` | Requires `expectedSeq == seq`; sets `cid`, `seq = seq + 1`; emits an event. The compare-and-swap means a stale or replayed transaction fails. |
| `setSigner(address)` | `owner` | Appoints a signer; `0` revokes. |
| `pin(cid)` | `owner` | Sets `cid`, `seq = seq + 1`, `signer = 0`: the owner overrides and revokes in one transaction. |

- Monotonicity is enforced by the chain, not by any party's memory.
- The signer pays gas per release (Base cents). No owner signature is needed per release.

### 2. Publisher configuration

One owner `setConfig`, durable on chain:

```json
"releaseAnchor": {"chainId": 8453, "contract": "0x…", "rpcs": ["https://…", "https://…", "https://…"], "quorum": 2,
                  "confirmations": 3, "maxBlockAgeSecs": 120, "sequenceOffset": 1000}
```

`value` becomes unused while `releaseAnchor` is set. A fixed `value` remains the owner's way back: removing
`releaseAnchor` with `setConfig` returns to today's behaviour.

### 3. Publisher rule

On every republish tick:
1. Read `(seq, cid)` from at least `quorum` RPCs that agree, at one block at least `confirmations` deep and no older than
   `maxBlockAgeSecs`. This is the same rule as the CLI's QuorumChain.
2. Publish the IPNS record with **sequence = `seq + sequenceOffset`**. The owner sets `sequenceOffset` above the last
   sequence ever published at cutover, so the mapping can only grow.

**If the anchor is unreachable, disagrees or is not fresh:**
- **Before state loss:** the publisher republishes only a value it verified from the anchor during this process's
  lifetime, extending that record's lifetime.
- **After state loss:** it publishes **nothing**. The last published record stays resolvable until its EOL. This trades
  liveness for safety, and the trade is explicit.

### 4. Cold restart

There is nothing to recover locally: the anchor states the latest `(seq, cid)`, and the IPNS sequence is derived from
it. A replayed old pointer does not exist in this design, since there is no off-chain pointer to replay.

A stale chain view is refused by the freshness check. It could only be served by `k` colluding RPCs, which is the
quorum assumption, stated as such.

### 5. Owner revocation

- `setSigner(0)` or `pin(cid)` takes effect at the next block.
- The publisher observes it within one poll period plus `confirmations` blocks (for example, 5 minutes plus about
  6 s on Base).
- A compromised signer can publish arbitrary CIDs until then. Every such change is a public, attributable event, and
  the owner's `pin` is always the next, higher `seq`.

## What is preserved and what is not claimed

**Preserved:**
- the IPNS key and name;
- the delegates, the DHT publication and the record format;
- no mutable URL and no Enclave service in the authority path. The contract is the owner's, read through the owner's
  chosen RPCs.

**Not claimed:**
- Liveness when the host blocks the network: no design can provide it.
- Safety if `k` of the configured RPCs collude, or if the host's clock is so wrong that a stale block looks fresh. The
  TEE has no independent time source.

**Review required before implementation:**
- the contract itself (an audit, immutability, the event format);
- the publisher's RPC quorum client in wasm;
- tests for:
  - a cold restart with the anchor unreachable, which must publish nothing;
  - a stale block, which must be refused;
  - a sequence-offset cutover.
