// /v1/secrets/exists answers from the relay's own record without waiting on a slow custody read (relay/secrets.js): a
// record held here makes the answer yes whatever custody says, so a custody RPC quorum that throws or hangs must not turn
// it into a 503 or a timeout (the 2026-10-21 EnclaveDNS renewal stall: its node read the unanswered probe as "hasSecrets
// unknown" and refused to renew). Without a local record nothing changes: no and unknown still come from the custody read,
// and unknown is still a 503, never a false "no secrets". The custody flag survives a prompt read (custody migrate needs it).
//   run: node --test test/relay-exists-fastpath.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-relay-exists-test-"));
process.env.SECRETS_KEY = "ab".repeat(32);
process.env.AUTH_DATA_DIR = DIR;
const { initSecrets, handleSecrets, applyPut } = await import("../relay/secrets.js");
await initSecrets();

const OWNER = privateKeyToAccount("0x" + "41".repeat(32));
const OP = privateKeyToAccount("0x" + "42".repeat(32));
const LOCAL = "0x" + "d1".repeat(32);     // has a relay-held record
const NONE = "0x" + "d2".repeat(32);      // has none
const RUNNER = "0x" + "aa".repeat(32);
const ENDPOINT = "https://enclave1.example";
applyPut(LOCAL, JSON.stringify({ set: { API_TOKEN: "local-value" } }));

// custody: "true" | "false" | "throws" | "hangs" (never settles until release()) - counted per call
let mode = "false", calls = 0, pending = [];
const release = (v) => { for (const r of pending.splice(0)) r(v); };
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.9",
  ledgerRows: async () => [{ id: LOCAL, owner: OWNER.address, runner: RUNNER, leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800) }],
  ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === ENDPOINT ? RUNNER : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async () => OP.address,
  hostEligibility: () => ({ eligible: true, reason: null }),
  custodyHeld: async () => {
    calls++;
    if (mode === "throws") throw new Error("only 1 RPCs answered");
    if (mode === "hangs") return new Promise((r) => pending.push(r));
    return mode === "true";
  },
};
const call = async (pathname, body) => { const res = {}; await handleSecrets({ method: "POST", body }, res, new URL("http://x" + pathname), ctx); return res; };
const exists = (id) => call("/v1/secrets/exists", { id });
const timed = async (p) => { const t0 = Date.now(); const r = await p; return { r, ms: Date.now() - t0 }; };

test("a local record answers yes when the custody read throws: 200, no custody flag", async () => {
  mode = "throws";
  const { r, ms } = await timed(exists(LOCAL));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { id: LOCAL, exists: true });
  assert.ok(ms < 1000, `${ms} ms`);
});

test("a local record answers yes within the short wait when the custody read hangs, and nothing leaks after", async () => {
  mode = "hangs";
  let r, ms, timer;
  try {
    ({ r, ms } = await timed(Promise.race([exists(LOCAL),
      new Promise((_, no) => { timer = setTimeout(no, 4000, new Error("no answer within 4 s while custody hangs (runners give up at 5 s)")); })])));
  } finally { clearTimeout(timer); if (!r) release(false); }
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { id: LOCAL, exists: true });
  assert.ok(ms >= 1400 && ms < 2500, `${ms} ms (want ~1500, well under the runners' 5 s)`);
  release(true);   // the abandoned read settles later: no unhandled rejection, no second response
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(r.body, { id: LOCAL, exists: true });
});

test("a local record keeps the custody flag when custody answers promptly (custody migrate depends on it)", async () => {
  mode = "true";
  assert.deepEqual((await exists(LOCAL)).body, { id: LOCAL, exists: true, custody: true });
  mode = "false";
  assert.deepEqual((await exists(LOCAL)).body, { id: LOCAL, exists: true });
});

test("no local record: custody true -> yes with the flag; custody false -> no", async () => {
  mode = "true";
  assert.deepEqual((await exists(NONE)).body, { id: NONE, exists: true, custody: true });
  mode = "false";
  const r = await exists(NONE);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { id: NONE, exists: false });
});

test("no local record and custody unknown: 503 custody_unconfirmed, never a false no", async () => {
  mode = "throws";
  const r = await exists(NONE);
  assert.equal(r.code, 503);
  assert.equal(r.body.error, "custody_unconfirmed");
  assert.equal(r.body.exists, undefined);
});

test("no local record and a hanging custody read: the probe waits for it (no short-wait default to false)", async () => {
  mode = "hangs";
  let done = null;
  const p = exists(NONE).then((r) => (done = r));
  await new Promise((r) => setTimeout(r, 1800));   // past the local-record wait
  assert.equal(done, null, "answered before custody did");
  release(false);
  await p;
  assert.deepEqual(done.body, { id: NONE, exists: false });
  mode = "hangs";
  const p2 = exists(NONE);
  await new Promise((r) => setTimeout(r, 50));
  pending.splice(0).forEach((r) => r(undefined));   // a non-true answer is not "held"
  assert.deepEqual((await p2).body, { id: NONE, exists: false });
});

test("the plaintext fetch still fails closed for a local record when custody is unknown (only the probe got faster)", async () => {
  mode = "throws";
  const ts = Math.floor(Date.now() / 1000);
  const f = await call("/v1/secrets/fetch", { id: LOCAL, endpoint: ENDPOINT, ts, sig: "00".repeat(32),
    opSig: await OP.signMessage({ message: `enclave-secrets-fetch:${LOCAL}:${ENDPOINT}:${ts}` }) });
  assert.equal(f.code, 503);
  assert.ok(!JSON.stringify(f.body).includes("local-value"));
});

test("bad ids are still refused before any custody read", async () => {
  mode = "throws";
  const before = calls;
  assert.equal((await exists("0x1234")).code, 422);
  assert.equal(calls, before);
});

test("a relay without custody answers from its record alone, as before", async () => {
  const fn = ctx.custodyHeld;
  delete ctx.custodyHeld;
  try {
    assert.deepEqual((await exists(LOCAL)).body, { id: LOCAL, exists: true });
    assert.deepEqual((await exists(NONE)).body, { id: NONE, exists: false });
  } finally { ctx.custodyHeld = fn; }
});
