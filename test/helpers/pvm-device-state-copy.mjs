// test/helpers/pvm-device-state-copy.mjs: THE carrier-side committed-state copy assertion for a device-run fixture, shared
// so that exactly one assertion exists: the run-3 acceptance review must pass it, and the separately invoked negative
// runner (verifier/integration/run-device-2-negative.mjs) must see it FAIL on the run-2 fixture with its exact reason.
// For every exchange in capture.json, the CLI row's `after` in exchanges.jsonl and the exchange's `stateAfter` must equal
// the generation log at the generation the client's own result names (stateGen): gen, serial, policy key, successor,
// release key and the active record.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
export const COPY_FIELDS = ["gen", "serial", "policyFp", "nextPolicyFp", "releaseFp", "active"];
export function assertCarrierCopyEqualsLog(F) {
  const rd = (n) => fs.readFileSync(path.join(F, n), "utf8"), js = (n) => JSON.parse(rd(n));
  const lines = (label) => rd(`${label}.jsonl`).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const cap = js("capture.json"), rows = rd("exchanges.jsonl").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  for (const e of cap.exchanges) {
    const row = rows.find((r) => r.label === e.label), res = lines(e.label).find((l) => l.result).result, g = js(`cli-state.d/${res.stateGen}.json`).state;
    const want = { gen: res.stateGen, serial: g.serial, policyFp: g.policyFp, nextPolicyFp: g.nextPolicyFp, releaseFp: g.releaseFp, active: g.active ? { version: g.active.version, sha256: g.active.sha256 } : null };
    assert.deepEqual(row.after, want, `${e.label}: exchanges.jsonl 'after' is MISSING or wrong (carrier-side copy)`);
    assert.deepEqual(e.stateAfter, want, `${e.label}: capture.json 'stateAfter' is MISSING or wrong (carrier-side copy)`);
  }
  return cap.exchanges.length;
}
