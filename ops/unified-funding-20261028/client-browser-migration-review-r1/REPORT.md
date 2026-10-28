# client-browser-migration-r1 — TEST-ONLY browser migration harness (SOURCE ONLY; NOTHING RUN, BUILT OR SIGNED BY THE AUTHOR)

This harness runs the **unchanged** client-repair-r4 runtime modules (`migration.mjs`, `funding-client.mjs`, `v2-store.mjs`,
`chain-proof.mjs`, `util.mjs`) and the vendored v1 SDK in a **real browser**, on **real IndexedDB** with **non-extractable
WebCrypto keys**. The migration is interrupted and resumed across a **page reload**. The backend is root's reviewed
ten-app native rig: an owned loopback Anvil, native P-256, the actual composed relay over HTTP with one TxQueue, public
Anvil fixture keys and mock USDC.

Nothing here touches:
- r4, client-native-r1, native-host-r1, activation-r1 or `source/`;
- the served wallet files or production;
- any real wallet or provider.

**Correction to r4's REPORT.md (not edited there):** its claim that the live Base record is `apps = []` is false. Root reports the real Base old session reads `anyApp = true, apps []` at block 53211722. A persisted signed grant must never be reconstructed from chain flags. This harness opens its own explicit `["*"]` TEST original and compares that persisted grant to the chain.

## Files

| Path | What |
|---|---|
| `harness/server.mjs` | one Node process per run, owning everything it starts: Anvil, the ten-app rig, the composed relay, the page origin and the fixed test routes |
| `page/index.html` | the TEST-ONLY page with **Start**, **Continue** and **Delete this run's TEST databases** buttons, `#status[data-result]`, `#stages` (one `li[data-result]` per stage) and `#log` |
| `page/harness.mjs` | the page module (bundled to `page/dist/harness.js` by root); imports r4 and the SDK by relative path |
| `generated/HARNESS-INPUTS.json` | hash template (all `null`) for the page, its source and the bundle; the server refuses to start until root fills it |

## What the server does

Every step below is gated; any failure stops the server.

1. **Hash gates:**
   - native-host-r1 `FIXTURE-STAGING.json` (relay, codec, viem, artifacts) and activation-r1 `PREPARE-MANIFEST.json`;
   - client-repair-r4 `generated/NATIVE-INPUTS.json` (root-filled: r4 libs, SDK bundle, viem, `SessionVault.json`, the `MockUSDC3009Fiat` source and artifact);
   - this harness's `HARNESS-INPUTS.json`.
