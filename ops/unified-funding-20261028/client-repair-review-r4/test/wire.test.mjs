// UNREVIEWED, NOT RUN. client-repair-r4 relay WIRE regression through the DEFAULT relayClient (globalThis.fetch, no
// wrapper) against a loopback HTTP server that serialises exactly like the relay: activation-r1/generated/relay/
// sessions.mjs line 114, `const ser = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))`.
// The native fixture (test/native-migration.test.mjs) repeats this against the ACTUAL relay.
// Run (root, after review): node --test test/wire.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { relayClient } from "../lib/funding-client.mjs";
import { normalizeWire } from "../lib/util.mjs";

const ser = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));   // the relay's serialiser
const HASH = `0x${"ab".repeat(32)}`;

async function relayLike(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      const send = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(ser(o)); };
      if (req.url === "/v1/sessions/funding/config") return send(200, { enabled: true, chainId: 8453, action: 10,
        adapterMaxEthOut: 50_000_000_000_000_000n, pinnedBlock: 12n, feeTiers: [500], txHash: HASH, label: "keep 12",
        nested: { list: [1n, 2n], zero: 0n } });
      if (req.url === "/v1/sessions/funding/open") return send(202, { txHash: HASH, reserved6: 7n, reason: "pending_reconciliation" });
      if (req.url === "/v1/sessions/funding/quote") return send(409, { code: "revert", error: "BudgetExceeded", detail: { have6: 3n } });
      return send(404, { code: "not_found" });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

test("default relayClient normalises the relay's n-suffixed bigints on success, 202 pending and error bodies", async (t) => {
  const { origin, seen } = await relayLike(t);
  const relay = relayClient(origin);                                // the DEFAULT fetch, exactly as the page calls it
  const c = await relay("GET", "/funding/config");
  assert.equal(c.adapterMaxEthOut, "50000000000000000");
  assert.equal(BigInt(c.adapterMaxEthOut), 50_000_000_000_000_000n);  // r3 threw here: BigInt("50000000000000000n")
  assert.equal(c.pinnedBlock, "12");
  assert.deepEqual(c.nested, { list: ["1", "2"], zero: "0" });
  assert.equal(c.txHash, HASH);
  assert.equal(c.label, "keep 12");
  assert.equal(c.chainId, 8453);
  assert.doesNotMatch(JSON.stringify(c), /"\d+n"/);

  const p = await relay("POST", "/funding/open", { amount: 5n, sid: HASH });
  assert.equal(p.pending, true);
  assert.equal(p.status, 202);
  assert.equal(p.reserved6, "7");
  assert.deepEqual(JSON.parse(seen.at(-1).body), { amount: "5", sid: HASH }, "requests stay plain decimals");

  await assert.rejects(relay("POST", "/funding/quote", {}), (e) => e.code === "revert" && e.status === 409 && e.detail.detail.have6 === "3");
});

test("normalizeWire: exact type rules (digit-only + n), idempotent; the wire format's one ambiguity is explicit", () => {
  const wire = { a: "123n", b: "0n", c: "0x12n", d: "12n3", e: "-5n", f: "007n", g: 12, h: null, i: [["9n"]], j: true };
  const once = normalizeWire(wire);
  assert.deepEqual(once, { a: "123", b: "0", c: "0x12n", d: "12n3", e: "-5n", f: "007n", g: 12, h: null, i: [["9"]], j: true });
  assert.deepEqual(normalizeWire(once), once);
  // a STRING that happens to read "<digits>n" is indistinguishable from a bigint on this wire (same as the SDK's own
  // deserialiser); callers never treat such free-text fields (labels) as authority.
  assert.equal(normalizeWire("12n"), "12");
});
