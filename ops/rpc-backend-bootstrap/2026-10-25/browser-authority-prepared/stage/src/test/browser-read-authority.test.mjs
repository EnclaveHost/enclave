// Hosted site READ authority (site/js/core/read-authority.js, config.js, chain.js baseRpc, scripts/site-read-authority.mjs).
// Offline: fetch is a stub that records every URL. Integration scenarios run the REAL config.js + chain.js from a private
// temp copy of site/js whose read-authority.js was transformed by the SAME function the build plugin uses.
// What this proves: endpoint SELECTION (own endpoints only, no public fallback, invalid/outage refuse). It proves nothing
// about the answers: "own-rpc" is a trusted self-hosted transport, not proof verification.
//   run: node --test test/browser-read-authority.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReadAuthority, resolveReadAuthority, fallbackUsesPool, sessionsRpc, READ_AUTHORITY_TEXT } from "../site/js/core/read-authority.js";
import { takeReadAuthorityArgs, readReadAuthority, embedReadAuthority, READ_AUTHORITY_DECLARATION } from "../scripts/site-read-authority.mjs";
import { createQuorumReader } from "../site/js/core/quorum.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWN = ["https://rpc-a.own-node.example/", "https://rpc-b.own-node.example/base"];
const LEGACY = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];
const auth = (o = {}) => JSON.stringify({ version: 1, mode: "own-rpc", rpcs: OWN, trust: "self-hosted-transport", ...o });

test("source default: no release authority, legacy pool exactly as before", () => {
  assert.equal(READ_AUTHORITY_TEXT, null, "the source tree never carries an authority; only a reviewed build embeds one");
  const r = resolveReadAuthority({ legacy: LEGACY });
  assert.deepEqual([r.mode, [...r.rpcs]], ["legacy", LEGACY]);
  assert.deepEqual([...resolveReadAuthority({ legacy: LEGACY, devRpc: "http://127.0.0.1:8545" }).rpcs], ["http://127.0.0.1:8545"], "legacy dev override unchanged");
});

test("own-rpc: only the authority's endpoints, the dev override is not mixed in", () => {
  const r = resolveReadAuthority({ text: auth(), legacy: LEGACY, devRpc: "http://127.0.0.1:8545" });
  assert.deepEqual([r.mode, [...r.rpcs], r.trust], ["own-rpc", OWN, "self-hosted-transport"]);
  assert.ok(!r.rpcs.some((u) => LEGACY.includes(u) || u.startsWith("http://127.")));
});

test("an invalid or mislabelled authority pins NO endpoint (never the public pool)", () => {
  const bad = {
    "plain http": auth({ rpcs: ["http://rpc.own-node.example"] }), "credentials": auth({ rpcs: ["https://u:p@rpc.own-node.example"] }),
    "query key": auth({ rpcs: ["https://rpc.own-node.example/?key=1"] }), "fragment": auth({ rpcs: ["https://rpc.own-node.example/#x"] }),
    "mainnet.base.org": auth({ rpcs: ["https://mainnet.base.org"] }), "publicnode": auth({ rpcs: ["https://base-rpc.publicnode.com"] }),
    "drpc": auth({ rpcs: ["https://base.drpc.org"] }), "1rpc": auth({ rpcs: ["https://1rpc.io/base"] }), "blastapi": auth({ rpcs: ["https://base-mainnet.public.blastapi.io"] }),
    "same origin twice": auth({ rpcs: ["https://rpc.own-node.example/a", "https://rpc.own-node.example/b"] }),
    "no endpoint": auth({ rpcs: [] }), "five endpoints": auth({ rpcs: [1, 2, 3, 4, 5].map((i) => `https://r${i}.own-node.example`) }),
    "claims proof": auth({ trust: "proof-verified" }), "no trust": JSON.stringify({ version: 1, mode: "own-rpc", rpcs: OWN }),
    "unknown key": auth({ fallback: LEGACY }), "version 2": auth({ version: 2 }), "public mode": auth({ mode: "public" }),
    "duplicate key": '{"version":1,"version":1,"mode":"own-rpc","rpcs":["https://rpc.own-node.example"],"trust":"self-hosted-transport"}',
    "not JSON": "own-rpc https://rpc.own-node.example", "too large": auth({ note: "x".repeat(5000) }),
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.throws(() => parseReadAuthority(text), Error, what);
    const r = resolveReadAuthority({ text, legacy: LEGACY });
    assert.deepEqual([r.mode, r.rpcs.length], ["invalid", 0], what);
    assert.ok(r.error, what);
  }
});

