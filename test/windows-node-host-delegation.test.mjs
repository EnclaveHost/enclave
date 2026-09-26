// The node judges an owner's delegation EXACTLY as the relay does (enclave-87's (B): one format, one set of checks).
// windows/node/host-delegation.mjs is enclave-e3's relay/host-delegation.mjs vendored byte for byte (the node ships
// without relay/), so this test (1) pins its bytes to the reviewed version, (2) compares it with relay/'s copy whenever
// that is in the tree, and (3) replays the relay's own vectors (test/fixtures/host-delegation-vectors.json) through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { verifyDelegation, parseDelegation, delegationText, servedOwners, attachMessageV2 } from "../windows/node/host-delegation.mjs";

const NODE_COPY = new URL("../windows/node/host-delegation.mjs", import.meta.url);
const RELAY_COPY = new URL("../relay/host-delegation.mjs", import.meta.url);
const V = JSON.parse(fs.readFileSync(new URL("./fixtures/host-delegation-vectors.json", import.meta.url), "utf8"));
// e3's relay/host-delegation.mjs at 8b994494 (branch relay/hvnode-owner-only). A change to either copy must change both,
// and this pin, together.
const PINNED_SHA256 = "153f9aa731014a7aabdf9c221970b085577de80bdae738bc782d35deb777888c";

test("the node's copy is the reviewed shared module, byte for byte (and equal to relay/'s when that is present)", () => {
  const node = fs.readFileSync(NODE_COPY);
  assert.equal(crypto.createHash("sha256").update(node).digest("hex"), PINNED_SHA256);
  if (fs.existsSync(RELAY_COPY)) assert.ok(node.equals(fs.readFileSync(RELAY_COPY)), "windows/node and relay copies differ");
});

test("every relay vector reaches its pinned verdict through the node's copy", async () => {
  assert.ok(V.cases.length >= 15);
  for (const c of V.cases) {
    const v = await verifyDelegation(c.delegation, c.context);
    assert.equal(v.ok, c.expect.ok, `${c.name}: ${JSON.stringify(v)}`);
    if (c.expect.ok) assert.equal(v.owner, c.expect.owner, c.name);
    else assert.ok(String(v.reason).includes(c.expect.reason), `${c.name}: ${v.reason}`);
  }
  assert.equal(delegationText(parseDelegation(V.exactText)), V.exactText);
  const good = V.cases.find((c) => c.name === "good: 90 days");
  assert.deepEqual((await servedOwners([good.delegation], good.context)).owners, [V.keys.owner, V.keys.operator].sort());
  const a = V.attachMessageV2;
  assert.equal(attachMessageV2(a.name, a.nonceB64, a.keyFp, a.ekCertSha256), a.text);
});
