# IPNS release anchor: reviewed design (supersedes docs/ipns-release-pointer-proposal.md)

**Status: an OPTIONAL, proposed additive contract.** Implemented and tested locally, never deployed. Every existing
contract stays as it is: nothing here modifies, migrates or replaces a deployed contract, and no step is irreversible.
- the contract: `src/ReleaseAnchor.sol`;
- the publisher's reader: [`ipns-publisher/src/anchor.rs`](https://github.com/EnclaveHost/enclave-apps/blob/main/ipns-publisher/src/anchor.rs)
  and `src/main.rs` in the enclave-apps repository (configuration: its README, "Release anchor");
- the tests: `test/` here (forge, and the anvil + kubo + publisher end-to-end), and `../ipns-cutover/test/` (a Base fork
  with the production 1.0.5 component);
- the production cutover: [`../ipns-cutover/README.md`](../ipns-cutover/README.md).

**What it gives:**
- unattended site releases with **no owner signature per release** and **no Enclave server in the authority path**;
- the IPNS key, the name, the delegates, the DHT and the record format are unchanged;
- the legacy fixed-`value` configuration is unchanged.

## 0. Is a new contract needed? (existing contracts first)

The requirement is that the site release moves the IPNS name **without a mutable Enclave server** in the authority
path. Today that server is `https://ipfs.enclave.host/site-root`, the deployed publisher's `value`. Three ways meet
it. The first two need no contract change at all.

| | A. The existing ledger (`setConfig`) | B. The existing EnclaveAddressBook (`setMany`) | C. ReleaseAnchor (optional, additive) |
| --- | --- | --- | --- |
| Contracts | the deployed deployments ledger | the deployed book `0xab21…0907` | one new contract; nothing existing changes |
| Publisher code | the deployed 1.0.5 as is: `value: /ipfs/<CID>` in the owner's config | a new book-read mode (not implemented) | the reviewed `releaseAnchor` mode |
| Per release | one owner signature (`enclave config set`), which restarts the app | one owner signature: the platform governance EOA writes 3 keys atomically | **none**: a CI delegate calls `publish(cid, expectedSeq)` |
| Who can move the name | the deployment owner (or an owner-approved session on a vault-held record) | only the book owner, the same key that repoints registry, ledger and catalog | the delegate (CID only, ≤ 180 days), or the owner at any time |
| Ordering | ledger order; the old code's max+1 rule | none on chain: the owner writes the sequence, the publisher's high-water refuses regressions | compare-and-swap on chain |

**A is available today, with no new code and no new contract.** It removes the `site-root` server dependency as
soon as the owner sets `value` to a fixed `/ipfs/<CID>` and changes it per release (site-release's `publish-plan`
prepares exactly that transaction). An owner-approved session can do it unattended only for a record that the
owner's vault holds; the CLI refuses a session that changes a wallet-held production deployment's config. The session
can rewrite the **whole** config, not only the CID.

**B is measured, not assumed** (`probe/book-evaluation.mjs`, read-only). The deployed book holds only addresses, 20
bytes per key. A CIDv1/sha2-256 plus a sequence round-trips through three keys written by one `setMany`, so readers at
one block hash see all three together. The owner's simulated `setMany` succeeds; an outsider's reverts. But its only
writer is the platform governance owner. There is no per-key writer, no expiry and no compare-and-swap, so CI could
write a release only by holding the governance key itself. B therefore suits owner-signed releases only, and it also
needs a publisher book-read mode that A does not.

**C is justified only for unattended CI releases.** It is the one option that delegates *only* "choose this CID"
to an expiring, revocable key without handing CI the governance key or the whole deployment config. It is a new,
independent contract: it reads and changes nothing in the ledger, book or catalog, and the owner can stop using it at
any time with a config change. If unattended CI release is not wanted, use A and do not deploy C. `retire` exists
in its bytecode but is irreversible and is never used by any step here.

## 1. Review of the proposal, and what changed

