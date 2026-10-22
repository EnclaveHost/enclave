// The pinned-config read path (site/js/core/catalog.js fetchConfigCid): preferred gateway, then the same public read
// gateways the media fallback uses, and ONLY bytes that reproduce the requested CID (js/core/unixfs.js) are offered.
// fetch is a scripted stub per gateway (down | 503 | hang | bytes | oversize); Date.now is a stepped test clock. CID spellings
// are cross-checked against multiformats 13.4.1 (the version network/package.json pins), a TEST-ONLY oracle. The real
// callsites - apps.js publishPrefillOf and deployments.js _cfgRead - are lifted from source (as publish-prefill-config and
// models-read-only do) and run against the REAL fetchConfigCid.
import "./helpers/dom-stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostsTakeConfig } from "../site/js/core/isolation-options.js";
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { base32upper } from "multiformats/bases/base32";
import { sha256 as mfSha256, sha512 as mfSha512 } from "multiformats/hashes/sha2";
let now = 1_800_000_000_000; Date.now = () => now;
const calls = [], plan = new Map(); let onCall = null;
const PREF = "https://ipfs.enclave.host/ipfs/", IO = "https://ipfs.io/ipfs/", DWEB = "https://dweb.link/ipfs/";
// "endless" up to 8 MiB, so an UNBOUNDED reader (the negative controls) finishes and fails the byte assertion instead of eating RAM
const stream = (chunk, pulled) => new ReadableStream({ pull(c){ if (pulled.n >= 8 << 20) return c.close(); pulled.n += chunk.length; c.enqueue(chunk); } });
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts }); if (onCall) onCall(String(url));
  const o = [...plan].find(([k]) => String(url).startsWith(k))?.[1] ?? "down";
  if (o === "down") throw new TypeError("Failed to fetch");
  if (o === "503") return new Response("busy", { status: 503 });
  if (o === "hang") return new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(opts.signal.reason)));
  if (o && o.oversize === "length") return new Response(stream(new Uint8Array(65536), o.pulled), { status: 200, headers: { "content-length": String(64 << 20) } });
  if (o && o.oversize === "stream") return new Response(stream(new Uint8Array(65536).fill(0x20), o.pulled), { status: 200 });
  return new Response(o, { status: 200 });
};
const C = await import("../site/js/core/catalog.js");
const CFG = await import("../site/js/core/config.js");
const { artifactIdentity, rawCid, parseCid, CHUNK_BYTES } = await import("../site/js/core/unixfs.js");
const enc = (s) => new TextEncoder().encode(s);
let serial = 0;
const config = (extra = {}) => { const text = JSON.stringify({ tools: { n: ++serial }, models: { primary: "m" + serial }, ...extra }); return { text, bytes: enc(text) }; };
const cidOf = async (bytes) => (await artifactIdentity(bytes)).cid;
const reset = (p) => { calls.length = 0; plan.clear(); onCall = null; for (const [k, v] of Object.entries(p)) plan.set(k, v); };
const asked = () => calls.map((c) => c.url);
// every spelling the enclave's verifier parses for the same content (CIDv0 exists only for dag-pb)
const spellings = (v1) => { const c = CID.parse(v1);
  return { b32: v1, B32: c.toString(base32upper), z58: c.toString(base58btc), ...(c.code === 0x70 ? { v0: c.toV0().toString() } : {}) }; };

