// Who does this box say it is holding?
//
// The relay finds the box that owns a deployment by asking every live box `HEAD /x/<id>` and taking
// the first answer that is not 404 (api-relay xOwnerOf). So this answer is a FLEET ROUTING
// decision, not a local status line, and a box that overstates it takes another box's tenant.
//
// Measured on the live node, 2026-09-24, before the fix:
//   HEAD /x/0x4e62e60d…  -> 204   a deployment running on metal-iso0
//   HEAD /x/0x9eb4e600…  -> 204   one THIS box refused, for wanting a model volume it does not offer
//   HEAD /x/0xffff…ffff  -> 404   only a wholly unknown id was disowned
// The test was `host.records.has(id)`, and records hold every deployment ever considered.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../windows/node/host.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "ee-own-"));
const ID = (c) => "0x" + c.repeat(64);

function box() {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true });
  h.tracked = new Set(); h.records = new Map();
  return h;
}
const put = (h, id, status, tracked = true) => {
  h.records.set(id, { id, status });
  if (tracked) h.tracked.add(id);
};

test("a lease this box holds is here, at every stage the relay must not disown", () => {
  const h = box();
  for (const s of ["claiming", "provisioning", "running"]) {
    const id = ID(s[0]);
    put(h, id, s);
    assert.equal(h.holdsLease(id), true, `${s} must answer "here": the app may still be coming up`);
  }
});

test("a deployment this box REFUSED is not here", () => {
  const h = box();
  // exactly the live case: refused for a model volume it does not offer, and still answering 204
  const id = "0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c";
  h.records.set(id, { id, status: "refused", reason: "it needs the attested model volume qwen3.8-27b-mtp-q4-vl-gguf" });
  assert.equal(h.tracked.has(id), false, "a refusal never enters tracked");
  assert.equal(h.holdsLease(id), false);
});

test("a deployment on ANOTHER box is not here", () => {
  const h = box();
  const id = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";   // metal-iso0's
  assert.equal(h.holdsLease(id), false, "never considered: nothing to claim");
  // and not even if it were once considered and left a record behind
  h.records.set(id, { id, status: "queued", reason: "the ledger will not let this box claim it" });
  assert.equal(h.holdsLease(id), false);
});

test("a lease this box has stopped or lost is not here", () => {
  const h = box();
  for (const s of ["stopped", "failed", "queued", "refused"]) {
    const id = ID(s[0]);
    put(h, id, s);                       // even if it somehow lingers in tracked
    assert.equal(h.holdsLease(id), false, `${s} must answer 404`);
  }
});

test("tracked without a record, and a record without tracked, are both not here", () => {
  const h = box();
  h.tracked.add(ID("a"));
  assert.equal(h.holdsLease(ID("a")), false, "tracked alone is not a held lease");
  h.records.set(ID("b"), { id: ID("b"), status: "running" });
  assert.equal(h.holdsLease(ID("b")), false, "a running record this box does not track is not ours");
});

test("unknown ids and junk are refused without throwing", () => {
  const h = box();
  for (const v of [ID("f"), "", null, undefined, "nonsense", 12345])
    assert.equal(h.holdsLease(v), false);
});

test("ids are matched case-insensitively, as the routes lower them", () => {
  const h = box();
  const id = "0x" + "a".repeat(64);
  put(h, id, "running");
  assert.equal(h.holdsLease(id.toUpperCase().replace("0X", "0x")), true);
});

// the wiring: the rule is worthless if the routes still ask records.has
test("both /x routes ask holdsLease, and neither asks records.has (pinned in source)", () => {
  const agent = fs.readFileSync(path.join(ROOT, "windows/node/agent.mjs"), "utf8");
  const head = agent.slice(agent.indexOf("method === 'HEAD' && /^\\/x\\/0x"), agent.indexOf("if (APPS && /^\\/x\\/0x[0-9a-fA-F]{64}(\\/|$)/"));
  assert.match(head, /host\.holdsLease\(id\)/, "the ownership probe");
  assert.doesNotMatch(head, /host\.records\.has\(id\)/, "records hold refusals too");
  const get = agent.slice(agent.indexOf("if (APPS && /^\\/x\\/0x[0-9a-fA-F]{64}(\\/|$)/"), agent.indexOf("host.proxy(id,"));
  assert.match(get, /if \(!host\.holdsLease\(id\)\) return json\(404/,
               "the serving path too: a misrouted request must get 404, not a 503 explaining this box's policy");
});