| # | The proposal | The problem | Now |
| --- | --- | --- | --- |
| 1 | On an RPC outage, republish the value verified "during this process's lifetime", extending the record's lifetime. | This is unbounded. A partitioned publisher would re-sign a revoked delegate's CID forever, so "the owner can revoke within a bounded time" was false. | The authority from a round is valid until `block.timestamp + authorityTtlSecs`. Every record's EOL is capped there, and so is its TTL. Past the bound, signing **stops**. |
| 2 | Freshness: the block is "no older than `maxBlockAgeSecs`". | It did not say which clock or when. A slow round could pass a check made at its start. A fresh timestamp was read as "the latest state". | Checked with the clock read **after the last response**. The claim is stated as "the state at one recent canonical block", never "the head". Withholding blocks is possible up to the window. |
| 3 | Agreement "on `(seq, cid)`" at "one block". | It did not specify how the block is chosen, how the read is bound to it, or what code is read. Liars could inflate the head, or answer from a fork. | Target = the quorum-th highest head minus `confirmations`. Quorum agreement on (number, hash, timestamp). `eth_getCode` and `eth_call` **by that blockHash** (EIP-1898, `requireCanonical`). The runtime codehash is pinned to the reviewed build. Every endpoint is asked; nothing is first-success. |
| 4 | Not covered. | A confirmed state could later be "un-confirmed", by a deep reorg or by lying endpoints after a restart. | The block and seq high-water, keyed by (chainId, contract), is persisted in `/data`. Any regression is refused. Without `/data`, the recovered IPNS sequence is the floor. |
| 5 | `sequenceOffset` "above the last sequence". | It said nothing about overflow, about being equal with another value, or about migration. | The add is checked. A recovered sequence that is higher, or equal with another value, is refused. The migration and identity rules are in §4. |
| 6 | `setSigner(address)`, unbounded in time. A `pin` with CAS was implied. | The delegation was unbounded. An owner override could lose a race to the delegate. The owner was "fixed at deployment" (no reviewable transfer). | `setDelegate(d, until)` is bounded to ≤ 180 days. `pin` has no CAS and revokes in the same transaction. Ownership is a two-step transfer that clears the delegate. `retire` exists in the reviewed bytecode but is irreversible, so no plan or step uses it. |

**Kept from the proposal:**
- one immutable contract per name;
- the compare-and-swap `publish`;
- no off-chain signed pointer at all, so there is nothing whose "newest seq" is remembered only locally;
- the honest statement that liveness is lost when the host withholds the network.

## 2. Threat model and claims

**The adversary may:**
- control up to quorum − 1 of the configured RPC endpoints, which may lie, lag, fork, replay or hang;
- control every delegate, gateway and DHT peer;
- crash the publisher, wipe `/data`, and partition it;
- skew the host clock;
- compromise the delegate's key.

**It may not:**
- forge the owner's signature;
- control `quorum` endpoints at once;
- rewrite Base history deeper than `confirmations`;
- skew the clocks of resolvers.

**Safety, under those assumptions:**
1. Every record carries a state the anchor held at a quorum-agreed canonical block.
2. A publisher never signs a lower IPNS sequence than one it has accepted or recovered, nor the same sequence with
   another value.
3. A state superseded at block time P (by a pin, a revocation or a publish) appears only in records whose EOL is at most
   P + `authorityTtlSecs`. The EOL bound is derived from the attested block timestamp, so a host that partitions the
   publisher, or moves its clock, cannot extend it.
4. The delegate can choose a CID, and nothing else.

**Liveness, not claimed under attack:**
- Without a quorum, a working delegate (or the DHT), and storage that holds the CID, nothing new is published.
- After `authorityTtlSecs` without a successful round, signing stops; the last record lapses at its EOL. This is the
  price of claim 3.
- In normal operation, a change is observed within `pollSecs`, plus the confirmations, plus one round.

**Clock:** a slow host clock makes old blocks look fresh to the freshness check. Claim 3 still holds, because the EOL
comes from the block. The publisher refuses blocks more than 120 s ahead of its clock.

## 3. Dependencies, not authorities

