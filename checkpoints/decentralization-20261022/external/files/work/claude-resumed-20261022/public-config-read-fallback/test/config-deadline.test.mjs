// The round deadline covers PROOF work, not just transfer: site/js/core/ipfs-car.js takes an optional cooperative check
// (default none = the runtime's behaviour, kept for the oracle) and catalog.js configFrom passes its deadline into CAR
// parse/hash/walk and re-checks around every await and before accepting. Time is a stepped test clock; WebCrypto digest is
// wrapped to COUNT calls and to step the clock at a chosen call, so "the deadline passes mid-proof" is exact and repeatable.
import "./helpers/dom-stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CID } from "multiformats/cid";
import * as F from "./car-fixtures.mjs";
let now = 1_800_000_000_000; Date.now = () => now;
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
let digests = 0, onDigest = null;
Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true,
  value: async (alg, data) => { digests++; if (onDigest) onDigest(digests); return realDigest(alg, data); } });
const calls = [], plan = new Map();
const PREF = "https://ipfs.enclave.host/ipfs/", IO = "https://ipfs.io/ipfs/", DWEB = "https://dweb.link/ipfs/";
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const o = [...plan].find(([k]) => String(url).startsWith(k))?.[1] ?? "down";
  if (o === "down") throw new TypeError("Failed to fetch");
  if (o.car || o.file){ const v = String(url).includes("format=car") ? o.car : o.file; return v ? new Response(v, { status: 200 }) : new Response("no", { status: 406 }); }
  return new Response(o, { status: 200 });
};
const C = await import("../site/js/core/catalog.js");
const { verifyCar, reconstruct, parseCar } = await import("../site/js/core/ipfs-car.js");
const enc = (s) => new TextEncoder().encode(s);
const reset = (p) => { calls.length = 0; plan.clear(); digests = 0; onDigest = null; for (const [k, v] of Object.entries(p)) plan.set(k, v); };
let seed = 0;
// a valid multi-block config: 40+ raw 100-byte leaves under a CIDv0 root
function manyBlocks(){
  const text = JSON.stringify({ seed: 9000 + ++seed, v: Array.from({ length: 900 }, (_, i) => (i * 7919 + seed) % 100003) }), d = enc(text), leaves = [];
  for (let o = 0; o < d.length; o += 100) leaves.push(F.leaf("raw", d.subarray(o, o + 100)));
  const n = F.node(leaves, "v0");
  return { text, n, str: CID.decode(n.cid).toString(), car: F.car(n.cid, F.blocksOf(n)), blocks: F.blocksOf(n).length };
}

test("verifyCar: without a check it is the runtime's verifier (unchanged); with one, hashing stops at the first check past the deadline", async () => {
  const fx = manyBlocks(); assert.ok(fx.blocks > 40);
  reset({}); const out = await verifyCar(fx.n.cid, fx.car, 1048576);
  assert.equal(new TextDecoder().decode(out), fx.text); assert.equal(digests, fx.blocks, "default: every block hashed once");
  const until = now + 1000; reset({}); onDigest = (i) => { if (i === 5) now = until; };
  await assert.rejects(verifyCar(fx.n.cid, fx.car, 1048576, { check: () => { if (Date.now() >= until) throw new Error("late"); } }), /late/);
  assert.equal(digests, 5, "no block hashed after the deadline passed");
  now += 1;
});

test("reconstruct: the walk calls the check every 1024 visits and stops when it throws; default walk unchanged", async () => {
  const empty = F.leaf("raw", enc("x")), wide = F.node(Array.from({ length: 3000 }, () => empty));
  const blocks = await parseCar(F.car(wide.cid, F.blocksOf(wide)));
  assert.equal(reconstruct(wide.cid, blocks, 1048576).length, 3000);
  let checks = 0;
  assert.throws(() => reconstruct(wide.cid, blocks, 1048576, { check: () => { if (++checks === 2) throw new Error("late"); } }), /late/);
  assert.equal(checks, 2, "stopped at visit 1025, not after 3001");
});

test("CAR mode: the deadline passing during block hashing -> null, no further block hashed, no other request, nothing cached", async () => {
  const fx = manyBlocks();
  reset({ [PREF]: { car: fx.car }, [IO]: { car: fx.car }, [DWEB]: { car: fx.car } });
  onDigest = (i) => { if (i === 3) now += C.CONFIG_ROUND_MS; };
  assert.equal(await C.fetchConfigCid(fx.str), null);
  assert.equal(digests, 3, "hashing stopped at the first check after the deadline");
  assert.deepEqual(calls, [PREF + fx.str + "?format=car&dag-scope=all"], "no file attempt, no other gateway");
  reset({ [PREF]: { car: fx.car } });
  assert.equal(await C.fetchConfigCid(fx.str), null); assert.equal(calls.length, 0, "a late round is a failed round (miss window)");
  now += C.CONFIG_MISS_TTL_MS; reset({ [PREF]: { car: fx.car } });
  assert.equal(await C.fetchConfigCid(fx.str), fx.text, "valid once proven in time"); assert.equal(calls.length, 1, "it was not cached before");
});

test("a VALID proof that completes after the deadline is not returned or cached (deadline passes at the last block's hash)", async () => {
  const fx = manyBlocks();
  reset({ [PREF]: { car: fx.car } });
  onDigest = (i) => { if (i === fx.blocks) now += C.CONFIG_ROUND_MS; };      // every block hashes correctly; time ran out
  assert.equal(await C.fetchConfigCid(fx.str), null); assert.equal(digests, fx.blocks);
  now += C.CONFIG_MISS_TTL_MS; reset({ [PREF]: { car: fx.car } });
  assert.equal(await C.fetchConfigCid(fx.str), fx.text); assert.equal(calls.length, 1, "the late success had not been cached");
});

test("raw and profile-file modes: a proof finishing after the deadline is refused and not cached", async () => {
  const raw = enc(F.configText(77001, 50)), rawCid = (await (await import("../site/js/core/unixfs.js")).artifactIdentity(raw)).cid;
  reset({ [PREF]: raw, [IO]: raw }); onDigest = (i) => { if (i === 1) now += C.CONFIG_ROUND_MS; };
  assert.equal(await C.fetchConfigCid(rawCid), null); assert.deepEqual(calls, [PREF + rawCid], "raw: no other gateway after the deadline");
  now += C.CONFIG_MISS_TTL_MS; reset({ [PREF]: raw }); assert.equal(await C.fetchConfigCid(rawCid), new TextDecoder().decode(raw));

  const big = enc(F.configText(77002, 300000)), id = await (await import("../site/js/core/unixfs.js")).artifactIdentity(big);
  reset({ [PREF]: { file: big } }); onDigest = (i) => { if (i === 2) now += C.CONFIG_ROUND_MS; };
  assert.equal(await C.fetchConfigCid(id.cid), null, "profile re-import finishing late");
  assert.deepEqual(calls, [PREF + id.cid + "?format=car&dag-scope=all", PREF + id.cid]);
  now += C.CONFIG_MISS_TTL_MS; reset({ [PREF]: { file: big } }); assert.equal(await C.fetchConfigCid(id.cid), new TextDecoder().decode(big));
});

test("deadline checks never fire inside the window: the same proofs succeed when time does not run out", async () => {
  const fx = manyBlocks(); reset({ [PREF]: { car: fx.car } });
  onDigest = () => { now += 1; };                                         // time moves, but stays well inside the round
  assert.equal(await C.fetchConfigCid(fx.str), fx.text); assert.equal(digests, fx.blocks);
});
