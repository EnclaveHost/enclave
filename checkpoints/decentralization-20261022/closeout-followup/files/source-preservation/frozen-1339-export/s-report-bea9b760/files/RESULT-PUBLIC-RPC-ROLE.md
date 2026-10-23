# Public RPC host role (RESULT-PUBLIC-RPC-ROLE, S, 2026-10-23; second round after root's allowlist review)

**Status: SOURCE + TESTED CANDIDATE. Not activated, not deployed, no production change.**
- **Not done:** no SSH, no wallet, no funds, no new contract, no chain sync, no cache allocation, no VM change, no push.
- **Not claimed:** non-DigitalOcean ingress, or a public endpoint that exists. This is public-service preparation.

## 1. Immutable commits

| repository | commit | what |
|---|---|---|
| `work/public-rpc-host-role/repo` (branch `public-rpc-host-role`) | **`36919aafe76c743272b323c8bca27871b5219ab9`** (HEAD) | test-only: cold-start stop diagnostic (§3) |
| | `4c059b997…` | **own-property lookups only** (root allowlist review): `METHODS`, `TX_KEYS`, `LIMITS`, the runner's `ROLES`; inherited-name regression tests; carriers stop diagnostic |
| | `028623069a5bcacd51b2df3b3aa483c0f93b2957` | the role, opt-in naming/ingress/publication, tests, doc |
| base | `14d1e4954cf7c9900d5d3e841a23f02de945c1b2` | F's host-service-rpc-closure candidate (git objects only; F's tree not edited) |
| report repository `work/public-rpc-host-role` | HEAD | this file, the integration note, `jobs/`, `logs/` |

**Preserved separately:**
- S's browser patch `work/browser-rpc-closure/repo` `349318a`, with the report repo at `b55ca79`. It is **not** merged here;
  it is a separate composition input.
- The earlier browser endpoint note: `work/browser-rpc-closure/NOTE-BROWSER-RPC-ENDPOINT-REQUIREMENTS.md`.

## 2. What was built

### The role: `network/public-rpc.mjs` and `network/public-rpc-config.mjs`

The rules live in a separate config module, so that the runner and privacy-agent bundles carry the validator only. That
module has no server and no main check of its own (see §4, `g1`).

- **Backend.** The operator's **own** Base node on this machine. `node` must be a loopback URL, and a remote URL is
  refused at configuration time. So this role is never a proxy to a third-party provider. Nothing in a request can name
  another upstream, and no redirect is followed or sent.
- **Methods.** Exactly the browser note's set:

  | method | accepted |
  |---|---|
  | `eth_chainId`, `eth_blockNumber` | |
  | `eth_getBlockByNumber` | `false` only |
  | `eth_call`, `eth_estimateGas`, `eth_getCode`, `eth_getBalance`, `eth_getTransactionCount`, `eth_getStorageAt` | EIP-1898 `{blockHash}` / `{blockNumber}` and tags; no `pending`, no state override |
  | `eth_getLogs` | one address, ≤ 4 topics, range ≤ `maxLogRange` (2000) |
  | `eth_getTransactionReceipt`, `eth_getTransactionByHash` | |
  | `eth_sendRawTransaction` | §5 |

  Parameters are checked strictly. `admin_ debug_ personal_ miner_ txpool_ engine_ trace_ …`, `eth_sign*`,
  `eth_sendTransaction`, `eth_accounts`, filters, subscriptions and `eth_getProof` are refused **by name** and never
  reach the node. Batches are refused.
- **Reverts** pass through unchanged: code 3, reason, `data`.
- **Honesty.** A node that is unreachable, syncing, or whose head is older than `maxHeadAgeSec` (120 s) gets 503 and
  never a stale answer. A stalled node gets 504 at the deadline, and an oversized answer gets 502.
- **Bounds.** `maxBodyBytes`, `maxResponseBytes`, `backendTimeoutMs`, `maxInFlight` and an aggregate token bucket
  (`perSecond`/`burst`). Server header and request timeouts are set.
- **CORS.** Configured dashboard origins only (or `["*"]` written explicitly). The preflight passes `POST` with
  `content-type` only; credentials are never allowed. Every other origin gets 403.
- **Proof-backed verifier (optional, loopback).** `chainVerifier` with `verifiedMethods` answers only the methods it
  proves: chainId, blockNumber, getBlockByNumber, call, getCode, getStorageAt, getBalance. They **never fall back to the
  node**. Every answer carries `X-Enclave-Rpc-Source: node|verifier` and `X-Enclave-Rpc-Host: <registry id>`.