| Dependency | Role | If it fails or lies |
| --- | --- | --- |
| RPC providers (`releaseAnchor.rpcs`) | the chain view, quorum-checked | fewer than quorum faulty: no effect. Otherwise: refused rounds (liveness only), unless `quorum` collude (the assumption) |
| Delegated routing (`delegates`), DHT, IPNI | distribution of the signed record; sequence recovery | slower or no propagation. A higher recovered sequence makes the publisher refuse (safe) |
| Replicated storage of the site CAR | resolvability of the content | the name resolves to a CID that cannot be fetched. The delegate tool refuses to publish a CID unless at least `--min-gateways` gateways serve its complete DAG (a verified CAR: every block and file) |
| Enclave origins (the fleet RPC, the app's own HTTP surface, the site hosts) | conveniences | none is in the authority path. The tests run with an Enclave RPC that hangs and an Enclave delegate whose port is closed |

None of these has a default that chooses the value: `rpcs` has no default, and `delegates` and `bootstrap` defaults
only distribute.

## 4. Sequence offset, migration, identity

- **Cutover from `value`:** pick `sequenceOffset` > (the highest sequence ever published) − 1. The publisher refuses
  a lower mapping that it can see; it cannot see records it cannot reach.
- **A new anchor contract:**
  1. deploy it;
  2. `setConfig` with the new contract and codeHash, and an offset above the old mapped sequence;
  3. then `setDelegate(0, 0)` on the old anchor. That is reversible, and the owner keeps the old anchor and its
     ownership. **Do not call `retire`:** it freezes the contract forever, and no migration needs it. The owner
     migrates by changing the publisher's config, which stays under the owner's control (and the platform
     administrator's, where the deployment is governed that way).

  The high-water is per (chainId, contract), so the old one does not block the new one. `successor` is never
  followed automatically.
- **A new IPNS key** is a new name, so it needs a new anchor: `nameHash` is immutable and part of the codehash.
- **Two publishers with the same key and anchor** produce the same (sequence, value). With different offsets, the higher
  one wins, so stop or reconfigure the other one.
- **Ownership:** `transferOwnership` → `acceptOwnership`. Both are public events, and the delegate is cleared.

## 5. Integration (shared files are not edited here)

**Unattended release in CI, after the existing `deliver` step reports `active`** (no `--publish`):

```yaml
- name: anchor release
  env:   # secrets reach the shell as environment, never interpolated into the script
    ANCHOR_RPC: ${{ vars.ANCHOR_RPC }}
    ANCHOR_CONTRACT: ${{ vars.ANCHOR_CONTRACT }}
    KS: ${{ secrets.ANCHOR_DELEGATE_KEYSTORE }}
    PW: ${{ secrets.ANCHOR_DELEGATE_PASSWORD }}
  run: |
    umask 077
    printf '%s' "$KS" > "$RUNNER_TEMP/ks.json"
    printf '%s' "$PW" > "$RUNNER_TEMP/pw"
    node tools/ipns-release-anchor/scripts/anchor-release.mjs publish --rpc "$ANCHOR_RPC" --contract "$ANCHOR_CONTRACT" \
      --cid "$CID" --keystore "$RUNNER_TEMP/ks.json" --password-file "$RUNNER_TEMP/pw" \
      --gateway https://gw1.example --gateway https://gw2.example --min-gateways 2
```

The repository's actual step is in `.github/workflows/deploy.yml` ("Publish through the release anchor"). The release
tool admits a CID only when `--min-gateways` gateways each serve its **complete** DAG: their `?format=car` export must
verify with site-release's `scripts/site-release/car.mjs` (every block hashes to its CID and is reachable from the
root, and every file reassembles), bounded by `--max-car-bytes`. A root block alone proves nothing about the
children.

## 6. Owner steps (each one is an owner signature; none was done here)

1. Deploy `ReleaseAnchor(owner, nameHash, initialCid)` on Base:
   - `nameHash` is the `anchor-name-hash` printed by `ipns-publisher id <key>`;
   - `initialCid` is the release currently published.
2. Verify the deployment: `node scripts/expected-codehash.mjs <nameHash> --code $(cast code <addr>)` prints
   `matchesOnchain: true` and the `codeHash`.
3. Appoint the delegate: `setDelegate(<delegate>, <now + ≤ 180 days>)`. Then fund the delegate with Base ETH; a publish
   costs at most about 132k gas (the forge gas report, for a 128-byte CID).
4. Configure the publisher: `enclave config set <deployment>` with `releaseAnchor` added and `value` removed. This
   needs:
   - three or more independent https RPC providers, with `quorum` ≥ 2;
   - `sequenceOffset` above the highest published sequence.
5. Every ≤ 180 days: renew with `setDelegate`. To revoke at any time: `setDelegate(0, 0)`, or `pin(cid)`.
