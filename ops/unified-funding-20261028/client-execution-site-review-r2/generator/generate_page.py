#!/usr/bin/env python3
"""client-execution-site-r2 page integration generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 client-execution-site-r2/generator/generate_page.py

Writes ONLY client-execution-site-r2/candidate/ (refuses if it exists). Every input is pinned in
generated/PAGE-PINS.json (paths relative to unified-funding-20261028/; null or drift refuses).

  site/js/pages/funding.js        a COPY of the proven r2 page with the reviewed client-execution-recovery-r1 PAGE-PATCH:
                                  a "Gas payments" section (unknown / pending / on-chain-not-final rows, explicit READ-ONLY
                                  "Check status on chain"), relayBase + dispatchGuard for the payment, truthful fund
                                  messages, and a notice in the gas section. Every edit is anchored (exactly once),
                                  reversible, and marked "client-execution-site-r2".
  scripts/build-funding-vendor.mjs  a COPY of the r2 builder whose MUST list also requires reconcileGasExecution and
                                  listGasExecutions (one anchored edit).
  sdk/funding/*                   the root-prepared successor core (client-execution-recovery-r1/prepared/sdk/funding),
                                  byte for byte, verified against its own MANIFEST.json.
  ROLLBACK/<target>               the exact bytes each replaced target has in client-site-repair-r2/candidate.
  INSTALL-MANIFEST.json           per target: new (must_not_exist) / replace (replaces_sha256) / unchanged (sha256).
Unchanged and NOT output: site/js/funding/flows.js, site/js/funding/state.js (pinned; must stay exactly the r2 bytes),
site/js/core/config.js (pinned; all three FUNDING_* exports must be `= null`, else this refuses).
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # client-execution-site-r2
UF = HERE.parent
OUT = HERE / "candidate"
R2A = "client-site-repair-r2/authored"
R2C = "client-site-repair-r2/candidate"
PREP = "client-execution-recovery-r1/prepared/sdk/funding"
CORE = ["util.mjs", "v2-store.mjs", "chain-proof.mjs", "funding-client.mjs", "migration.mjs", "funding-codec.mjs",
        "gas-execution.mjs", "browser-entry.mjs", "MANIFEST.json"]
PAGE_SRC = f"{R2A}/site/js/pages/funding.js"
BUILDER_SRC = f"{R2A}/scripts/build-funding-vendor.mjs"
INPUTS = [PAGE_SRC, BUILDER_SRC, f"{R2A}/site/js/funding/flows.js", f"{R2A}/site/js/funding/state.js",
          f"{R2C}/site/js/pages/funding.js", f"{R2C}/scripts/build-funding-vendor.mjs", f"{R2C}/site/js/core/config.js",
          f"{R2C}/site/js/funding/flows.js", f"{R2C}/site/js/funding/state.js",
          f"{R2C}/sdk/funding/browser-entry.mjs", f"{R2C}/sdk/funding/MANIFEST.json"] + [f"{PREP}/{f}" for f in CORE]

M = "client-execution-site-r2"


def sub(a, b):
    return (a, b)


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


EXECUTIONS = '''// =====================================================================================================================
// client-execution-site-r2: Gas payments. This browser's UNRESOLVED gas.fund executions (unknown, pending, on chain but not
// final, reverted, superseded-not-final), scoped to the exact owner / chain / successor vault / relay / key records, each
// with an explicit READ-ONLY "Check status on chain" (reconcileGasExecution: no signature, no POST, no resend). Needs only
// the runtime pins, the chain and this browser's store: never the catalog, the sessions config or new-funding intake.
// verifyRuntime tolerates only intake-off / relay-unreachable; any other error is shown as is.
// =====================================================================================================================
const EXEC_LABEL = {
  admitted: "Admitted but not sent; a check releases it only if it was never dispatched.",
  dispatching: "Outcome unknown: it may have been processed. It is never resent.",
  unknown: "Outcome unknown: it may have been processed. It is never resent.",
  pending: "Sent; not on chain yet. It is never resent.",
  observed: "On chain, but not final yet. A check must prove finality before another payment.",
  reverted_observed: "Its transaction reverted on chain; the signed payment may still be usable until its deadline, so it stays reserved.",
  superseded_observed: "Its nonce was used by another operation; not final yet.",
};
async function renderExecutions(e, owner) {
  const box = $("#fdExec");
  let f, target, store, recs = [], entries = [];
  try {
    f = await lib();
    target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), owner);
    store = new f.IndexedDbV2Store();
    recs = ST.selectOwnRecords(await store.listKeys(), ST.controlsContextOf({ owner, chainId: CHAIN, vault: target.vault, relay: relayRoot() }));
    entries = await store.listJournal();
  } catch (err) { if (e === epoch) box.innerHTML = `<h3>Gas payments</h3><p>Not available (${errText(err)}).</p>`; return; }
  if (e !== epoch) return;
  const open = recs.flatMap((r) => f.listGasExecutions(entries, r).filter((x) => x.blocking).map((x) => ({ ...x, label: r.label })));
  box.innerHTML = `<h3>Gas payments</h3>
    ${open.length ? "" : "<p>No unresolved gas payment in this browser.</p>"}
    ${open.map((x) => `<div data-exec-row="${esc(x.id)}" data-exec-status="${esc(x.status)}"><strong>${esc(x.label || "Gas grant")}</strong> · <code>${esc(x.status)}</code> ·
      ${esc(EXEC_LABEL[x.status] ?? "Unresolved; kept reserved.")}${x.maximum ? ` · at most ${esc(usd(x.maximum.totalMaximum6))}` : ""}${x.evidence?.txHash ? ` · tx <code>${esc(x.evidence.txHash.slice(0, 12))}…</code>` : ""}
      <button class="btn" data-exec="${esc(x.id)}">Check status on chain (read-only)</button></div>`).join("")}
    ${open.length ? "<p>A new gas payment for those grants is blocked until a check resolves them. A check never signs or resends anything.</p>" : ""}`;
  box.querySelectorAll("[data-exec]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    const rpc = f.jsonRpc(APP_CATALOG_RPCS[0]);
    const relay = f.relayClient(relayRoot());
    const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS() });
    const r = await f.reconcileGasExecution({ runtime, store: FL.guardGasStore(store, g), rpc, relay: FL.guardRelayFn(relay, g),
      relayBase: relayRoot(), id: el.dataset.exec });
    return `Payment ${r.status}: ${r.verdict}${r.why ? ` (${r.why})` : ""}`;
  })));
}
'''

PAGE_EDITS = [
    before("/* ============================================================\n   /funding: owner controls, migration review/recovery, gas fund.\n",
           f"// GENERATED by {M}/generator/generate_page.py from {PAGE_SRC} (pinned). Additions are marked\n"
           f"// \"{M}\"; every other byte is the proven r2 page.\n"),
    after('  b.innerHTML = `<section id="fdControls"><h3>Your controls</h3><p>Loading…</p></section>\n',
          '    <section id="fdExec"><h3>Gas payments</h3><p>Loading…</p></section>\n'),
    after("  await renderControls(e, owner);\n  if (e !== epoch) return;\n",
          f"  await renderExecutions(e, owner);                     // {M}: never waits for intake, catalog or migration\n"
          "  if (e !== epoch) return;\n"),
    before("async function setActive(newSid, oldSid) {\n", EXECUTIONS),
    after('  const recs = ST.selectOwnRecords(await c.gasStore.listKeys(), c.ctx).filter((r) => r.status === "open");\n',
          f"  const execEntries = await c.gasStore.listJournal();   // {M}: unresolved payments of these grants\n"
          "  const execOpen = recs.flatMap((r) => c.f.listGasExecutions(execEntries, r).filter((x) => x.blocking));\n"),
    before('    <button class="btn" id="fdQuote">Get quote</button>\n',
           '    ${execOpen.length ? `<p data-exec-blocked="${execOpen.length}"><strong>${execOpen.length} gas payment(s) of this browser are not resolved yet (see Gas payments). '
           'No new payment can be quoted for those grants until a check resolves them.</strong></p>` : ""}\n'),
    sub('      scope, core: c.f, fundArgs: { runtime: c.runtime, relay: c.relay, rpc: c.rpc }, now: nowS });\n'
        '    return r.pending ? "Sent; waiting for chain confirmation" : `Funded: ${usd(r.settlement.actual.totalDebit6)} used`;\n',
        f'      scope, core: c.f, fundArgs: {{ runtime: c.runtime, relay: c.relay, rpc: c.rpc, relayBase: relayRoot(),   // {M}\n'
        '        dispatchGuard: () => g.check("sending the payment") }, now: nowS });\n'
        '    return r.pending ? "Sent, not on chain yet: see Gas payments (it is never resent)"\n'
        '      : r.status === "settled" ? `Funded: ${usd(r.settlement.actual.totalDebit6)} used (final on chain)`\n'
        '      : `Funded: ${usd(r.settlement.actual.totalDebit6)} used (on chain, NOT final yet: Gas payments keeps it until a check proves finality)`;\n'),
]
BUILDER_EDITS = [
    sub('  "buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep"];\n',
        '  "buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep",\n'
        f'  "reconcileGasExecution", "listGasExecutions"];   // {M}: the recovery UI calls these\n'),
]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_page.py: {m}")


def apply(text, edits, what):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"{what}: anchor occurs {new.count(a)} times (expected 1): {a[:70]!r}")
        if a not in b and new.count(b) != 0:
            die(f"{what}: replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"{what}: replacement occurs {back.count(b)} times: {b[:70]!r}")
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: reversing the edits does not give back the pinned source exactly")
    return new


def main():
    pins = json.loads((HERE / "generated" / "PAGE-PINS.json").read_text())["inputs"]
    if set(pins) != set(INPUTS):
        die(f"PAGE-PINS.json must list exactly {sorted(INPUTS)}")
    src = {}
    for rel, want in pins.items():
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
            die(f"{rel}: no root-filled sha256 (refusing)")
        b = (UF / rel).read_bytes()
        if sha(b) != want:
            die(f"{rel}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[rel] = b
    if OUT.exists():
        die("candidate/ already exists; inspect or move it first")
    # the replaced targets must be exactly what is patched; flows/state are the same bytes in both trees
    for a, c in [(PAGE_SRC, f"{R2C}/site/js/pages/funding.js"), (BUILDER_SRC, f"{R2C}/scripts/build-funding-vendor.mjs"),
                 (f"{R2A}/site/js/funding/flows.js", f"{R2C}/site/js/funding/flows.js"),
                 (f"{R2A}/site/js/funding/state.js", f"{R2C}/site/js/funding/state.js")]:
        if src[a] != src[c]:
            die(f"{c} is not byte-identical to {a}")
    config = src[f"{R2C}/site/js/core/config.js"].decode("utf-8")
    for name in ("FUNDING_RUNTIME", "FUNDING_MIGRATION_PROPOSAL", "FUNDING_MIGRATION_APPROVAL"):
        if len(re.findall(rf"^export const {name} = null;", config, re.M)) != 1:
            die(f"candidate config.js must export {name} = null exactly once")
    prep_manifest = json.loads(src[f"{PREP}/MANIFEST.json"])
    for f in CORE[:-1]:
        if prep_manifest["files"].get(f) != sha(src[f"{PREP}/{f}"]):
            die(f"{PREP}/{f} differs from the prepared MANIFEST")
    entry = src[f"{PREP}/browser-entry.mjs"].decode("utf-8")
    explicit = entry.split('} from "./gas-execution.mjs"')[0].split("export {")[-1]
    for name in ("reconcileGasExecution", "listGasExecutions", "confirmGasFund", "quoteGasFund"):
        if not re.search(rf"\b{name}\b", explicit):
            die(f"the prepared browser entry does not explicitly re-export {name}")

    page = src[PAGE_SRC].decode("utf-8")
    if M in page:
        die("the source page already mentions client-execution-site-r2")
    new_page = apply(page, PAGE_EDITS, PAGE_SRC)
    for bad in ("FUNDING_RUNTIME =", "FUNDING_MIGRATION_APPROVAL =", "rootReviewed: true", "window.ethereum"):
        if bad in new_page:
            die(f"the patched page contains {bad!r}")
    builder = src[BUILDER_SRC].decode("utf-8")
    new_builder = apply(builder, BUILDER_EDITS, BUILDER_SRC)

    outputs = {"site/js/pages/funding.js": new_page.encode("utf-8"), "scripts/build-funding-vendor.mjs": new_builder.encode("utf-8")}
    for f in CORE:
        outputs[f"sdk/funding/{f}"] = src[f"{PREP}/{f}"]
    replaced = {"site/js/pages/funding.js": f"{R2C}/site/js/pages/funding.js",
                "scripts/build-funding-vendor.mjs": f"{R2C}/scripts/build-funding-vendor.mjs",
                "sdk/funding/browser-entry.mjs": f"{R2C}/sdk/funding/browser-entry.mjs",
                "sdk/funding/MANIFEST.json": f"{R2C}/sdk/funding/MANIFEST.json"}
    r2_manifest = json.loads(src[f"{R2C}/sdk/funding/MANIFEST.json"])
    files = dict(outputs)
    for t, rel in replaced.items():
        files[f"ROLLBACK/{t}"] = src[rel]
    for p, b in files.items():
        f = OUT / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    install = {"schema": f"{M}-install/v1",
               "note": "Install into client-site-repair-r2/candidate (or its source counterpart) ONLY after root review. A replaced target "
                       "must still have replaces_sha256; a new one must not exist; an unchanged one must still have sha256. Then rebuild "
                       "site/vendor/funding.js with the copied scripts/build-funding-vendor.mjs (it now also requires the recovery exports). "
                       "Rollback: restore every replaced target from ROLLBACK/<target>, delete every new target, rebuild the bundle. "
                       "Every FUNDING_* value stays null (checked).",
               "inputs": pins, "targets": {}}
    for t, b in sorted(outputs.items()):
        name = t.split("/")[-1]
        if t in replaced:
            install["targets"][t] = {"action": "replace", "sha256": sha(b), "replaces_sha256": sha(src[replaced[t]]), "rollback": f"ROLLBACK/{t}"}
        elif t.startswith("sdk/funding/") and r2_manifest["files"].get(name) == sha(b):
            install["targets"][t] = {"action": "unchanged", "sha256": sha(b)}
        else:
            install["targets"][t] = {"action": "new", "sha256": sha(b), "must_not_exist": True, "rollback": "delete"}
    for t in ("site/js/funding/flows.js", "site/js/funding/state.js"):
        install["targets"][t] = {"action": "unchanged", "sha256": sha(src[f"{R2A}/{t}"])}
    (OUT / "INSTALL-MANIFEST.json").write_text(json.dumps(install, indent=2) + "\n")
    print(json.dumps({t: v["action"] for t, v in install["targets"].items()}, indent=2))


if __name__ == "__main__":
    main()
