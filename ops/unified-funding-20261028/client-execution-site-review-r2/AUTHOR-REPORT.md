# client-execution-site-r2 — recovery page integration and its actual-page browser harness

**Status: source only. Nothing here was run, generated, built, served or browser-tested by its author.** I used only Read,
Grep and Write, and wrote only `client-execution-site-r2/`. These were not modified:
- r4, client-site-repair-r2 (authored, candidate, tests), client-site-browser-r1 and client-execution-recovery-r1;
- `source/`, production, any wallet or funds.

Every `FUNDING_*` default stays `null`; the page generator refuses unless the candidate `config.js` exports all three as
`= null`. There is no approval or activation. The pending real deployment request remains UNKNOWN and is never resent.

## 1. Page integration (`generator/generate_page.py`, pins in `generated/PAGE-PINS.json`)

The generator applies the reviewed `client-execution-recovery-r1/integration/PAGE-PATCH.md` to a COPY of the proven r2 page.
It writes only `candidate/` and refuses if it exists.

**Edits to `site/js/pages/funding.js`:** seven anchored edits. Each anchor occurs exactly once, reversing all edits must
give back the pinned bytes, and every addition is marked `client-execution-site-r2`.
1. A provenance header.
2. A `#fdExec` "Gas payments" section in the render skeleton.
3. `renderExecutions` is called right after `renderControls`. This is before the Base check, migration and gas, and
   independent of them.
4. `renderExecutions` itself, inserted after `context()`, so `renderControls … context` stays byte-identical. It:
   - lists only this browser's records for exactly owner / chain / successor vault / relay (`selectOwnRecords` +
     `controlsContextOf`), and their blocking executions (`listGasExecutions`, exact record id + sid);
   - shows `unknown` / `dispatching` / `pending` / `observed` (on chain, not final) / `reverted_observed` /
     `superseded_observed` in plain words, with the maximum and any evidence tx;
   - offers one explicit **"Check status on chain (read-only)"** button per row. It runs inside the page's own `act` guard
     and calls the unchanged `verifyRuntime` (which already tolerates only `funding_disabled` / `relay_unreachable`; any
     other error is shown as is) and then `reconcileGasExecution` with the page's guarded store and relay.
   - It never signs, POSTs or resends, and it needs no catalog, sessions config or new intake.
5. In the gas section, the record's journal is read once and a notice is shown while any of its payments is unresolved.
   Quoting stays refused by the successor `quoteGasFund` gate.
6. The notice is rendered above "Get quote".
7. The payment now passes `relayBase: relayRoot()` and `dispatchGuard: () => g.check(…)`, and its message is truthful:
   - "Funded: … used (final on chain)" only when final;
   - "… (on chain, NOT final yet: Gas payments keeps it until a check proves finality)" otherwise;
   - "Sent, not on chain yet …" when pending.

**Other outputs:**
- `scripts/build-funding-vendor.mjs`: one edit; `MUST` also requires `reconcileGasExecution` and `listGasExecutions`.
- `sdk/funding/*`: the root-prepared successor core (`client-execution-recovery-r1/prepared/sdk/funding`, with root's
  `intent_conflict` fix), byte for byte, verified against its MANIFEST. The entry's explicit re-exports are checked.

**Install manifest** (`INSTALL-MANIFEST.json`):

| Target | Action |
|---|---|
| Page, builder, `sdk/funding/browser-entry.mjs`, `sdk/funding/MANIFEST.json` | `replace`, with `replaces_sha256` and a `ROLLBACK/` copy |
| `gas-execution.mjs` | `new` (must not exist) |
| The six core files | `unchanged` |
| `flows.js`, `state.js` | `unchanged` and not output; they must be byte-identical between r2 authored and candidate, or the generator refuses |

`config.js` is never output.

## 2. Actual-page browser harness (`harness/generate_harness.py`, pins in `generated/HARNESS-GEN-PINS.json`)

