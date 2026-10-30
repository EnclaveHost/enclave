// node:test of capture-observation.candidate.mjs over a scripted fetch (TEST only; no network). The pins are the
// fixture's (actual inputs + TEST decisions); every scripted response goes through the unchanged rpcClient bounds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PUBLIC_RPCS, capture } from "../capture-observation.candidate.mjs";
import { setup } from "./fixture.mjs";

const RPCS = [PUBLIC_RPCS[2], PUBLIC_RPCS[1]];                       // mainnet.base.org, blastapi (distinct hosts)
const TIP = 53300002n, N = TIP - 2n;
const qty = (n) => `0x${BigInt(n).toString(16)}`;
const header = () => ({ number: qty(N), hash: `0x${"ab".repeat(32)}`, timestamp: qty(Math.floor(Date.now() / 1000) - 4), baseFeePerGas: "0x4c4b40" });

/** Scripted provider: `edit(origin, header)` mutates the block-N header one provider returns; `idFor` may break ids. */
function scripted({ edit = () => {}, idFor = (q) => q.id } = {}) {
  const log = [], waits = [];
  const fetchImpl = async (u, opts) => {
    const q = JSON.parse(opts.body), origin = new URL(u).origin;
    log.push({ origin, method: q.method });
    let result;
    if (q.method === "eth_chainId") result = "0x2105";
    else if (q.method === "eth_getBlockByNumber" && q.params[0] === "latest") result = { number: qty(TIP) };
    else if (q.method === "eth_getBlockByNumber") { assert.equal(q.params[0], qty(N)); result = header(); edit(origin, result); }
    else if (q.method === "eth_getCode") result = "0xfe";            // synthetic: refused by the first pinned code hash
    else result = "0x";
    return Response.json({ jsonrpc: "2.0", id: idFor(q), result });
  };
  return { fetchImpl, wait: async (ms) => { waits.push(ms); }, log, waits };
}
async function refuses(s, code) {
  const f = await setup();
  const out = path.join(f.dir, "observation-capture.json");
  await assert.rejects(capture({ pinsPath: f.pinsPath, rpcs: RPCS, out, fetchImpl: s.fetchImpl, wait: s.wait }),
    (e) => { assert.equal(e.code, code, e.message); return true; });
  assert.equal(fs.existsSync(out), false, "a refusal writes nothing");
  return s;
}
const on = (which, fn) => (origin, h) => { if (origin === new URL(RPCS[which]).origin) fn(h); };

for (const which of [0, 1]) {
  test(`provider ${which} answering a different block number than requested refused`, () =>
    refuses(scripted({ edit: on(which, (h) => { h.number = qty(N + 1n); }) }), "header_mismatch"));
}
test("header without a number refused", () => refuses(scripted({ edit: on(1, (h) => { delete h.number; }) }), "rpc_header"));
test("missing header refused", () => refuses(scripted({ edit: on(1, (h) => { for (const k of Object.keys(h)) delete h[k]; h.number = null; }) }), "rpc_header"));
test("providers disagreeing on the block hash refused", () => refuses(scripted({ edit: on(1, (h) => { h.hash = `0x${"cd".repeat(32)}`; }) }), "provider_disagreement"));
test("providers disagreeing on the block timestamp refused", () =>
  refuses(scripted({ edit: on(1, (h) => { h.timestamp = qty(BigInt(h.timestamp) - 1n); }) }), "provider_disagreement"));
test("providers disagreeing on the base fee refused", () => refuses(scripted({ edit: on(1, (h) => { h.baseFeePerGas = "0x4c4b41"; }) }), "provider_disagreement"));
for (const v of ["0x06ae2f4ec", "1793300000", "-0x1", "0x", "0X6AE2F4EC", "0x0", 1793300000, null]) {
  test(`non-strict / non-positive header timestamp ${JSON.stringify(v)} refused`, () =>
    refuses(scripted({ edit: on(0, (h) => { h.timestamp = v; }) }), "rpc_header"));
}
test("uppercase / short block hash refused", () => refuses(scripted({ edit: on(0, (h) => { h.hash = h.hash.toUpperCase().replace("0X", "0x"); }) }), "rpc_header"));
test("mismatched response id refused (identity check retained)", () =>
  refuses(scripted({ idFor: (q) => (q.method === "eth_getBlockByNumber" && q.params[0] !== "latest" ? q.id + 1 : q.id) }), "rpc_identity"));

test("both provider walks run (parallel), each fully checked; a binding refusal writes nothing", async () => {
  const s = await refuses(scripted(), "codehash_mismatch");
  const codeReads = new Set(s.log.filter((r) => r.method === "eth_getCode").map((r) => r.origin));
  assert.deepEqual([...codeReads].sort(), RPCS.map((u) => new URL(u).origin).sort(), "the second walk started without waiting for the first");
});
test("per-provider pacing retained: every request after a client's first waits >= ~2500ms on that client", async () => {
  const s = await refuses(scripted(), "codehash_mismatch");
  assert.equal(s.waits.length, s.log.length - 2, "only each client's first request is unpaced");
  for (const ms of s.waits) assert.ok(ms >= 2000, `paced wait ${ms}ms`);
});