test("gateways are the media patch's list; parseCid decodes every spelling exactly as multiformats does; anything else is refused unrequested", async () => {
  assert.deepEqual([CFG.IPFS_IMG_GATEWAY, ...CFG.IPFS_IMG_FALLBACKS], [PREF, IO, DWEB]);
  // the verifier is not circular: the well-known raw CID of zero bytes, from node:crypto + the CIDv1 rules
  assert.equal(rawCid(createHash("sha256").update(Buffer.alloc(0)).digest("hex")), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  for (let i = 0; i < 64; i++){
    const mh = await mfSha256.digest(enc("vector " + i));
    for (const code of [0x55, 0x70]){
      const c = CID.createV1(code, mh), want = { codec: code, cid: c.toString() };
      for (const [form, str] of Object.entries(spellings(c.toString()))){
        const p = parseCid(str); assert.ok(p, form + " " + str);
        assert.deepEqual({ codec: p.codec, cid: p.cid }, want, form); assert.deepEqual([...p.digest], [...mh.digest], form);
      }
    }
  }
  assert.equal(parseCid("QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn").cid, "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354", "well-known v0 <-> v1 pair");
  const small = await cidOf(config().bytes), big = await cidOf(enc(JSON.stringify({ pad: "x".repeat(CHUNK_BYTES + 10) })));
  assert.equal(C.configCidForm(small), "raw"); assert.equal(C.configCidForm(big), "dag-pb");
  for (const str of Object.values(spellings(big))) assert.equal(C.configCidForm(str), "dag-pb");
  const mh = await mfSha256.digest(enc("x")), v1raw = CID.createV1(0x55, mh).toString(), AL = "abcdefghijklmnopqrstuvwxyz234567";
  const refused = ["", "cid", "missing", "bafkreiektgu", "../ipfs/x", small + "x", small.slice(0, -1), "Qm" + "0".repeat(44), null, undefined, 42,
    CID.createV1(0x71, mh).toString(),                               // dag-cbor: not a file
    CID.createV1(0x55, await mfSha512.digest(enc("x"))).toString(),  // sha2-512
    "bafk2bzacedzv7csbrv4z7mnaybwbcgr7kqh2pthx4yaxe7m3q3y5dyfn5htgo",  // blake2b
    "B" + v1raw.slice(1, 20) + v1raw.slice(20).toUpperCase(),        // mixed case
    v1raw.slice(0, -1) + AL[AL.indexOf(v1raw.at(-1)) ^ 1],           // same bytes, a padding bit set: non-canonical spelling
    "k2jmtxu" + "a".repeat(52), "f01551220" + "0".repeat(64)];       // base36 / base16: the enclave parses neither
  for (const bad of refused) assert.equal(parseCid(bad), null, String(bad));
  reset({ [PREF]: config().bytes });
  for (const bad of refused) assert.equal(await C.fetchConfigCid(bad), null, String(bad));
  assert.deepEqual(calls, [], "malformed / unsupported CIDs are never requested");
});

test("forged JSON is rejected for EVERY accepted spelling, raw and dag-pb, and never selected from any gateway position", async () => {
  let cases = 0;
  for (const big of [false, true]) for (const at of [PREF, IO, DWEB]){
    const kinds = Object.keys(spellings(await cidOf(config(big ? { pad: "q".repeat(CHUNK_BYTES + 1) } : {}).bytes)));
    assert.deepEqual(kinds, big ? ["b32", "B32", "z58", "v0"] : ["b32", "B32", "z58"]);
    for (const form of kinds){
      // fresh content per case, so the verified cache can never answer for a later case
      const good = config(big ? { pad: "z".repeat(CHUNK_BYTES * 2 + 5) } : {}), str = spellings(await cidOf(good.bytes))[form];
      const forged = enc(good.text.replace(/"m(\d+)"/, '"evil"'));
      reset({ [PREF]: forged, [IO]: forged, [DWEB]: forged });
      assert.equal(await C.fetchConfigCid(str), null, form + ": forged everywhere"); assert.equal(calls.length, 3);
      now += C.CONFIG_MISS_TTL_MS;
      reset({ [PREF]: forged, [IO]: forged, [DWEB]: forged }); plan.set(at, good.bytes);
      assert.equal(await C.fetchConfigCid(str), good.text, form + ": the verified copy at " + at);
      const order = [PREF, IO, DWEB]; assert.equal(calls.length, order.indexOf(at) + 1, "forged answers before it were skipped, none after it asked");
      assert.ok(asked().every((u) => u.endsWith("/ipfs/" + encodeURIComponent(str))), "requested by the spelling the record names");
      cases++;
    }
  }
  assert.equal(cases, 21);
});

test("equivalent spellings are one content: they share the verified cache and an in-flight round", async () => {
  const big = config({ pad: "e".repeat(CHUNK_BYTES + 99) }), v1 = await cidOf(big.bytes), f = spellings(v1);
  reset({ [PREF]: "down", [IO]: big.bytes });
  const all = await Promise.all([C.fetchConfigCid(f.v0), C.fetchConfigCid(f.z58), C.fetchConfigCid(f.B32), C.fetchConfigCid(f.b32)]);
  assert.ok(all.every((x) => x === big.text)); assert.deepEqual(asked(), [PREF + f.v0, IO + f.v0], "ONE round for four spellings");
  reset({}); assert.equal(await C.fetchConfigCid(f.z58), big.text); assert.equal(calls.length, 0);
});

test("preferred gateway down -> the next gateway's bytes verify -> offered; no credentials; then cached by CID (no request)", async () => {
  const { text, bytes } = config(); const cid = await cidOf(bytes);
  reset({ [PREF]: "down", [IO]: bytes });
  assert.equal(await C.fetchConfigCid(cid), text);
  assert.deepEqual(asked(), [PREF + cid, IO + cid]);
  for (const c of calls){ assert.equal(c.opts.credentials, "omit"); assert.equal(c.opts.cache, "reload"); assert.equal(c.opts.headers, undefined); assert.ok(c.opts.signal); }
  reset({}); assert.equal(await C.fetchConfigCid(cid), text); assert.deepEqual(calls, [], "verified text is served from the page cache");
});

test("corrupt content is rejected wherever it comes from (preferred included) and is never cached", async () => {
  const good = config(), cid = await cidOf(good.bytes);
  const forged = enc(good.text.replace(/"m(\d+)"/, '"evil"'));         // valid JSON, wrong bytes
  reset({ [PREF]: forged, [IO]: forged, [DWEB]: good.bytes });
  assert.equal(await C.fetchConfigCid(cid), good.text, "the first VERIFIED copy wins, not the first answer");
  assert.equal(calls.length, 3);
  const other = config(), cid2 = await cidOf(other.bytes);
  reset({ [PREF]: forged, [IO]: forged, [DWEB]: "503" });
  assert.equal(await C.fetchConfigCid(cid2), null); assert.equal(calls.length, 3);
  // verified bytes that are not a JSON config are still not a config
  const notJson = enc("not json {"), cid3 = await cidOf(notJson);
  reset({ [PREF]: notJson }); assert.equal(await C.fetchConfigCid(cid3), null);
});

test("a large (multi-block, dag-pb) config verifies through artifactIdentity; a tampered one does not", async () => {
  const big = config({ pad: "y".repeat(CHUNK_BYTES * 2 + 77) }), cid = await cidOf(big.bytes);
  assert.equal(C.configCidForm(cid), "dag-pb");
  const tampered = enc(big.text.replace("yyyy", "yyyz"));
  reset({ [PREF]: "503", [IO]: tampered, [DWEB]: big.bytes });
  assert.equal(await C.fetchConfigCid(cid), big.text); assert.equal(calls.length, 3);
});

test("oversize answers are refused within the CAT_MAX.configMax byte bound (declared length or endless stream)", async () => {
  const { text, bytes } = config(), cid = await cidOf(bytes);
  const p1 = { n: 0 }, p2 = { n: 0 };
  reset({ [PREF]: { oversize: "length", pulled: p1 }, [IO]: { oversize: "stream", pulled: p2 }, [DWEB]: bytes });
  assert.equal(await C.fetchConfigCid(cid), text);
  assert.ok(p1.n <= 2 * 65536, "declared oversize: body not read, " + p1.n);
  assert.ok(p2.n <= 1048576 + 2 * 65536, "streamed oversize: stopped at the cap, " + p2.n);
});

test("a gateway that never answers is abandoned at CONFIG_TRY_MS and the next one serves", { timeout: 30000 }, async () => {
  const { text, bytes } = config(), cid = await cidOf(bytes);
  reset({ [PREF]: "hang", [IO]: bytes }); const t0 = performance.now();
  const keep = setTimeout(() => {}, C.CONFIG_TRY_MS + 5000);   // node's AbortSignal.timeout timer is unref'd; a page keeps running
  try { assert.equal(await C.fetchConfigCid(cid), text); } finally { clearTimeout(keep); }
  const ms = performance.now() - t0; assert.ok(ms >= C.CONFIG_TRY_MS - 100 && ms < C.CONFIG_TRY_MS + 3000, String(ms));
});

test("the round is bounded by CONFIG_ROUND_MS: no further gateway once the budget is spent", async () => {
  const { bytes } = config(), cid = await cidOf(bytes);
  reset({ [PREF]: "503", [IO]: bytes }); onCall = () => { now += C.CONFIG_ROUND_MS; };
  assert.equal(await C.fetchConfigCid(cid), null); assert.deepEqual(asked(), [PREF + cid]);
  now += C.CONFIG_MISS_TTL_MS;
});

test("concurrent callers share one round; a failed round answers null without requests for CONFIG_MISS_TTL_MS, then recovers", async () => {
  const { text, bytes } = config(), cid = await cidOf(bytes);
  reset({});                                                  // every gateway down
  const all = await Promise.all(Array.from({ length: 12 }, () => C.fetchConfigCid(cid)));
  assert.ok(all.every((x) => x === null)); assert.equal(calls.length, 3, "12 callers, ONE round over 3 gateways");
  now += C.CONFIG_MISS_TTL_MS - 1;
  for (let i = 0; i < 20; i++) assert.equal(await C.fetchConfigCid(cid), null);
  assert.equal(calls.length, 3, "inside the failure window: no requests");
  reset({ [PREF]: "down", [IO]: bytes }); now += 2;
  const again = await Promise.all(Array.from({ length: 5 }, () => C.fetchConfigCid(cid)));
  assert.ok(again.every((x) => x === text)); assert.deepEqual(asked(), [PREF + cid, IO + cid], "one recovery round after expiry");
  reset({}); assert.equal(await C.fetchConfigCid(cid), text); assert.equal(calls.length, 0);
});

test("unprovable layouts stay unreadable from EVERY gateway: a CIDv0 of Kubo's v0-default shape (dag-pb leaf), even with the true file bytes", async () => {
  const good = config(), vi = (n) => { const o = []; do { o.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7; } while (n); return o; };
  const ufs = Uint8Array.from([0x08, 0x02, 0x12, ...vi(good.bytes.length), ...good.bytes, 0x18, ...vi(good.bytes.length)]);
  const node = Uint8Array.from([0x0a, ...vi(ufs.length), ...ufs]);
  const v0 = CID.createV0(await mfSha256.digest(node)).toString();
  assert.equal(C.configCidForm(v0), "dag-pb", "well-formed: it is requested ...");
  reset({ [PREF]: good.bytes, [IO]: good.bytes, [DWEB]: node });
  assert.equal(await C.fetchConfigCid(v0), null, "... but bytes it cannot rebuild under the pin profile are never offered");
  assert.equal(calls.length, 3);
  now += C.CONFIG_MISS_TTL_MS; reset({ [PREF]: good.bytes });
  assert.equal(await C.fetchConfigCid(v0), null, "nor from the preferred gateway alone"); assert.equal(calls.length, 3);
});

// ---- the real callsites, lifted from source, on the real fetchConfigCid
const APPS = readFileSync(new URL("../site/js/pages/apps.js", import.meta.url), "utf8");
function prefillFn(){
  const start = APPS.indexOf("async function publishPrefillOf("); assert.ok(start > 0);
  const body = APPS.slice(start, APPS.indexOf("\n}\n", start) + 3);
  return new Function("fetchConfigCid", "mediaOf", "nextFreeVersion", "prettyConfig", "stripMedia", "cpuFallbackOfConfig", body + "; return publishPrefillOf;")(
    C.fetchConfigCid, C.mediaOf, () => "9.9.9", (s) => s, C.stripMedia, C.cpuFallbackOfConfig);
}
const MANIFEST = JSON.stringify({ wasi: "0.2", gpuOptional: true, volumes: ["v"] });
test("publish 'add version' prefill: preferred down -> verified alternate fills the form; forged everywhere -> EMPTY box + loud note, never the manifest", async () => {
  const real = config({ cpuFallback: { memMb: 40960, cpuGflops: 400 }, gpuOptional: false }), cid = await cidOf(real.bytes);
  const app = { slug: "eyesoff-ai", name: "E", description: "", active: true, versions: [{ version: "1.0.12", cid: "ipfs://x", config: MANIFEST, configCid: cid }] };
  reset({ [PREF]: "down", [IO]: real.bytes });
  const s = await prefillFn()(app, 0);
  assert.equal(s.config, real.text); assert.equal(s.gpuOptional, false); assert.deepEqual(s.cpuFallback, { memMb: 40960, cpuGflops: 400 });
  assert.doesNotMatch(s.note, /could not load/);
  const other = config(), cid2 = await cidOf(other.bytes);
  const forged = enc(JSON.stringify({ tools: {}, exfil: "https://attacker.example" }));
  reset({ [PREF]: "down", [IO]: forged, [DWEB]: forged });
  const f = await prefillFn()({ ...app, versions: [{ ...app.versions[0], configCid: cid2 }] }, 0);
  assert.equal(f.config, ""); assert.notEqual(f.config, MANIFEST); assert.match(f.note, new RegExp(cid2)); assert.doesNotMatch(f.config, /attacker/);
});

const DEPS = readFileSync(new URL("../site/components/deployments/deployments.js", import.meta.url), "utf8");
function cfgReader({ envelope, stockCid }){
  const m = DEPS.match(/  async _cfgRead\([^]*?\n  }\n/); assert.ok(m, "_cfgRead exists");
  const deps = {
    depSchemaRev: async () => 13, depGet: async () => ({ configCid: envelope, appRef: "catalog://app/42", leaseUntil: 0 }),
    loadCatalog: async () => {}, Enclave: { getAvailability: async () => ({ configOverride: true, configCidOverride: true }), getEnclaves: async () => [] },
    fetchConfigCid: C.fetchConfigCid, parseCatalogRef: () => ({ appId: "app", index: 42 }),
    STORE: { byId: { app: { versions: { 42: { config: MANIFEST, configCid: stockCid } } } } }, stripMedia: C.stripMedia, hostsTakeConfig,
  };
  const Cls = new Function(...Object.keys(deps), "return class {" + m[0] + "\n_envLearn() {}\n};")(...Object.values(deps));
  return new Cls();
}
test("dashboard Config/Models read (_cfgRead): split override + stock config both come back verified via an alternate; forged override -> ovLost, forged stock -> null", async () => {
  const ov = config({ volumes: ["custom-model"] }), stock = config({ volumes: ["stock-model"] });
  const ovCid = await cidOf(ov.bytes), stockCid = await cidOf(stock.bytes);
  const envelope = JSON.stringify({ configCid: ovCid, config: { wasi: "0.2" }, waf: { on: true } });
  reset({ [PREF]: "down", [IO]: "503", [DWEB + ovCid]: ov.bytes, [DWEB + stockCid]: stock.bytes });
  const ctx = await cfgReader({ envelope, stockCid })._cfgRead("id");
  assert.equal(ctx.err, undefined); assert.equal(ctx.ovLost, false);
  assert.deepEqual(ctx.o0.volumes, ["custom-model"]); assert.deepEqual(JSON.parse(ctx.stock).volumes, ["stock-model"]);
  assert.deepEqual(ctx.curBase, { waf: { on: true } }, "the envelope's other namespaces are carried verbatim");
  const ov2 = config(), st2 = config(), ovCid2 = await cidOf(ov2.bytes), stCid2 = await cidOf(st2.bytes);
  const forged = enc(JSON.stringify({ volumes: ["swapped"] }));
  reset({ [PREF]: forged, [IO]: forged, [DWEB]: forged });
  const bad = await cfgReader({ envelope: JSON.stringify({ configCid: ovCid2 }), stockCid: stCid2 })._cfgRead("id");
  assert.equal(bad.ovLost, true); assert.equal(bad.o0, null); assert.equal(bad.stock, null); assert.equal(bad.stockC, null);
});
