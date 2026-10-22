# Service-index quorum: peer identity and block-header validation

Repository: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (all untracked or uncommitted). No SSH, Wine, GUI,
production, chain writes or commits.

**Preserved unchanged:** the coordinator's CLI `peersFor` in `scripts/network/service-index.mjs` (sha256 `8af1e5c1…794d`)
and `test/service-index-rpc-config.test.mjs` (sha256 `1230cbf5…9ec04`). Contract `61c16967` was not touched.

**Files changed:**
- `network/service-index.mjs` (sha256 `5bd262d5…3c08`)
- `test/service-index-quorum.test.mjs` (sha256 `72ff7d64…85a1`)
- `test/service-index.test.mjs` (sha256 `614df648…acac3`)
- one short note in `docs/network/open-participation.md`

## Changes in `network/service-index.mjs`

1. **`rpcIdentity(url)`** (new export) is the same vote rule as the CLI's `peersFor`:
   - a public URL → `host:<hostname>`: lowercase, trailing dot removed, regardless of path, query, key or port;
   - `127.0.0.1`, `localhost` or `[::1]` → `loopback:<port>`, where aliases on one port are one vote and distinct
     loopback ports are distinct test endpoints.
2. **`peerList`** (used by `readServiceIndex`, and now also by `agreedRead`) refuses:
   - fewer than 2 or more than 16 peers;
   - a non-object entry;
   - a missing client, or a client lacking `getChainId`, `getBlockNumber` or `getBlock` (`readServiceIndex` also
     requires `getCode` and `readContract`);
   - a label that is empty or not a string, and duplicate labels;
   - **duplicate client objects** ("one client cannot vote twice");
   - **duplicate transport identities**, for clients whose transport exposes a URL (viem http):
     "one endpoint cannot vote twice".

   A client without a visible URL is known by its object identity only; this is documented.
3. **`agreedRead` validates its own `peers`** with `peerList`, and requires `read`. Direct callers, including the CLI's
   `pin`/`indexState` paths, get the same distinct-vote rules.
4. **Strict block headers** (`headerOf`), on the first read and on the recheck:
   - the number is a bigint or safe integer and **equals the requested block**;
   - the hash is a string of exactly 32 bytes of hex (normalized to lowercase, so uppercase from one RPC still agrees);
   - the timestamp is a bigint or safe integer of whole seconds, from 0 to `MAX_SAFE_INTEGER/1000`;
   - `parentHash`, if present, is 32 bytes of hex.

   At the end of the read, the **whole header** must be unchanged: same number, hash, timestamp and parent. A mismatch
   reports "reorganized during the read: the block header changed"; the existing tests match its prefix.
5. **Unchanged from the last review:**
   - acceptance only on two identical full snapshots from two distinct peers;
   - per-round reader dedup and the round (generation) guard: a superseded round's answers and requests are ignored or
     refused;
   - newer-block-only retry, freshness at the start, end and acceptance, and the single deadline;
   - the existing API, pin, lookups and cursor behaviour.

## Tests

`node --test --test-concurrency=1 test/service-index-rpc-config.test.mjs test/service-index-quorum.test.mjs test/service-index.test.mjs`
→ **27 tests, 27 pass, 0 fail, 0 skipped** (2 coordinator CLI tests, 10 quorum tests, 15 anvil tests).

**In-memory fixtures** (`test/service-index-quorum.test.mjs`) now return real headers (`number`, `hash`, `parentHash`,
`timestamp`) and accept a `header(real, nth)` hook that can corrupt the first read or the recheck, plus an optional
`transport.url`. The 7 earlier tests are unchanged and pass. New tests:

- **Test 8, peer validation through `agreedRead` itself:**
  - Refused: the same client object twice, duplicate labels, a single peer, a missing client, a client lacking
    methods, a null entry, empty or numeric labels, a missing `read`.
  - Refused as one endpoint: the same public host with different keys or paths, with case, a trailing dot, a port or a
    query; `127.0.0.1:8545` with `localhost:8545`; `[::1]:8545` with `127.0.0.1:8545`.
  - Accepted as three votes: loopback ports 8545 and 8546 plus a different public host.
  - `rpcIdentity` drops the path and query (key) and the port.
- **Test 9, malformed headers:** 14 cases.
  - **First read:** wrong number (99 for 98), missing number, string number, short hash, non-hex hash, missing hash,
    negative timestamp, fractional timestamp, missing timestamp, malformed parent, non-object header.
  - **Recheck:** the timestamp, the parent or the number changed.
  - Two RPCs serving the same malformed header are both refused with the specific reason; beside two honest RPCs the
    honest pair still decides.
  - An uppercase-hex hash agrees with lowercase after normalization.
- **Test 10, one RPC never counts twice:**
  - The honest RPC answers in round 1 (block 48, stale) and round 2 (98); with a lying RPC and a broken one beside it,
    nothing is accepted. Rounds are `[48, 98]`, the evidence is honest/disagreed, low-liar/disagreed, broken/failed.
  - The same client listed twice is refused before any request (0 calls).

**Anvil suite** (`test/service-index.test.mjs`). The coordinator's CLI rule correctly refused `--rpc A.url --rpc A.url`,
and the module now refuses `[A.pub, A.pub]`. The suite therefore gives chain A a second **distinct** endpoint: a
persistent honest proxy `A2` on its own loopback port.
- Client pairs became `[A.pub, A2.pub]` (9 places) and CLI calls `--rpc A.url --rpc A2.url` (12 places).
- The ERC-1271 test, which runs on its own fresh chain, gets its own proxy in front of that chain.
- All 15 tests pass: liar, hang, wrong chain, future head and reorg cases; pagination and cursors; lookups; the pin;
  bootstrap; the CLI.

**Mutation checks.** These ran in an isolated scratch copy (`/tmp/siv-mutation-scratch`, removed). The repository
module was compared afterwards and was untouched.

| Mutation | Failing tests |
| --- | --- |
| `agreedRead` skips peer validation | 8, 10 |
| Duplicate client objects allowed | 8, 10 |
| Duplicate transport identities allowed | 8 |
| Identity keyed by host:port (the CLI rule broken) | 8 |
| Wrong block number accepted | 9 |
| Short hash accepted | 9 |
| Invalid timestamp accepted | 9 |
| Recheck compares only the hash | 9 |

Two mutations made no test fail; they are equivalent under the current structure, and both guards are kept as defense
in depth:
- **Per-round reader dedup removed.** Each peer reports at most one head and joins a round once, either at the round's
  start or when its head arrives.
- **Same-label second-answer guard removed.** For the same reason, no peer can answer twice in one round.

## Maintainer separation (stated in the doc as well)

Distinct configured origins, hostnames or ports are **not** proof of independent operators or organizations: two
hostnames can share an operator or an upstream node. This remains RPC-quorum trust, not a light client. A quorum of
colluding RPCs can still forge a snapshot. With exactly two RPCs, either one can refuse service (fail closed) but never
forge alone.
