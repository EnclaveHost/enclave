# Minimal /funding page patch (instructions only; NOT applied, NOT run)

Target: `client-site-repair-r2/authored/site/js/pages/funding.js`, the root-fixed version pinned at sha256
`6123b6e2…`. Root applies these edits to a copy, never to the active client-site-browser-r1 harness. Four insertions and one
replacement; each anchor below occurs exactly once in that file. `flows.js` and `state.js` stay unchanged.

The page then needs the successor bundle: run `integration/prepare.py`, install `prepared/sdk/funding`, and rebuild
`site/vendor/funding.js`. Every `FUNDING_*` value stays `null`, so on the real site nothing below is reachable (no runtime,
so no record, so no row).

## 1. A section for unresolved gas payments

Anchor (inside `render`):

```js
  b.innerHTML = `<section id="fdControls"><h3>Your controls</h3><p>Loading…</p></section>
```

Insert directly after that line:

```js
    <section id="fdExec"><h3>Gas payments</h3><p>Loading…</p></section>
```

## 2. Render it right after the owner controls

This happens before the Base check and independent of migration, intake and the catalog.

Anchor (inside `render`, the first occurrence):

```js
  await renderControls(e, owner);
  if (e !== epoch) return;
```

Insert after it:

```js
  await renderExecutions(e, owner);
  if (e !== epoch) return;
```

## 3. The recovery view and its read-only reconcile button

Insert immediately before this anchor:

```js
async function setActive(newSid, oldSid) {
```

It goes after `async function context`, so r2's source test that slices `renderControls … context` is unaffected.

```js
// =====================================================================================================================
// Gas payments (client-execution-recovery-r1): this browser's unresolved gas.fund executions, scoped to the exact
// owner / chain / successor vault / relay / key records, with an explicit READ-ONLY reconcile. Needs only the runtime
// pins, the chain and this browser's store: never the catalog, the sessions config or new-funding intake.
// Never signs, never posts, never resends; a new gas payment of that grant stays blocked until it is resolved.
// =====================================================================================================================
async function renderExecutions(e, owner) {
  const box = $("#fdExec");
  let f, target, store, recs = [], entries = [];
  try {
    f = await lib();
    target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), owner);
    store = new f.IndexedDbV2Store();
    recs = ST.selectOwnRecords(await store.listKeys(), ST.controlsContextOf({ owner, chainId: CHAIN, vault: target.vault, relay: relayRoot() }));
    entries = await store.listJournal();
  } catch (err) { box.innerHTML = `<h3>Gas payments</h3><p>Not available (${errText(err)}).</p>`; return; }
  if (e !== epoch) return;
  const open = recs.flatMap((r) => f.listGasExecutions(entries, r).filter((x) => x.blocking).map((x) => ({ ...x, label: r.label })));
  box.innerHTML = `<h3>Gas payments</h3>
    ${open.length ? "" : "<p>No unresolved gas payment in this browser.</p>"}
    ${open.map((x) => `<div><strong>${esc(x.label || "Gas grant")}</strong> · ${esc(x.status)} · nonce <code>…${esc(String(x.nonce).slice(-6))}</code>
      ${x.maximum ? ` · at most ${esc(usd(x.maximum.totalMaximum6))}` : ""}
      <button class="btn" data-exec="${esc(x.id)}">Check this payment on chain (read-only)</button></div>`).join("")}
    ${open.length ? "<p>A new gas payment for that grant is blocked until this one is resolved. Nothing is ever resent.</p>" : ""}`;
  box.querySelectorAll("[data-exec]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    const rpc = f.jsonRpc(APP_CATALOG_RPCS[0]);
    const relay = f.relayClient(relayRoot());
    const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS() });   // intake off is fine
    const r = await f.reconcileGasExecution({ runtime, store: FL.guardGasStore(store, g), rpc, relay: FL.guardRelayFn(relay, g),
      relayBase: relayRoot(), id: el.dataset.exec });
    return `Payment ${r.status}: ${r.verdict}${r.why ? ` (${r.why})` : ""}`;
  })));
}
```

## 4. Bind the execute to this relay, and check the page guard right before dispatch

Anchor (inside `renderGas`):

```js
      scope, core: c.f, fundArgs: { runtime: c.runtime, relay: c.relay, rpc: c.rpc }, now: nowS });
```

Replace it with:

```js
      scope, core: c.f, fundArgs: { runtime: c.runtime, relay: c.relay, rpc: c.rpc, relayBase: relayRoot(),
        dispatchGuard: () => g.check("sending the payment") }, now: nowS });
```

`fundFlow` spreads `fundArgs` into `core.confirmGasFund` and still wraps the relay and store with its guards, so no
`flows.js` change is needed.

## 5. Build and tests

| File | Change | Why |
|---|---|---|
| `scripts/build-funding-vendor.mjs` | Add `"reconcileGasExecution"` and `"listGasExecutions"` to `MUST`. | Optional: lets the bundle check fail loudly if they are missing. |
| `test/page-source.test.mjs` (r2) | Its "10 clicks" count becomes 11 (the new `data-exec` button). | Root updates that number; the other assertions are unaffected. |

## What this patch keeps

- **Quote and fund flow:** the proven quote binding (displayed digest, current inputs, single use) and every flow guard
  are unchanged.
- **Quote gate:** the successor `quoteGasFund` refuses while the session has an unresolved execution. The page shows that
  refusal as a toast, and the new section shows why.
- **Context switches:** a switch blocks new effects. The guarded store refuses a new entry (admission) after a switch, the
  guarded relay refuses the POST, and `dispatchGuard` stops the dispatch marker. A reconcile started before a switch may
  still record chain-proven outcomes for its own entry; that is evidence, not a new effect.