- **Not proof to the browser.** Neither source is proof to the browser: it trusts the origin as one RPC of its quorum.
  Quorum agreement is not relabelled as proof anywhere.
- **No keys.** The role holds no key, wallet or signing method.

### Host-service integration: existing model, opt-in only

- **`roles.mjs`.** Registers `public-rpc` with **`kind: null`**. The EnclaveServiceIndex contract accepts any nonzero
  kind, but readers define kinds 1 to 8, and none is an RPC endpoint. No kind 9 is invented. The **runner** refuses
  `host.publicEndpoints` for the role and requires `hostId == keccak256(host.endpoint)`, and `advertise` never publishes
  it. Discovery is by explicit profile URL, which is already supported. The missing index advertisement is documented.
- **`host-service-names.mjs`.** `rpc-<base32(registry id)>.<zone>` (`hostRpcName`) joins `isHostServiceName`. It is not
  in `hostServiceNames()`, so the three-name set is unchanged.
- **Transport, grants, circuit runtime, provider.**
  - A host requests the RPC name (`rpc: true` in its signed service request) **only** when its `hostServices.ports` name
    `public-rpc`.
  - An exit grants it **only** when its operator set `hostServices.rpc: true`; otherwise it refuses by name.
  - A host without the role never sends the key, so every existing grant is byte-for-byte unchanged.
  - The exact-grant check in the circuit runtime is kept, not loosened.
- **`stage-tool.mjs`.** `hostServicePublication` publishes the label in route-dns `appStatic`.
- **`browser-profile.mjs --verify-chain`.** Refuses two RPCs that name the same host (`network/public-rpc-hosts.mjs`).
  Different names for one host are one vote, never two nodes.
- **Doc:** `docs/network/public-rpc-role.md`.

### Built assets (only the changed role)

`scripts/build-host-service-packages.mjs` produces the following. All five existing role packages are **byte-identical**
to F's `14d1e495` build (checked in `g2` and `f1`).

