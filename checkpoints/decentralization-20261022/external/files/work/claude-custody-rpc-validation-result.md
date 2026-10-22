# Custody RPC quorum: canonical host identity and strict reader configuration

Repository: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted changes on top of `e7dac661`).
- **Not done:** no crypto, DKG, vault-policy, bundle or release-build changes; no production, SSH, Wine, GUI, chain
  writes or commits.
- **Mutations:** run only in an isolated scratch copy (`/tmp/cq-mutation-scratch`, removed); the repository files were
  compared afterwards and were untouched.

| File | sha256 |
| --- | --- |
| `custody/v2/quorum.mjs` | `412e5f50…b690` |
| `custody/v2/chain.mjs` | `94bbc03e…7dae` |
| `test/custody-v2-chain-quorum.test.mjs` | `883de0c4…80cd` |

## Defect

`createQuorumReader` compared `new URL(transport.url).hostname` directly, and `createChainReaderV2` did the same for
`rpcs`. `rpc.example.org` and `rpc.example.org.` (trailing dot) therefore counted as two hosts, and so did one host on
two ports. One RPC configured under two names could supply two votes toward a majority: with three configured
clients and `minAgree` 2, one host twice decides alone.

## Fix

1. **`rpcIdentity(url)`** (new export): one public host is one vote.
   - The identity is `host:<hostname>`, lowercased, trailing dot removed, regardless of port, path, query or key.
   - Loopback test chains (`127.0.0.1`, `localhost`, `[::1]`) use `loopback:<port>`: aliases on one port count once,
     and distinct test ports are separate.
   - A URL that is invalid, not http(s), or carries credentials is refused.

   This matches the service-index and CLI rule.
2. **`checkRpcUrls(rpcs)`** (new export), used by `createChainReaderV2`: 1–16 URLs, each a distinct `rpcIdentity`.
   It replaces the raw-hostname check.
3. **`createQuorumReader` configuration** is validated before any request:
   - `clients` must be an array of 1–16 (`MAX_RPCS`) entries;
   - each client must be an object with `getBlockNumber` and `getBlock`, plus `getChainId` when a chain id is pinned;
   - **duplicate client objects** are refused;
   - an **exposed transport URL** must be a string and a valid http(s) URL without credentials, and is identified by
     `rpcIdentity`; duplicates are refused;
   - custom transports without a URL (the existing fixtures) are known by object identity only.
4. **Finite, bounded policy:**
   - `minAgree`: an integer strict majority, at most the client count;
   - `confirmations`: 0–1000;
   - `timeoutMs`: 1–300000;
   - `maxAgeSec`: 0–604800 (7 days);
   - `maxFutureSec`: 0–3600;
   - `chainId`: null or a positive safe integer;
   - `now`: must be a function;
   - `checkpoint`: null, or an object with `load` and `save`.
5. **Freshness after persistence.** `commit` already rechecked freshness and rollback after waiting for earlier
   commits. It now also rechecks freshness **after** `checkpoint.save`, so a slow durable write cannot return a
   snapshot that went stale while it was being persisted. The high-water mark stays at that genuine agreed block, so
   the floor is never lowered.

**Audit of the rest, unchanged and still correct:**
- **Deadlines:** each head request and each read is bounded by `timeoutMs`, so a decision takes at most about two
  timeouts plus serialized persistence.
- **Height selection:** the height is the `minAgree`-th highest head; it never walks back.
- **Header checks:** the full header (number, hash, timestamp) is fingerprinted before and after each read.
- **Commits:** serialized, with rollback, same-height-fork and timestamp-regression checks against the durable
  high-water mark.
- **Concurrency:** concurrent reads cannot return an older snapshot after a later one was persisted.
- **Measured pins:** the custodian's measured RPCs (`mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org`,
  `base.public.blockpi.network`) remain four distinct identities.

## Tests (`test/custody-v2-chain-quorum.test.mjs`)

The existing 8 tests are unchanged in substance. The one fixture that passed a checkpoint with only `load` (to test
unreadable checkpoint content) now also has a no-op `save`, which the new constructor rule requires; it still tests
that content check.

New tests:
- **Canonical aliases** count once, through both `createQuorumReader` and `createChainReaderV2`, with 2 and with 3
  peers:
  - a trailing dot (the reported alias), case, a port, and path+key+query+dot together;
  - `127.0.0.1:8545` with `localhost:8545`, and `[::1]:8545` with `127.0.0.1:8545`;
  - three clients that are two hosts are refused.

  Distinct public hosts and distinct loopback ports are accepted.
- **Invalid configuration** is refused before any request:
  - client lists: empty, `null`, array-like, or 17 clients;
  - malformed clients (null, missing methods, a string);
  - exposed URLs: non-string, invalid, `ftp:`, or carrying credentials;
  - a missing `getChainId` only when a chain id is pinned;
  - non-majority, fractional or string `minAgree`;
  - out-of-range or non-finite policy values (confirmations, timeouts, ages, future skew), a bad chain id or clock,
    and malformed checkpoints;
  - bad `rpcs` lists.

  Plain custom-transport fixtures still read.
- **Stale after persistence:** a 200 s durable write gives `chain_stale`; the persisted floor is the agreed block,
  and a later lower read gives `chain_rollback`.

**Runs:**
- `node --test --test-concurrency=1 test/custody-v2-chain-quorum.test.mjs test/custody-v2-host-ownership.test.mjs test/custody-v2-release-authority.test.mjs`
  → **16 tests, 16 pass** (twice).
- The anvil custody suites that build these readers (`custody-v2-e2e`, `custody-independent-genesis`,
  `custody-v2-independent-{lifecycle,governance,identity}`, `custody-independent-admission`) → **15 tests, 15 pass**.

**Mutation checks** (isolated copy):

| Mutation | Failing test |
| --- | --- |
| Trailing dot not normalized (the reported defect) | 9 |
| Public port counted as a separate host | 9 |
| Loopback aliases not merged | 9 |
| Duplicate client objects allowed | 8 |
| Non-string exposed URL ignored | 10 |
| Maximum client count removed | 10 |
| Malformed clients accepted | 10 |
| Policy upper bounds removed | 10 |
| No freshness recheck after persistence | 11 |
| `chain.mjs` back to raw hostnames | 10 |

## Custody image repeatability

`custody/v2/quorum.mjs` and `custody/v2/chain.mjs` are bundled into `/opt/custodian/custodian.mjs`. This source change
therefore changes the custodian bundle, the initramfs and the SNP launch measurement of any image built from this
**new** revision. The repeatability evidence recorded in `5d82c1de` (two clean builds of commit `78acfcc6`, initramfs
sha256 `ced2e084…709e`, launch measurement `c3f7f01d…99f0`) remains valid for **that old commit only**. It does not
describe an image built from this revision. A new revision needs its own clean-checkout repeatability builds, review
and pins before any operator use. Nothing was rebuilt here.

## Notes

- **Not organizational independence:** distinct configured hosts are separate endpoints, not proof of separate
  operators or organizations. This remains RPC-majority trust.
- **Custom transports without a URL** are only checked by object identity. A caller building such clients must ensure
  they are separate endpoints.