The generator derives the harness from root's QUALIFIED client-site-browser-r1 files. It writes only `out/ shell/ build/
page/` and refuses if any exists. Each delta is anchored, reversible and labelled.

**`out/server.mjs`** (from `client-site-browser-r1/out/server.mjs`, a918c882… per root's `GENERATED.json`). The deltas:
- `eth_getTransactionByHash` added to the read-only RPC allowlist;
- `POST /test/fixture/execute-fault {mode: body | gateway502}`. It is one-shot and wraps the reply of the real
  `svc.handle` AFTER real processing and mining:
  - `body` = 200 headers, then a truncated body, then the socket is destroyed. This is root's qualified technique; the
    browser cannot transparently retry it.
  - `gateway502` = a 502 text reply.
  - Every fault is counted in `executeFaults`.
- `MAX_TICKS` 150 → 250, and a temp-dir prefix.

The generator refuses unless all of these are kept exactly once:
- the unchanged no-code-size-override refusal (every other byte is still scanned for code-size, `pkill`, `killall` and
  process-group kills);
- chain 8453 / osaka / `--slots-in-an-epoch 1`;
- the loopback Host pin, the lost gas-open reply fault, the `maxSeconds` bound and the loopback listen.

CSP, ONE TxQueue, the fixture signer limits and owned-PID cleanup are unchanged bytes.

**`shell/main.mjs`** (from client-site-browser-r1). The deltas:
- the page import names the generated copy;
- pFund reads the successor journal shape and checks the page message against the proof;
- phases 12–16 (`harness/exec-phases.fragment.js`, inserted verbatim) run before the unchanged owner-controls phase.

`harness-state.js` and the six facades are copied byte for byte. The facade still re-exports whatever
`/harness/vendor/funding.js` serves, which `generated/HARNESS-INPUTS.json` maps to root's successor bundle
(`client-execution-recovery-r1/prepared/site/vendor/funding.js`, 356046 B, 5b0ee6c8…).

**`build/build-harness.mjs`:** the page path and its shell import name the generated copy, and only vendor bundles are
excluded from the exact bundle-input set. The esbuild 0.28.1 pin and the explicit resolution table are unchanged.
`generated/BUILD-PINS.json` lists the exact inputs.

**`page/index.html`:** titles and one descriptive sentence.

**New visible phases.** Each is one click; they drive the page's own buttons and check fixture counters, the real
IndexedDB journal and the chain.

| Phase | What it proves |
|---|---|
| 12 | After the normal Fund (phase 9): if the block is not yet final, the row is shown as "on chain, but not final", the gas notice appears, and Get quote is refused (`unreconciled_execute`, no `/funding/quote` POST). Then page "Check status" runs with bounded empty blocks (≤ 8 checks) until the core proves the same tx final, with no POST and no signature. |
| 13 | Fund with the reply body truncated after headers: exactly one execute POST, no prompt. IndexedDB holds `unknown` with the exact public intent (call, nonce, anchor, sid, deployment, relay) and no key or signature. The page row is `unknown`; the real debit happened once on chain; quoting is refused. Then Reload. |
| 14 | After reload the row is still there (real IndexedDB). A labelled store-level IndexedDB CAS race on a scratch id has exactly one commit (not page testing). Page "Check status" proves the exact canonical, final settlement. No execute resent, no signature; the proven debit equals the single session-balance drop and the vault USDC drop. |
| 15 | The same as 13 + 14 with a gateway 502 after real processing, without a reload. |
| 16 | Fund with an account switch, then a chain switch, at the payment's first chain read (the existing RPC hold). The click ends `context_changed`: no execute POST, no new journal entry (the guarded store refuses admission), no debit. |

Then the unchanged phase 10 (owner controls with intake off / config unavailable), 11 and 11b (null runtime: zero buttons)
run, followed by Delete.

## 3. Offline tests (`test/`)

| File | What it does |
|---|---|
| `page-generator.test.mjs` | Runs `generate_page.py` on copies of the real pinned inputs in a temp layout. |
| `harness-generator.test.mjs` | Runs `generate_harness.py` the same way. |
| `recovery-contract.test.mjs` | Exercises what the page reads, using the root-reviewed successor lib + fixtures (read-only). |
| `layout.mjs` | The shared temp-layout helper. |

**`page-generator.test.mjs` checks:**
- other lines are kept in order, and owner controls are byte-identical;
- render order, and that the recovery section is free of signing, sending and config use;
- exact guarded reconcile, and the scope selectors;
- truthful messages, and 11 guarded clicks;
- the builder's `MUST` and the byte-identical core;
- install / rollback hashes;
- refusals: drift, a null pin, a non-null `FUNDING_*`, a candidate ≠ authored, core ≠ manifest, a missing anchor.

**`harness-generator.test.mjs` checks:**
- exactly five server lines replaced and everything else kept;
- the guard once, plus the kept fixture guarantees, and a read-only allowlist;
- the fault wraps the real handling;
- shell phases, inserted verbatim, never call the core directly;
- build deltas and byte-identical copies;
- refusals: drift, a null pin, a removed guard, an existing output.

**`recovery-contract.test.mjs` checks:**
- the unknown row survives a JSON reload;
- observed stays blocking and only final clears;
- the success shape is "NOT final";
- record scoping;
- unreachable stays unknown.

A missing python3 or input **fails** these tests; they never skip.

## 4. Exact commands for root (none run by me)

1. `node --test client-execution-site-r2/test/page-generator.test.mjs client-execution-site-r2/test/harness-generator.test.mjs client-execution-site-r2/test/recovery-contract.test.mjs`
2. Fill or confirm `generated/PAGE-PINS.json`, then run `python3 client-execution-site-r2/generator/generate_page.py`.
3. Fill or confirm `generated/HARNESS-GEN-PINS.json` (the browser-r1 build driver and the fragment are null), then run
   `python3 client-execution-site-r2/harness/generate_harness.py`.
4. Fill `generated/BUILD-PINS.json` (the generated page copy and `shell/main.mjs`), then run
   `node client-execution-site-r2/build/build-harness.mjs` as the separate ~256 MiB step.
5. Fill `generated/HARNESS-INPUTS.json` (`page/index.html`, `page/dist/harness.js`), then run
   `node client-execution-site-r2/out/server.mjs 0 1500` under the shared queue (768 MiB test guard / 700 RSS / floor
   27648 / 1 CPU / no swap).
6. In a fresh Chromium profile, click: TEST Start → 1 → 2 → 3 → 4 → Reload → 5 → 6 → 7 → 8 → 9 → 12 → 13 → Reload →
   14 → 15 → 16 → 10 → 11 → 11b → Delete. Read `#hstatus` after each click.

