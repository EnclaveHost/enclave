# client-repair-r4 — report (SOURCE ONLY; NOTHING RUN, BUILT, SIGNED OR SPENT BY THE AUTHOR)

r4 = the client-repair-r3 copy plus the two demonstrated client bugs fixed, one synthetic-test correction, new
regressions, and a successor native fixture. No test here has passed; root runs everything.

These were not modified:
- `client-repair-r3/`;
- `client-native-r1/`, including its root-run failure evidence, root's edits to its test and its root-filled inputs;
- `native-host-r1/`, `activation-r1/` and `source/`;
- the live wallet server and production.

## Bug 1 — legacy app scope (root native failure at `compareGrantToChain`)

**Fact (source/contracts/SessionVault.sol, `_open` loop 624-632):**
- `apps = []` stores **no ids and `anyApp = false`**: a no-app scope, not a wildcard.
- Only an entry `"*"` sets `anyApp = true`.
- 66-char hex entries are pushed literally (the vault's `parseHex32` also accepts upper case).
- Any other entry is resolved on chain through `appIdOf(book, name)`.

r3 required `anyApp === true` for `[]` and refused any non-empty scope. The root Anvil run read `anyApp = false` and failed.

**Fix (`lib/migration.mjs`):**
- **New `appScopeOf(apps)`:**
  - `[]` → `{ anyApp: false, ids: [] }`;
  - exactly `["*"]` → `{ anyApp: true, ids: [] }`;
  - distinct canonical lower-case `0x` + 64-hex ids → `{ anyApp: false, ids }` in grant order.
- **Fails closed:**
  - names (`legacy_apps_unverifiable`): no resolution is assumed;
  - upper-case or otherwise non-canonical hex (`legacy_apps_unverifiable`), even though the vault would accept it;
  - duplicates, `"*"` twice, `"*"` mixed with ids, non-strings and non-arrays (`legacy_apps_malformed`).
- **`compareGrantToChain`** now compares `anyApp` and the exact id list (order included) as part of the mirrored-field diff, alongside the unchanged key, measurement, actions, expiry, envs, period, ops, fees and `maxRateHour6` checks. A scope is never widened or narrowed to pass.
- **Unchanged:** every caller (evidence, terminate preconditions, replacement proof) and every reorg/canonical/recheck/CAS gate. Only the header comment changed in the rest of the file.

**Synthetic-test correction (documented in each file header):** `test/fixtures.mjs` `stateOf` and the r4 copy of root's `test/root-reorg.test.mjs` `stateOf` both modelled `[]` as `anyApp: true`. That misrepresented the real contract. Both now derive the scope as `_open` does: `[]` gives false and no ids, `["*"]` gives true and no ids, hex gives those ids. Root's three assertions in `root-reorg.test.mjs` are unchanged. `fixtures.setup({ apps })` gained an optional original scope; the default is `[]`, as in the live record.

**New regressions (`test/scope.test.mjs`, 7 cases):**
- the exact `[]` and `["*"]` semantics;
- fail-closed duplicates, mixed, names, upper-case and non-string entries;
- `[]` cannot adopt a wildcard chain session, and `["*"]` cannot adopt a no-app session;
- the id list must match exactly, order included;
- the other mirrored gates are unchanged;
- evidence loads an exact-empty original and refuses a chain that turned it into a wildcard, and the reverse;
- a wildcard original migrates with its wildcard intact;
- a replacement whose chain scope was widened is neither proven nor adopted.

## Bug 2 — relay wire bigints through the default client

**Fact:** the relay serialises every bigint as `"<digits>n"` (activation-r1 `sessions.mjs` line 114). The page calls `relayClient(relayRoot())` with the default fetch, and r3 parsed `JSON.parse` output as-is (`BigInt("123n")` throws). The client-native-r1 fixture hid this by wrapping `wireFetch`.

**Fix (`lib/funding-client.mjs`):** `relayClient` now applies the existing `util.normalizeWire` to every JSON response body: success, 202-pending and error (`RelayError.detail`).

`normalizeWire` rules, inspected:
- only strings matching `^(0|[1-9][0-9]{0,77})n$` lose the `n`;
- `"0x..n"`, `"12n3"`, `"-5n"`, `"007n"`, numbers, null and booleans are untouched;
- it recurses through arrays and objects;
- it is idempotent, so callers that still pass `wireFetch` are unaffected.

The wire format's one ambiguity (a free-text string such as a label that reads `"12n"`) is now explicit in a test. Requests are unchanged (plain decimals via `canon`). The page is unchanged and is fixed through this central change.

**New regression (`test/wire.test.mjs`, 2 cases):** the default `relayClient` (no wrapper) against a loopback server that uses the relay's exact serialiser, covering success, 202 and error bodies, nested arrays, untouched hashes/labels and plain-decimal requests. Also `normalizeWire`'s exact type rules and idempotence. The native fixture repeats the check against the actual relay.

## Successor native fixture — `test/native-migration.test.mjs`

This is the client-native-r1 flow with every phase and assertion kept, including root's added `reason === 2` check on the session-key sign-out. Changes:
- imports `client-repair-r4/lib/*`;
- uses the **default** `FC.relayClient(origin)` and asserts that the actual relay sends `"n"` values and that the default client returns none;
- asserts the actual scope facts:
  - the original `apps = []` session reads `anyApp = false` with no ids;
  - the evidence and plan keep `[]`;
  - the replacement on chain is `anyApp = false` with no ids.

Unchanged and still exercised:
- the original contracts from native-host-r1's root-pinned staging, and the mock artifact at `client-native-r1/fixture/out/MockUSDC3009Fiat.sol/MockUSDC3009Fiat.json` (not rebuilt);
- native P-256, actual HTTP and one TxQueue;
- separate 29 / 0.9 / 0.1 TEST grants with seven owner prompts;
- lost replies on the replacement and first gas part, with a relay restart from durable JSON;
- real gas funding per app, and cross-app refusal;
- owner/intake-off controls, and the real `evm_revert` reorg refusal.

**Hashes:** the test re-verifies `native-host-r1/generated/FIXTURE-STAGING.json` and `activation-r1/generated/PREPARE-MANIFEST.json` exactly as before. Its own inputs come from **`generated/NATIVE-INPUTS.json`**, a template whose `files` values are **all `null`**, so the test refuses until root fills them. A separate `referenceOnly_rootFilledInClientNativeR1` block copies root's earlier values for files r4 did not change; no test reads it, and root must verify them. No hash is claimed for any edited file.

## File list

| r4 path | Status |
|---|---|
| `lib/migration.mjs` | **modified** (`appScopeOf`, `compareGrantToChain`, header) |
| `lib/funding-client.mjs` | **modified** (`relayClient` normalisation, import, header) |
| `lib/chain-proof.mjs`, `lib/util.mjs`, `lib/v2-store.mjs`, `lib/browser-entry.mjs` | unchanged r3 copies |
| `site-patch/*` | unchanged r3 copies (the page is fixed via `relayClient`) |
| `test/fixtures.mjs` | **corrected** `stateOf` / `chainScope`; `setup({ apps })` |
| `test/root-reorg.test.mjs` | **corrected** `stateOf` only (documented); root's assertions unchanged |
| `test/offline.test.mjs`, `test/partition.test.mjs` | unchanged r3 copies (use the corrected fixtures) |
| `test/scope.test.mjs`, `test/wire.test.mjs` | **new** |
| `root-receipt.test.mjs` | copied unchanged from r3 (r4 lacked it); imports `./lib/funding-client.mjs` |
| `test/native-migration.test.mjs` | **new** successor native fixture |
| `generated/NATIVE-INPUTS.json` | **new** hash template (nulls) |

**Browser self-test:** `client-native-r1/browser-selftest/selftest.mjs` imports `client-repair-r3/lib/v2-store.mjs`. r4 did not change `v2-store.mjs`, so that bundle needs no rebuild for r4. It is untouched.

## How root can run (bounded; under the shared queue and guards)

Offline (51 cases written: receipt 18, root-reorg 3, offline 14, partition 7, scope 7, wire 2). `wire.test.mjs` opens a 127.0.0.1-only HTTP server.
```
cd unified-funding-20261028/client-repair-r4
node --test root-receipt.test.mjs test/root-reorg.test.mjs test/offline.test.mjs test/partition.test.mjs test/scope.test.mjs test/wire.test.mjs
```

Native (owned Anvil only, as native-host-r1 r6 / client-native-r1):
```
# review r4/lib; fill generated/NATIVE-INPUTS.json `files` with sha256 (hex) of each listed path (relative to unified-funding-20261028/)
cd unified-funding-20261028 && node client-repair-r4/test/native-migration.test.mjs     # direct node, no --test runner
```

## Not shown / limits

- None of the 51 offline cases or the native flow has been run in r4.
- The native fixture still does not exercise:
  - a real HTTP 202 pending reply;
  - signature loss across a page reload mid-migration;
  - void/re-arm on real chain time;
  - `requireFinal`;
  - real Base USDC / DEX / fee policy, or production state.
- Name-scoped or upper-case-hex legacy grants are refused by design, with no resolution path implemented.
- No production terms, approval, finality permission or key/signature transport was added.
