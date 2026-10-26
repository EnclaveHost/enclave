# standalone-mcp-authority-stage (PREPARED, NOT RUN): an explicit local-verifier selection for the standalone / guest MCP

**Not done:** no tests, builds, queue use, network, SSH, live change or commit. Only `node --check` and `bash -n` were
run. No other stage or source branch was touched.

**Base:** `relay-consumer-source` `b6ac5d657`.

## What exists at `b6ac5d657` (read, not assumed)

- **Entry points:** `mcp/server.mjs` (stdio, loopback HTTP, remote adapter) and the measured guest bundle
  `metal/guest/mcp-server.bundle.mjs`, built from it by `scripts/build-mcp-guest-bundle.mjs`.
- **Both build each profile's chain access in `mcp/independent.mjs` `Authority`:**
  - `loadIndependentTrust` (`cli/independent.mjs`) requires an RPC list (`validateRpcOrigins`) and a quorum of at least
    2;
  - every tool read is a `Scope` over `QuorumChain`: k of n identical answers at one confirmed, fresh block.
- **The existing `chainVerifier` profile key has a NARROW meaning:** the LeaseReader management reads and host policy
  only (`independentReaderAuthority`). The quorum still serves everything else. There was **no** way to make the
  profile's own reads use the local verifier.
- **The API relay's MCP** (`relay/mcp.js` `useMcpChainClient`) is a different path and is already wired.
  `mcp/hosted-connector.mjs` (a registry `QuorumChain` from `cfg.registry.rpcs`) is out of scope and unchanged.

## The seam (3 source files + 1 test; existing APIs only)

**`cli/independent.mjs` `loadIndependentTrust({…, chainAuthority})`:**
- **Absent or `"quorum"`:** byte-identical behaviour, so the operator CLI, which never passes it, is unchanged.
- **`"verifier"`:**
  - requires `chainVerifier`, validated by the existing `chainVerifierOf` (loopback only);
  - **refuses `rpcs` or `quorum` beside it** (ambiguous mixed configuration);
  - returns `rpcs: []`, `quorum: null`, `chainAuthority: "verifier"`;
  - the pins, profile digest, USDC and confirmation checks are unchanged.
- **Anything else:** refused.

**`mcp/independent.mjs`:**
- **Profile key:** a new `chainAuthority` (the unknown-key check is kept).
- **`Authority.ready()`:** under `"verifier"` it builds the chain from **`network/chain-authority.mjs`
  `createChainAuthority({verifier, chain: base}).client`**, the established validated verifier client. There is no
  transaction backend: the MCP prepares, and the owner's wallet signs and sends.
- **New `VerifierChain`:** it implements `Scope`'s chain interface over **one client that must carry the in-process
  `VERIFIER_CLIENT` mark** (`Symbol.for`, set only by `createChainAuthority`). An ordinary RPC client or a look-alike is
  refused, so **one unverified remote can never replace the quorum**.
  - **`pickBlock`:** the chain id is checked; the target is head − confirmations, never below a block already used. A
    verifier failure is a `QuorumError` ("no other source is used").
  - **Unchanged `Scope` rules:** the block is read before and after each value (a replaced block is refused); the
    freshness window; the replay. `quorum` is 1 because the verifier's answers are proven, not voted on.
- **`Scope.summary()`:** adds `authority: "local-verifier (proof-backed; unsafe tier, no L1 finality)"` under the
  verifier only. Legacy output is unchanged.

**`mcp/independent-secrets.mjs`:** under a verifier profile, the custody v2 tools are **refused before any read**.
Custody v2 builds its own k-of-n reader, and **custody v2 stays refused** until it has its own separately qualified
measurement. Nothing is substituted.