test("a user's independent profile keeps precedence; the wallet fallback never uses a public default outside legacy", () => {
  for (const s of ["on", "unconfirmed", "invalid"]) assert.equal(resolveReadAuthority({ text: auth(), independentState: s, legacy: LEGACY }).mode, "independent", s);
  const legacy = resolveReadAuthority({ legacy: LEGACY }), own = resolveReadAuthority({ text: auth() }), inval = resolveReadAuthority({ text: "x" });
  assert.equal(fallbackUsesPool("off", legacy), false, "legacy hosted page: unchanged (Base's public RPC)");
  assert.equal(fallbackUsesPool("off", own), true);
  assert.equal(fallbackUsesPool("off", inval), true, "invalid: the empty pool refuses");
  assert.equal(fallbackUsesPool("on", legacy), true);
});

test("hosted sessions RPC: legacy unchanged; own-rpc ignores a relay-supplied RPC; invalid refuses (no SDK public default)", () => {
  const legacy = resolveReadAuthority({ legacy: LEGACY }), own = resolveReadAuthority({ text: auth() }), inval = resolveReadAuthority({ text: "x" });
  assert.equal(sessionsRpc("https://relay-chosen.example", legacy, [...legacy.rpcs]), "https://relay-chosen.example", "legacy: the relay config's rpc, as before");
  assert.equal(sessionsRpc(undefined, legacy, [...legacy.rpcs]), LEGACY[0], "legacy: else the pool's first, as before");
  assert.equal(sessionsRpc("https://base-rpc.publicnode.com", own, [...own.rpcs]), OWN[0], "own-rpc: never the relay's (possibly public) rpc");
  assert.throws(() => sessionsRpc("https://base-rpc.publicnode.com", inval, []), /invalid/, "invalid: no URL, so the SDK cannot substitute a default");
});

