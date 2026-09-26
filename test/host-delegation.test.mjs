// relay/host-delegation.mjs against its pinned vectors (test/fixtures/host-delegation-vectors.json): the SAME verdicts the
// node's copy must reach (enclave-87's (B): one format, one set of checks, relay and node alike).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyDelegation, parseDelegation, delegationText, servedOwners, attachMessageV2, MAX_DELEGATIONS } from "../relay/host-delegation.mjs";

const V = JSON.parse(fs.readFileSync(new URL("./fixtures/host-delegation-vectors.json", import.meta.url), "utf8"));

test("every vector reaches its pinned verdict", async () => {
  assert.ok(V.cases.length >= 15);
  for (const c of V.cases) {
    const v = await verifyDelegation(c.delegation, c.context);
    assert.equal(v.ok, c.expect.ok, `${c.name}: ${JSON.stringify(v)}`);
    if (c.expect.ok) assert.equal(v.owner, c.expect.owner, c.name);
    else assert.ok(String(v.reason).includes(c.expect.reason), `${c.name}: ${v.reason}`);
  }
});

test("the exact text is canonical and round-trips; any variant is refused, never normalized", () => {
  const f = parseDelegation(V.exactText);
  assert.equal(f.error, undefined);
  assert.equal(delegationText(f), V.exactText);
  assert.equal(V.exactText.split("\n").length, 7);
  assert.ok(parseDelegation(V.exactText.replace("chain: 8453", "chain:  8453")).error, "a double space is refused");
  assert.ok(parseDelegation(V.exactText + "\nextra: 1").error, "an extra line is refused");
  assert.throws(() => delegationText({ ...f, box: "bad name!" }), /box is not a tunnel name/);
});

test("served owners = the operator plus each VALID delegation's owner; invalid ones are listed with a reason, never fatal", async () => {
  const good = V.cases.find((c) => c.name === "good: 90 days"), bad = V.cases.find((c) => c.name === "other box");
  const s = await servedOwners([good.delegation, bad.delegation, { message: 1 }], good.context);
  assert.deepEqual(s.owners, [V.keys.owner, V.keys.operator].sort());
  assert.equal(s.refused.length, 2);
  // no operator = nothing served, not even a delegation's owner
  const none = await servedOwners([good.delegation], { ...good.context, operator: "" });
  assert.deepEqual(none.owners, []);
  // a flood is capped
  const many = await servedOwners(Array(MAX_DELEGATIONS + 3).fill(good.delegation), good.context);
  assert.ok(many.refused.some((r) => /more than/.test(r.reason)));
});

test("attach message v2 binds the name, the nonce, the transport key and the EK certificate", () => {
  const a = V.attachMessageV2;
  assert.equal(attachMessageV2(a.name, a.nonceB64, a.keyFp, a.ekCertSha256), a.text);
  assert.equal(a.text, `enclave-tunnel-attach/2:${a.name}:${a.nonceB64}:${a.keyFp}:${a.ekCertSha256}`);
});