## 5. Limitations

- **Unrun.** Syntax errors are possible. In particular, the browser phases depend on r2 toast/DOM wording, on Anvil's
  `finalized` advancing with empty blocks under `--slots-in-an-epoch 1`, and on esbuild bundling the copy as it did the r2
  page.
- **Not-final display may not be observed.** If the fund block is already final at phase 12, the not-final display is
  logged as not observable rather than asserted. Base finality latency is not measured.
- **Not exercised in the browser:** a 202 known-hash pending reply, a reverted exact call, and supersession. They are
  covered offline by client-execution-recovery-r1 only. The CAS race in phase 14 is store-level, not a page race.
- **No-hash unknown that never reached the relay:** still unknown and blocking forever by design. There is no assertion
  that it was rejected and no clearing by time or by an unused nonce. A browser case for it is not added: Chromium retries
  pre-response failures, so only the after-headers fault is used.
- **The copied builder is unused by the harness.** The harness serves root's existing successor bundle (built by r2's
  builder). The copied builder with the two extra `MUST` names has not built anything.
- **Inherited TEST DB prefix.** It is `client-site-browser-r1-TEST-`, because `harness-state.js` and the server regex are
  copied unchanged. Names are random per run, and each run gets a fresh loopback origin.
- **The recovery RPC is `APP_CATALOG_RPCS[0]`.** That is the site's existing default RPC constant, not the catalog
  service. It must serve `eth_getLogs` and `eth_getTransactionByHash`; if it does not, the check reports the error.
- **Native and production are not touched.** The native execute-fault test (root's fixed version) is unchanged and was not
  re-run. The candidate is not installed anywhere, and production activation still needs root's separate review.