test("build seam: flags both-or-neither, reviewed digest, exactly one declaration in the real source", () => {
  assert.deepEqual(takeReadAuthorityArgs(["--built-in-profile", "p", "--built-in-profile-digest", "d"]), { file: null, digest: null, rest: ["--built-in-profile", "p", "--built-in-profile-digest", "d"] });
  assert.throws(() => takeReadAuthorityArgs(["--read-authority", "f"]), /go together/);
  assert.throws(() => takeReadAuthorityArgs(["--read-authority", "f", "--read-authority", "g", "--read-authority-digest", "d"]), /twice/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-auth-"));
  try {
    const f = path.join(dir, "a.json"); fs.writeFileSync(f, auth());
    const digest = "sha256:" + createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    assert.deepEqual([...readReadAuthority(f, digest).authority.rpcs], OWN);
    assert.throws(() => readReadAuthority(f, "sha256:" + "0".repeat(64)), /not the reviewed/);
    fs.writeFileSync(f, auth({ rpcs: ["https://mainnet.base.org"] }));
    assert.throws(() => readReadAuthority(f, "sha256:" + createHash("sha256").update(fs.readFileSync(f)).digest("hex")), /third-party provider/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const src = fs.readFileSync(path.join(ROOT, "site/js/core/read-authority.js"), "utf8");
  assert.equal(src.split(READ_AUTHORITY_DECLARATION).length - 1, 1);
  assert.throws(() => embedReadAuthority(src + "\n" + READ_AUTHORITY_DECLARATION, auth()), /exactly one/);
});

// ---- integration: the real config.js + chain.js, one private copy of site/js per scenario ----------------------------
function scenario(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-js-"));
  fs.cpSync(path.join(ROOT, "site/js"), path.join(dir, "js"), { recursive: true });
  if (text != null) {
    const p = path.join(dir, "js/core/read-authority.js");
    fs.writeFileSync(p, embedReadAuthority(fs.readFileSync(p, "utf8"), text, p));
  }
  return dir;
}
async function load(dir, { hostname = "enclave.host", store = {} } = {}) {
  const m = new Map(Object.entries(store));
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` };
  const config = await import(pathToFileURL(path.join(dir, "js/core/config.js")).href);
  const chain = await import(pathToFileURL(path.join(dir, "js/core/chain.js")).href);
  return { config, chain };
}
function fetchSpy(answer) {
  const urls = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => { urls.push(String(u)); return answer(String(u), JSON.parse(init.body)); };
  return { urls, restore: () => { globalThis.fetch = real; } };
}
const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });

test("integration own-rpc: reads go only to the own endpoints; the wallet signing config is unchanged", async () => {
  const dir = scenario(auth());
  const spy = fetchSpy(() => ok("0x10"));
  try {
    const { config, chain } = await load(dir, { hostname: "localhost", store: { enclave_rpc: "http://127.0.0.1:8545" } });
    assert.deepEqual([config.READ_AUTHORITY.mode, config.APP_CATALOG_RPCS], ["own-rpc", OWN], "not even the loopback dev override is mixed in");
    assert.equal(await chain.baseRpc("eth_blockNumber", []), "0x10");
    assert.ok(spy.urls.length > 0 && spy.urls.every((u) => OWN.includes(u)), JSON.stringify(spy.urls));
    assert.equal(config.WALLETCONNECT_PROJECT_ID, "e935970def12ab5d05b6b8ff7abd8d75", "wallet signing (WalletConnect) unchanged");
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("integration own-rpc outage: every attempt stays on the own endpoints, then the read fails (no public fallback)", async () => {
  const dir = scenario(auth());
  const spy = fetchSpy(() => { throw new TypeError("connection refused"); });
  try {
    const { chain } = await load(dir);
    await assert.rejects(chain.baseRpc("eth_call", [{ to: "0x" + "11".repeat(20), data: "0x" }, "latest"]), /connection refused/);
    assert.equal(spy.urls.length, OWN.length * 2, "the existing rotation, bounded");
    assert.ok(spy.urls.every((u) => OWN.includes(u)), JSON.stringify(spy.urls));
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("integration invalid authority: the pool is empty and every read refuses without contacting anyone", async () => {
  const dir = scenario(auth({ rpcs: ["https://mainnet.base.org"] }));
  const spy = fetchSpy(() => ok("0x1"));
  try {
    const { config, chain } = await load(dir);
    assert.deepEqual([config.READ_AUTHORITY.mode, config.APP_CATALOG_RPCS], ["invalid", []]);
    await assert.rejects(chain.baseRpc("eth_blockNumber", []), /read authority is invalid/);
    assert.deepEqual(spy.urls, []);
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("integration legacy (no release authority): the existing public pool and dev-override rules are unchanged", async () => {
  const dir = scenario(null);
  const spy = fetchSpy(() => ok("0x2"));
  try {
    const { config, chain } = await load(dir, { hostname: "enclave.host", store: { enclave_rpc: "https://rpc.evil.example" } });
    assert.deepEqual([config.READ_AUTHORITY.mode, config.APP_CATALOG_RPCS], ["legacy", LEGACY], "production origin: planted override ignored, pool as before");
    assert.equal(await chain.baseRpc("eth_blockNumber", []), "0x2");
    assert.ok(LEGACY.includes(spy.urls[0]));
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("credit page contract (unchanged): its quorum reader refuses a single origin, so a credit cutover needs two own endpoints", () => {
  assert.throws(() => createQuorumReader({ rpcs: [OWN[0]], quorum: 1, chainId: 8453 }), /at least two RPC origins/);
  assert.throws(() => createQuorumReader({ rpcs: OWN, quorum: 1, chainId: 8453 }), /invalid RPC quorum/);
  assert.ok(createQuorumReader({ rpcs: OWN, quorum: 2, chainId: 8453 }));
});
