# IPNS release-anchor production cutover

This tool moves the production ipns-publisher, for name `k51qzi5uqu5dma8l0…afe9b52` and deployment `0xd9798e4c…`,
from today's release authority to the on-chain ReleaseAnchor. Today's authority is a mutable text file at
`https://ipfs.enclave.host/site-root`, re-read every 4 h.

The name, the key, the delegates and the DHT/IPNI settings stay as they are.

**What the tool does not do:**
- it never signs or sends anything;
- every transaction it prints is unsigned, for the owner's own wallet or signer;
- it never writes CI secrets.

The contract and its tools are in [`../ipns-release-anchor`](../ipns-release-anchor). The publisher's reader is
[`ipns-publisher/src/anchor.rs`](https://github.com/EnclaveHost/enclave-apps/blob/main/ipns-publisher/src/anchor.rs) in
the enclave-apps repository.

## Commands

```sh
# 1. plan: agreed reads (k-of-n, one blockHash) of the production record, the IPNS floor and the mirrors
node cutover/cutover.mjs plan --config cutover/production-cutover.json --out plan/production [--delegate 0xCI…] [--wasm FILE]

# 2. status, as often as needed: which steps are done, and the ONE next unsigned transaction
node cutover/cutover.mjs status --plan plan/production/plan.json            # exit 0 complete, 10 pending, 20 blocked

# rollback, from the activated state: the one multicall that restores the pre-cutover appRef and envelope
node cutover/cutover.mjs rollback --plan plan/production/plan.json
```

## Plan outputs

`plan` writes the following to `--out`:

| File | What it holds |
| --- | --- |
| `plan.json` | the preconditions it checked, the expected outcomes, and the fee estimates |
| `publisher-config.json` | the new `ENCLAVE_CONFIG`: the current one with `value` removed and `releaseAnchor` added |
| `version-template.json` | the catalog template for the new version (the running version's, unchanged) |
| `anchor-deploy-calldata.hex` | the CREATE2 deployment; its sha256 is pinned in the plan |

## Steps (`status` derives each one from chain state, never from memory)

| Step | Who | What | Done when (read at the agreed block) |
| --- | --- | --- | --- |
| publish-version | owner (the catalog publisher of `ipns-publisher`) | `enclave publish …` with the reviewed component; the CLI uploads it and calls `publishVersion` | the catalog lists the component CID, approved, not yanked |
| deploy-anchor | any funded account (the owner by default) | a call to the canonical CREATE2 deployer `0x4e59…4956c`; the constructor fixes the owner, nameHash and initial CID | the code at the planned address hashes to the planned codeHash, with the right nameHash and owner |
| set-delegate | owner | `setDelegate(CI delegate, now + ~180 days)` | `state().delegate` is the delegate, with ≥ 7 days left |
| fund-delegate | owner (or anyone) | an ETH transfer of the shortfall for `fundReleases` releases | the balance covers `minReleases` releases |
| activate | owner | ONE ledger `multicall(setAppRef(new version), setConfig(new envelope))`, or the equivalent `enclave upgrade` then `enclave config set` | `appRef` and sha256(envelope) are the planned ones |
| verify-publisher | — | — | the publisher reports `release-anchor` at `sequenceOffset + seq`, and a routing copy (not the publisher itself) holds that record |

## Safety rules the tool applies

- **No transaction while unconfirmed.** A transaction mined but not yet at the agreed depth shows as `confirming`, and
  nothing is emitted. Each emitted transaction carries the owner's nonce at the agreed block, so a lost receipt or a
  repeated run re-emits the same transaction, never a second one.
- **Every transaction is simulated first.** It is simulated with `eth_estimateGas` at every provider, and the gas limit
  is the highest estimate × 1.3. A transaction that every provider says reverts is reported `blocked`, and not emitted.
- **Changes block, never guess.** A record that changed since the plan blocks (another owner, envelope or appRef), and
  so does an anchor whose owner changed.
- **Activation waits for complete mirrors.** It is blocked until the initial CID's **whole DAG** verifies at
  `minGateways` of the gateways: each gateway's `?format=car` export goes through site-release's
  `scripts/site-release/car.mjs` `readCar`. Every block must hash to its CID and be reachable from the root, and every
  file must reassemble. The size is bounded by `maxCarBytes`, 512 MiB by default. A gateway that serves the root
  block but misses a child does not count, and the delegate's release tool applies the same check to every release.
- **Providers are told apart by host.** One public host is one provider whatever its port, path, case or trailing
  dot. This is the enclave repository's `network/rpc-identity.mjs`. The publisher's own list must also pass its
  stricter grammar: no query, credentials, escapes, or plain http except on a real loopback address. Owner-chosen URLs
  can never be counted as separate providers.
- **Another key holder blocks verification.** A record above the anchor's mapped sequence means another holder of the
  IPNS key is signing.

## What the cutover does not change

The cutover makes the measured publisher follow the anchor. It does **not** bind other holders of the IPNS key:
- any copy of the key can sign a higher sequence;
- the anchor cannot revoke a copy of the key.

The only remedies are to stop that publisher (or destroy that key copy) and to publish past it, either by raising
`sequenceOffset` or with further anchor releases. No step in this tool is irreversible: there is no `retire` and no
ownership burn.

## Tests

```sh
node --test test/cutover-fork.test.mjs   # anvil fork of Base + kubo + the reviewed component + the production 1.0.5 component
node probe/rpc-probe.mjs                 # native HTTPS: EIP-1898 code/state reads at the owner-chosen providers
node probe/wasm-probe.mjs                # the component's own reader over HTTPS, and through a loopback SOCKS5 front
node probe/production-read.mjs [--dht]   # the production record, version, config commitment and every reachable IPNS record
```