2. **Owned Anvil** (`127.0.0.1`, chain id 8453, osaka, `--slots-in-an-epoch 1` as in root's ten-app fixture, no code-size override). Before any state change it asserts:
   - a loopback RPC literal;
   - `anvil/` client version, chain 8453, and that the public keys are Anvil dev accounts;
   - native P-256 at 0x100 accepts a real signature, refuses a tampered one, and has no code etched.
3. **Root's ten-app rig, unchanged:**
   - the native-host-r1 deploy order, the original `SessionVaultFactory` and the successor factory;
   - 10 wallet-held deployments of 10 distinct TEST app ids (`client-native-r1 TEST app 0..9`), partitioned `metal = {app0, app9}` and `nucbox = {app1..app8}`;
   - the fixed TEST fee policy; `createSessionsService` with one TxQueue and the public relayer key.
4. **One loopback origin**, Host header pinned to `127.0.0.1:<port>`. CSP is `default-src 'none'; script-src 'self'; connect-src 'self'; …; frame-ancestors 'none'`, with no-store, nosniff, no CORS and a 64 KiB body cap. Exact routes only:
   - `GET /`, `/index.html`, `/dist/harness.js` (hash-gated);
   - `/v1/sessions/*` → the real composed relay. **Labelled fault:** the reply of the *first* `POST /v1/sessions/funding/open` is lost after the real service handled it, so the open lands but the browser sees a dropped connection.
   - `POST /rpc` → the owned Anvil only. Single requests only; read methods `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_call`, `eth_getCode`, `eth_getLogs` (no send, no `anvil_*`/`evm_*`).
   - `GET /test/fixture/config` (public identities and TEST terms) and `GET /test/fixture/status` (signature prompts, relay hits, dropped replies, recorded DB names).
   - `GET /test/fixture/gas-session/<sid>` (read-only successor `sessionOf`).
   - `POST /test/fixture/tick`: one `evm_mine`, capped at 50. Its only purpose is a fresh pinned block after an idle reload, because the client refuses blocks older than 120 s.
   - `POST /test/owner-sign`: the **TEST fixture signer**, described below.
   - `POST /test/verify-api`: the host's real `verifyApiRequest` on one fixed probe URL, scope `api.status`.
   - `POST /test/record-dbs`: logs the page's two random TEST DB names (format-checked, never opened server-side).
5. **Lifecycle:**
   - `SIGINT`/`SIGTERM`/fatal error/`maxSeconds` (default 600, range 30–1800) closes the server, stops **only the Anvil this process spawned**, and deletes its temp dir;
   - no other process is touched.

**TEST fixture signer (what is and is not tested):** owner EIP-712 signatures are produced server-side with the **public Anvil owner key**. They are allowed only when all of the following hold:
- the address is the fixture owner;
- `domain.chainId` is 8453 and the owned chain still answers `0x2105`;
- `verifyingContract` is the owned fixture's legacy vault (`Enclave Sessions`/`1`: `SessionGrant`, `Terminate`), successor vault (`Enclave Sessions`/`2`: `SessionGrant`, `Terminate`, `Withdraw`) or mock USDC (`USD Coin`/`2`: `ReceiveWithAuthorization`);
- the type is that domain's allowlisted primary type, and there are at most 12 prompts.

The page reaches it through an EIP-1193-shaped object that answers only `eth_signTypedData_v4`. **This tests the client's typed-data construction, recovery checks and prompt count. It does not test a real wallet, its UI or a real user's key.** No `window.ethereum` and no provider discovery are used.

## What the page does

**Start**, in a fresh tab:
1. Records two **random** TEST DB names: `client-browser-migration-r1-TEST-legacy-<16hex>` (SDK `IndexedDbStore`) and `client-browser-migration-r1-TEST-v2-<16hex>` (r4 `IndexedDbV2Store`). They are shown on the page, stored in sessionStorage and logged by the server. `enclave-sessions` and `enclave-funding-v2` are refused.
2. Runtime is verified by r4 `verifyRuntime` (code hashes, cross-pins, `/funding/config`) through the **default** `relayClient(origin)`.
3. The **original 30 USDC session** is opened as the site does it:
   - SDK `newSessionKey` with a non-extractable key in real IndexedDB, and an **explicit `["*"]`** grant;
   - fixture-signer grant + EIP-3009 deposit, then HTTP `/open` and `completeSession`;
   - the record is reloaded from IndexedDB (CryptoKey, non-extractable, pkcs8 export refused);
   - on chain it is live with the wildcard, 30 USDC; the owner wallet is down 30.
4. Fresh scope (10 apps, partition required), evidence (the persisted grant equals the chain), and plan:
   - TEST terms 29 legacy + 0.8 over 8 apps + 0.2 over 2 apps;
   - the same legacy key; two fresh non-extractable gas keys; the journal lives in real IndexedDB.
5. **Signs only** terminate + replacement grant/deposit + the first gas grant/deposit, exactly 5 prompts.
6. Runs the migration:
   - terminate and the replacement are proven and **adopted**, and the replacement record (same key, 29, wildcard) is in IndexedDB;
   - the active pointer moves;
   - the first gas open's reply is lost, so that step stays **`admitted` with its observed block and no txHash: the persisted gas intent**. The run stops.
   - It asserts one gas open was sent and one reply dropped, then prints **PASS: reload the page, then click Continue**.

**Reload, then Continue:**
1. Asserts the document was loaded by a reload; in-memory signatures are gone. Opens new connections to the same TEST DBs.
2. Reconcile proves the interrupted gas open from chain logs, with **no new signature and no resend** (both asserted from server counters).
3. **Signs only** the second gas part (2 prompts) and finishes. It asserts:
   - 7 migration prompts in total, each type once in order;
   - sends: `/open` 2 (original + replacement), `/owner` 1, `/funding/open` 2.
4. **Conservation:** the owner is down exactly 30 since Start; the legacy vault holds 29 and the successor vault 1.
5. **Same legacy key / API capability:**
   - the replacement record has the original key hash, and the original record is still present;
   - the host's real `verifyApiRequest` accepts the replacement (wildcard) and refuses the terminated original with 401;
   - on chain the replacement is live, wildcard, 29.
6. **Separate finite grants on chain:** nucbox has exactly its 8 apps, `anyApp = false`, 0.8; metal has exactly its 2 apps, `anyApp = false`, 0.2; the scopes are disjoint.
7. **All ten apps funded** with real P-256 `gas.fund` through `selectGasRecord` (keys loaded from IndexedDB), with codec settlement on canonical receipts. Exactly 10 executes. A cross-app quote is refused (`app_not_granted`).

**Delete:** removes only this run's two TEST databases (prefix-guarded) and its sessionStorage entry.

## Setup / serve / test (root)

1. Review `harness/server.mjs`, `page/index.html` and `page/harness.mjs`.
2. Bundle with the existing esbuild. I did not locate or verify the binary.
   ```
   cd unified-funding-20261028
   <existing esbuild> client-browser-migration-r1/page/harness.mjs --bundle --format=esm --platform=browser \
     --outfile=client-browser-migration-r1/page/dist/harness.js
   ```
3. Review the bundle and fill `generated/HARNESS-INPUTS.json` with the sha256 (hex) of `page/index.html`, `page/harness.mjs` and `page/dist/harness.js`.
4. Serve under the shared queue and guard (planned ≤ 768 MiB / 1 CPU / 300 s of execution):
   ```
   node client-browser-migration-r1/harness/server.mjs 0 600
   ```
   It prints `TEST ONLY http://127.0.0.1:<port>/`. Ctrl-C or SIGTERM stops it and its own Anvil.
5. With CUA, in a fresh tab or profile on that origin:
   1. click **Start** and wait for `#status` = `PASS: interrupted as designed …`;
   2. reload with F5;
   3. click **Continue** and wait for `#status` = `PASS: resumed after reload …`;
   4. optionally click **Delete this run's TEST databases**, then stop the server.

   Every stage is listed with `data-result` PASS/FAIL. The server log records the DB names and each fixture signature.

## Limitations (honest)

- **Not run, not bundled, not measured.** Memory, CPU and the 300 s budget are estimates; idle server memory is not measured.
- **Signing:** the fixture signer is not a wallet, so real wallet UX, prompts, rejection and contract wallets are untested.
- **One browser context:** cross-tab CAS is covered only by the separate client-native-r1 self-test.
- **Not exercised here** (root's Node native tests cover them): reorg refusal, intake-off owner controls, relay restart from durable JSON, a real HTTP 202 pending reply, void/re-arm on chain time, and `requireFinal`.
- **Mocks:** the DEX, USDC (with the added `AuthorizationUsed`), key attestations and the fixed TEST fee policy. The 29 / 0.8 / 0.2 split and the 8 + 2 partition are TEST terms. The approval object is a TEST approval.
- **Fixture-only server helpers:** `/test/fixture/tick` (empty blocks) and `/test/fixture/gas-session` (a read the browser bundle has no successor ABI for).

## Proposed runtime-module changes

None are required; the harness uses r4 unchanged. Nothing proposed weakens a canonical, reorg, finality, intake or owner-control check.

## Required root review

- **The signing route's restrictions:** owner only; chain 8453; the owned legacy vault, successor vault and mock USDC domains; allowlisted types; at most 12 prompts.
- **The RPC allowlist and the single labelled dropped reply.**
- **That the page never reaches outside its own origin.**
- **Hashes:** fill them after review; nothing here is qualified by being listed.