**Unchanged:** wallet signing and admin authority (the MCP never signs), profile pins and digest checks, attestation
checks, the session factory review, and the legacy quorum.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/` (`BASE-b6ac5d657.sha256`), `candidate/` (`CANDIDATE.sha256`) | the 3 source files |
| `standalone-mcp-authority.patch` | 269 lines, 3 files + `test/mcp-independent-verifier.test.mjs`. Applies to `git archive b6ac5d657` and reproduces `CANDIDATE.sha256` exactly (checked) |

**The test (6):** the REAL `loadConfig`, `Authority`, `Scope`, `VerifierChain` and `createChainAuthority` against a
loopback verifier recorder, with an operator-format config and the repository's real contract pins.
1. **A verifier profile:**
   - the chain is a `VerifierChain`, with `rpcs: []` and `quorum: null`;
   - `registrySchema` reads 4 through the verifier;
   - the `eth_call` is pinned at head − 2 (98), and the block is read twice;
   - the summary carries the authority label.
2. **Refusals with their causes:**
   - down (`local verifier is unavailable`), with no value read;
   - stale;
   - wrong chain;
   - block replaced during the read.
3. **Ambiguous or invalid selections refused, with 0 verifier requests:**
   - `rpcs` beside the verifier;
   - `quorum` beside it;
   - no verifier;
   - a remote verifier;
   - an unknown authority.
4. **Only the marked client is accepted:** an ordinary viem client and a look-alike symbol are refused.
5. **Legacy unchanged:**
   - no `chainAuthority`, or `"quorum"`, gives a `QuorumChain` with quorum 2;
   - an existing bare `chainVerifier` keeps its narrower meaning (quorum chain; the verifier is not read when the
     profile is built).
6. **The quorum rule is not weakened:** a legacy profile without RPCs is still refused.

**Not driven by a test:** the custody v2 refusal. It sits in a non-exported helper behind the secrets tools, before any
read, and is covered by review only.

## Root job (offline; recommended queue cap **1408**)

```
./jobs/q-exit-status.sh standalone-mcp-authority 1408 unshare -rn bash standalone-mcp-authority-stage/jobs/standalone-mcp-authority-tests.sh
```

**Setup and checks:**
- fresh `--no-local` clones at `b6ac5d657` (base and candidate);
- the base files verified; the patch applied and `CANDIDATE.sha256` verified;
- `node_modules` linked with an absolute link, only if `package-lock.json` is identical;
- `node --check` on the 3 files and `mcp/server.mjs`;
- strict TAP: **exactly 70**, with 0 fail/skip/todo/cancelled.

**The 70:**

| Suite | Tree | Tests |
| --- | --- | --- |
| new `mcp-independent-verifier` | candidate | 6 |
| `mcp-independent-unit` | candidate and base | 10 + 10 |
| `mcp-independent` | candidate and base | 13 + 13 |
| `cli-combined-independent` (exercises `loadIndependentTrust`) | candidate and base | 4 + 4 |
| `chain-authority` | candidate | 10 |

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP |

The cap of 1408 is sized for four Node test processes run one at a time, without a native build. 1024 is likely
enough; 1408 leaves headroom for the `mcp-independent` suites.

## Activation gate (exact; nothing here is live, measured or qualified)

**Standalone / operator-run MCP** (`node mcp/server.mjs --config FILE`): usable as soon as
1. this patch is merged and its tests pass; and
2. the operator runs a **local verifier on loopback**, for example the host-local verifier runtime (refresh §2.4),
   which serves only after the own Base node has synced.

The profile then sets `"chainAuthority": "verifier", "chainVerifier": "http://127.0.0.1:<port>/"` and **removes**
`rpcs`/`quorum`. **No live URL is implied.**

**Guest MCP** (`metal/guest/mcp-server.bundle.mjs` in the measured control guest) **cannot use this yet.** It needs all
of these:
1. **A rebuilt guest bundle** (`node scripts/build-mcp-guest-bundle.mjs`, then `--check`) from source carrying this
   patch.
2. **A NEW measured release** of the control image containing it (a new measurement; a bundle change alters it).
3. **A verifier reachable on the guest's loopback:** the in-guest control verifier with a reviewed proof-source route.
   The `rpc-<b32>` proof route is **not live** (refresh §2.3), and a remote verifier is refused by design.
4. **A bound guest config** selecting `chainAuthority: verifier` with that loopback URL and without `rpcs`.

Until then the guest keeps its pinned profile quorum, unchanged.

**Trust and claims:**
- **No proof or SNP qualification is claimed.** The verifier is the unsafe tier, with no L1 finality, and logs prove
  inclusion only.
- **The test recorder serves no proofs:** the tests prove selection and refusal.
- **Unchanged:** lease consumers stay on HOLD, and Custody v2 stays REFUSED.