| asset | sha256 |
|---|---|
| `public-rpc.mjs` | **`aaca601bbb87aa1e4f39fd2062e541d8659cacd7c16ba998a5694e1b05307e6e`** (inputs: `public-rpc.mjs`, `public-rpc-config.mjs`, `rpc-identity.mjs`; built in `f2` from `4c059b99`; the role's sources are unchanged in `36919aaf`) |
| `public-rpc.package.json` (the pin) | **`300cdc81a4961763b2b0e8c84023f6238448e3fad02cea247af72d3354e57530`** |

The first build (`eb98beb0…` / `0d45960a…`, from `02862306`) is superseded: it lacked the own-property guards.

The package directory is a build output and is untracked, as in F's tree.

## 3. Proof (all through the shared queue, unchanged 16 GiB floor; times are the logs' end times, UTC)

Every test ran in a loopback-only user/net/pid namespace, with ssh/scp/sftp denial stubs proven first. **Backend:** reth
v2.8.0 `node --dev`:
- binary sha256 `8cdd1f35…`, genesis `test/fixtures/reth-dev-8453-genesis.json` sha256 `cc045d9d…` (chain 8453, copied
  from rpc-priority `fixture-tools`);
- the same launch flags as A's opt-in reth rig at `e32dd607b`.

| run | ended | lane, peak | result |
|---|---|---|---|
| `pk1` package build | 09:59:04 | 512, 390 MiB | 5 existing packages identical to F's; `public-rpc` new |
| `r2` `public-rpc.test` | 11:43:40 | 1024, 553 MiB | **10/10**, strict, 0 skipped |
| `g1` 11 files | 11:51:52 | 1536, 1074 MiB | 79 pass, 2 fail, 2 skipped (see below) |
| `g2` after the fixes | 11:55:19 | 1536, 1081 MiB | **41/41**, 0 skipped. The job rc is 7 only because I set `ALLOW_SKIPPED=2` for a run that skipped nothing |
| `f1` final, on `02862306` | 12:15:22 | 1536, 1087 MiB | key scan rc 0; packages as above; **174 tests: 170 pass, 2 fail, 2 skipped** (classified below) |
| `c1` classification | after `f1` | 768, 552 MiB | carriers 9/9 twice on the candidate; on baseline `14d1e495`, service-index fails identically |
| `f2` after the allowlist fix, on `4c059b99` | 12:47:26 | 1536, 1048 MiB | key scan rc 0; packages rebuilt (existing five identical to F's); **67 tests: 66 pass, 1 fail** (cold-start daemon stop, classified below), 0 skipped |
| `c2` | – | 768 | **not a result**: my diagnostic helper was inserted inside a template string (the daemon's preload source) on both trees; every daemon test failed at start on both alike |
| `c3` stop-class comparison | 13:32:20 | 768 | cold-start + carriers ×3 on the candidate and ×3 on baseline `14d1e495`, both with the stop diagnostic: candidate 2/3 clean and 1 carriers stop failure (exit 1, "privacy agent stopped during startup"); baseline 3/3 clean |
| `l1` | 10:43:05 | 256 | **not a result**: guard-stopped at 275 MiB > 256 (rerun inside `g1` and `f1`) |

**`public-rpc.test` (real reth):**
- **Reads.** chainId and head; `eth_call` at `latest`, a number, `{blockHash}`, `{blockHash, requireCanonical}`,
  `{blockNumber}`, and a **historical** block (42 versus 7).
- **Revert.** Code 3, with the `0x08c379a0` reason data.
- **Other methods.** code, balance and storage at the block hash; nonce; estimate; logs over the history; a range over
  2000 blocks refused; no address refused; receipt; tx by hash.
- **Fetches.** Only the node URL was ever fetched.
- **Raw transactions.** Refused by default, and nothing reaches the node. With `rawTransactions.propagation`, the node's
  hash is returned (`keccak(raw)`) and the receipt has status `0x1`. A replay is refused by the node and reported as an
  error.
- **Refused methods.** 17 privileged/signing/mempool/filter/proof methods; an unknown method; a batch; 413 body; -32700;
  415; 405; 404; full blocks; state override; `pending`; extra call fields; bad address and hash. None reaches the node.
- **CORS.** A 204 preflight with no credentials header; an `authorization` header gets 403; `PUT` gets 403; a foreign
  origin's POST gets 403 without an allow-origin header; the allowed origin is echoed with `Vary`.
- **Bounds.** Stall gives 504 within 3.5 s; in-flight gives 503 busy at once; down gives 503 "unreachable" and `/health`
  503; syncing and stale heads refuse; oversized gives 502; the rate limit gives 200, 200, then 429.
- **Verifier** (`test/helpers/loopback-verifier.mjs` stand-in: the verifier protocol and refusals, **no Merkle checks**;
  real proof checking is rpc-priority's E2E). Only the configured methods are labelled `verifier`. A proof failure and a
  down verifier refuse, and the node is never asked. getLogs is labelled `node`.
- **Identity.** Two names of one host are refused as one vote; two hosts give distinct ids, which says nothing about a
  shared node.
- **Configuration.** A remote node, a non-loopback bind, a secret field, verifier = node, a remote verifier, an
  unprovable method, a short propagation statement, a bad origin, and limits out of range are all refused. In the runner,
  a `hostId` mismatch and advertising the role are refused.
- **Packaged.** The packaged role under the runner: the manifest (`kind: null`, 3 inputs), no inherited environment, the
  gate's refusal stops it, and the admit restarts it.

**`public-rpc-browser.test` (Chromium, two PACKAGED roles under the runner, the unbundled site's own
`quorum.js`/`chain.js` with a saved and confirmed profile).** The page makes these calls over CORS:
- an agreed snapshot (2 of 2);
- `eth_call` at the agreed block hash (7);
- an agreed revert;
- logs, estimate, balance and code;
- a receipt through `baseRpc`.

Other results:
- **Loopback only.** No non-loopback origin was attempted.
- **CORS refusal.** A page on a disallowed origin gets a `TypeError` (CORS).
- **Node down.** The quorum refuses (0 of 2) in under 10 s.
- **Both roles front ONE reth node.** The test says so: this proves the browser path, not two independent nodes.

**Real-gate administration.** `host-service-verifier-roles` is extended: host B runs the **packaged** `public-rpc`
alongside its other roles, with the REAL platform host policy gate, carriers and service index.
- The admin's anchored **ban** stops it.
- The **unban** restarts it.
- After the AddressBook **owner migration** (`setOwner` + `acceptOwnership`), it serves under the new admin's policy.
- The ban/unban/migration test passed in `g1`, `g2` and `f1`, as did the file's other verifier-authority tests.

**Transport (`host-service-lifecycle`, real WgProvider, circuit runtime and ingress worker):**
- **Both opted in:** the exit grants the 3 names plus `rpc-<b32>`, a visitor reaches the role by that name, the other
  roles are unchanged, and a ban withdraws the grant.
- **Opted-in exit, host without the role:** the grant is exactly 3 names.
- **Host with the role, exit not opted in:** refused by name, with no mismatched grant.
- **Test fix:** the helper now opens a fresh connection per visit. The ingress routes a raw connection by its first
  Host, and Node's keep-alive agent had reused one.

**Failures, classified:**

| failure | classification | evidence |
|---|---|---|
| `g1`: `host-services-cold-start` bundle main-check counterexample | **real, caused by my first version, FIXED** | `roles.mjs` imported the server module and its main check. Split into `public-rpc-config.mjs`; passes in `g2` and `f1` |
| `g1`: the first lifecycle opt-in case | a test artifact (keep-alive reuse), FIXED | passes in `g2` and `f1` |
| `f1` carriers, `f2` cold-start "shipped bundle", `c3` carriers: the daemon's `stop()` is not exit 0 | **a test startup race, identified** (root f1 review asked for the evidence) | the diagnostic shows exit 1, `privacy agent stopped during startup`. The tests stop the agent as soon as `host services: {` is logged, but host services start BEFORE `agent.start()` finishes (authorization, proofs, status snapshot), and a SIGTERM in that window exits 1 by design. Another test in carriers accepts exactly that outcome. My diff does not touch `agent.start()` or the stop path. Counts: candidate 3 failures in about 15 runs of the two files, baseline 0 in 7. That is too few runs to separate the rates, so it is not claimed to be identical. **Suggested test fix for root/F:** wait for the agent's startup completion (its status snapshot) before stopping, or accept exit 1 with that exact message, as carriers line 123 does |
| `f1`: `service-index` "independent checker … schema-4 registry" | **pre-existing** | identical on pristine `14d1e495` (`c1`): `git show b17db9a3` is missing from these clones; F recorded it too |
| 2 skipped | env | `hosted-services-stage` needs `STAGE_TAR` (the built archive), the same skip as F's runs |

**Not run:** Windows suites beyond the two wallet-grant files included; Go builds (the `go` stub refuses; no Go source
changed); real MetaMask; a real Helios verifier.

## 4. What this does NOT provide, and the exact gates

1. **No endpoint exists.** No host runs the role, and no profile names one.
2. **HTTPS (G3).** Browsers on an HTTPS dashboard need `https://rpc-<b32>.<zone>`. The 443 side routes to the host's
   `service-tls` terminator (work/host-service-tls-20261021), which is **not composed in this tree**, and it needs a
   certificate for the name. The plain port-80 side is not usable by HTTPS pages.
3. **The node.** The operator's own synced Base node on the host (the S holder `base rpc` or equivalent), with its RAM,
   disk and L1 prerequisites. The role refuses honestly when the node is syncing or stale.
4. **Exits and DNS.** Exits whose operators set `hostServices.rpc: true`, and route-dns publication of the label. A host
   using any other exit is refused by name.
5. **Policy.** An activated platform host policy (`"off"` is not production).
6. **Independent nodes.** A profile must list ≥ 2 RPCs of **different hosts with different nodes**. `--verify-chain`
   catches one host under two names. It cannot see two hosts sharing a node, or one operator.
7. **Composition.**
   - F carries the role package and the changed shared modules into the Windows composition.
   - B keeps its loopback verifier internal (it can be this role's `chainVerifier`) and adds no duplicate proxy.
   - The changed shared modules (names, transport, wg-grants, circuit runtime, provider) change the privacy-agent and
     provider bundles. Those need the composition's own rebuild; nothing was rebuilt here except the role packages.
8. **Index.** An RPC ServiceIndex kind would be a reader convention for root to decide; no contract change is needed or
   made.
9. **Witness/proof source (root's interface gate).** `eth_getProof` and `eth_getBlockByHash` are refused. This role is
   **not** a proof source for B's witness gateway; that needs root's bounded follow-up.
10. **Wallet and bundler.** Transactions are broadcast by the wallet's own RPC, and passkey operations go through the
    account's bundlers. Both stay separate gates (the browser note).

## 5. Unresolved capabilities (listed, not dropped)

- **`eth_sendRawTransaction`** is offered only with an operator-stated route, and the role cannot verify propagation. A
  Base non-sequencer node with gossip off (and the S holder's excluded sequencer route) does not propagate.
  L1-deposit/forced inclusion belongs to E and P.
- **Receipts and lookups** for transactions sent elsewhere depend on the operator's node seeing their inclusion.
- **Pending nonce and fee quote** (`eth_getTransactionCount` at `pending`, `eth_maxPriorityFeePerGas`) are not served yet. E's
  wallet broadcast needs the nonce; root has queued it as the next scope.
- **Proof-backed answers** cover only the verifier's methods. Logs, receipts, estimates and tx lookups are node answers
  and are labelled `node`.

## 6. Root review notes in this directory (acknowledged)

- **`ROOT-ALLOWLIST-REVIEW.txt` (FIXED in `4c059b99`).**
  - `Object.hasOwn` guards for `METHODS`, `TX_KEYS` and `LIMITS`, as in root's patch, applied to the split files.
  - The related strict-map lookups were inspected, and the runner's `ROLES[...]` now uses an own-property `roleOf`.
  - Regression tests: inherited names (`constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, …) are
    refused as methods (-32601, the node never asked), as call fields (-32602), as limits and as roles.
  - The package was rebuilt (`aaca601b…`/`300cdc81…`).
- **`ROOT-F1-FAILURE-REVIEW.txt`.**
  - service-index: left as root directed. No old history is restored and registry verification is not weakened; A's
    provenance work owns it.
  - carriers and cold-start: the stop result is now recorded (code, signal, output) and identifies the startup race
    above. No lifecycle change is claimed from reruns.
- **`ROOT-PROOF-SOURCE-INTERFACE.txt` (NOT done here; the gate stands).** This role refuses `eth_getProof` and
  `eth_getBlockByHash`, which B's witness gateway needs for fresh verified state and authenticated ancestry, so **B's
  `proofSources` must not point at this role**. Bounded proof/header support (or a separate supported ingress), with an
  actual Reth+verifier composition, awaits root's follow-up. The browser note's wallet-own-RPC and passkey-bundler gates
  also remain: read routing alone does not make every feature independent.
- **`ROOT-NUCBOX-RPC-TARGET.txt` (noted for production).** NucBox is the chosen RPC deployment target, with up to 96 GB
  host allocation if needed. That does not imply that much is free.
  - The role runs wherever the host-service runner runs: the Windows host role (F's composition) or a Linux client VM on
    NucBox, with the operator's node on that same machine (loopback).
  - The 250 GB NVMe cache cap and HDD durable state are unchanged.
  - Nothing here measured NucBox capacity, and nothing touched it.

- **`ROOT-C2-HARNESS-FAILURE.txt`.** Root is correct: in `c2` my diagnostic helper landed inside the daemon's generated
  preload source and broke every daemon test on both trees. Root cancelled that batch, and its failed logs are kept. The
  helper sits in the outer test scope in `c3` and in the committed `36919aaf`.
- **`ROOT-SHUTDOWN-PHASE-REVIEW.txt`, `ROOT-ACTUAL-CANCELLATION-CONFIRMED.txt` and `ROOT-CANCELLATION-FIX-OWNER.txt`.**
  The `c3` capture (exit code 1, signal null, "privacy agent stopped during startup" after ADMITTED and STARTED)
  confirms root's controlled finding on the real daemon. The deterministic cancellation fix and its tests are **M's**
  (work/privacy-startup-cancellation-20261023, on base `4c059b99`). Nothing is duplicated here; the exit-0 assertions are
  unchanged.
- **`ROOT-WALLET-INTERFACE-REVIEW.txt` (NOT done here; this is the next scoped integration).**
  - `eth_getTransactionCount(addr, "pending")` is refused (-32602 "pending is not served"), and E's profile broadcast
    needs it before signing.
  - `eth_maxPriorityFeePerGas` is refused (-32601); E has a fallback tip.
  - The next round should add a bounded pending nonce from the operator's own node, labelled UNVERIFIED mempool state
    (not a general `pending` allowance), and possibly a strictly validated fee quote. It should be proved with the built
    wallet route through the packaged role, keeping the own-property guards and closing the proof/header gap above.

## 7. Notes delivered

- `NOTE-PUBLIC-RPC-ROLE-INTEGRATION.md`: changed files, who bundles what, and what F, B and root would carry. It is also
  placed as `NOTE-FROM-S-PUBLIC-RPC-ROLE.md` in F's `host-service-rpc-closure/` and B's
  `rpc-runtime-final-integration/`, as new files only.
- A D preservation note: `source-preservation/NOTE-FROM-S-PUBLIC-RPC-ROLE.txt`.
