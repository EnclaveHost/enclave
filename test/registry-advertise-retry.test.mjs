// Self-registration retries until it goes through, for a box with a pinned PUBLIC_URL too. The registration functions of
// supervisor.js (registerOnChain, registerFromShimCert, registerSelf, advertise), sliced out by text so the test runs
// the production code against a stub registry without starting a supervisor. The case it exists for (2026-10-10,
// metal0): the host booted with its USB uplink missing, the one boot-time register() of a PUBLIC_URL box failed with
// "HTTP request failed", and nothing ever tried again. The box stayed off the live enclave list, and claimed nothing
// (the claim loop waits on _enclaveId), until it was restarted by hand 30 minutes later.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../supervisor.js", import.meta.url), "utf8");
const slice = (re, what) => { const m = re.exec(src); assert.ok(m, `${what} is in supervisor.js`); return m[0]; };
const FNS = [
  slice(/function registryRepointed\(\) \{[\s\S]*?\n\}/, "registryRepointed"),
  slice(/async function registerOnChain\(endpoint\) \{[\s\S]*?\n\}/, "registerOnChain"),
  slice(/async function registerFromShimCert\(\) \{[\s\S]*?\n\}/, "registerFromShimCert"),
  slice(/async function registerSelf\(\) \{[\s\S]*?\n\}/, "registerSelf"),
  slice(/function advertised\(\) \{[\s\S]*?\n\}/, "advertised"),
  slice(/let _advertising = false;\nasync function advertise\(\) \{[\s\S]*?\n\}/, "advertise"),
].join("\n");

// One supervisor's registration state, with the chain, the shim and the clock stubbed. env.send(fn, args) answers each
// operator tx: return a hash, or throw. Backoff sleeps are recorded and yield to the event loop instead of waiting.
function box(env) {
  const sleeps = [], txs = [], logs = [];
  const make = new Function("env", "sleeps", "txs", "logs", `
    let REGISTRY_ADDRESS = "0xAAAA";
    const REGISTRY_READY = true, PUBLIC_URL = env.PUBLIC_URL || "";
    let _registered = false, _registeredOn = null, _enclaveId = null, _advertisedEndpoint = null, _certSan = null;
    const keccak256 = (b) => "id(" + b + ")", stringToBytes = (s) => s;
    const registryRev = async () => 3;
    const PROOF_ACCOUNT = null, REGISTRY_ABI = [], REGISTRY_ABI_V2 = [], REGISTRY_ABI_V1 = [];
    const ENCLAVE_REPO = "EnclaveHost/enclave", ENCLAVE_MEASUREMENT = "0x00", SELL_CPU_PRICE6 = 1, SELL_GPU_PRICE6 = 2;
    const IS_GPU = false, HEARTBEAT_SEC = 60;
    const sendOperatorTx = async (address, _abi, fn, args) => { txs.push({ address, fn, endpoint: args[0] }); return env.send(fn, args); };
    const shimCertHostname = env.shimCertHostname || (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:443"); });
    const setInterval = () => ({ unref() {} });
    const setTimeout = (fn, ms) => {
      if (sleeps.length >= 50) throw new Error("still not registered after 50 retries");   // fail, don't spin forever
      sleeps.push(ms / 1000); setImmediate(fn); return { unref() {} };
    };
    const syncRegisteredPrice = async () => {}, syncRegisteredProofKey = async () => {}, syncDeclaredPayoutWallet = async () => {};
    const console = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    ${FNS}
    return { advertise, registerSelf,
      state: () => ({ registered: _registered, enclaveId: _enclaveId, endpoint: _advertisedEndpoint, advertising: _advertising }),
      repoint: (a) => { REGISTRY_ADDRESS = a; } };`);
  return Object.assign(make(env, sleeps, txs, logs), { sleeps, txs, logs });
}
const down = () => { throw new Error("HTTP request failed."); };

test("a PUBLIC_URL box keeps retrying registration through a network outage, with backoff", async () => {
  let attempts = 0;
  const b = box({ PUBLIC_URL: "https://api.enclave.host/t/metal0",
    send: () => (++attempts <= 4 ? down() : "0xhash") });
  await b.advertise();
  assert.equal(attempts, 5, "four failed attempts, then the one that goes through");
  assert.deepEqual(b.sleeps, [5, 10, 20, 40], "doubling backoff between attempts");
  assert.deepEqual(b.state(), { registered: true, enclaveId: "id(https://api.enclave.host/t/metal0)",
    endpoint: "https://api.enclave.host/t/metal0", advertising: false });
  assert.ok(b.txs.every((t) => t.fn === "register" && t.endpoint === "https://api.enclave.host/t/metal0"),
    "it registers the pinned origin every time, never a shim name");
  assert.ok(b.logs.some((l) => /not registered — retrying in 5s/.test(l)), "the log says it will retry");
});

test("the backoff is capped at 5 minutes", async () => {
  let attempts = 0;
  const b = box({ PUBLIC_URL: "https://x", send: () => (++attempts <= 9 ? down() : "0xhash") });
  await b.advertise();
  assert.deepEqual(b.sleeps, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
});

test("one retry loop at a time", async () => {
  let attempts = 0;
  const b = box({ PUBLIC_URL: "https://x", send: () => (++attempts <= 2 ? down() : "0xhash") });
  await Promise.all([b.advertise(), b.advertise(), b.advertise()]);
  assert.equal(attempts, 3, "the second and third calls sent nothing of their own");
  assert.deepEqual(b.sleeps, [5, 10], "only one loop is backing off, not three");
});

test("an attempt in flight elsewhere does not end the loop: if it fails, the loop tries again", async () => {
  // the request middleware calls registerSelf() directly; its attempt sets _registered before it knows the outcome
  let release, attempts = 0;
  const b = box({ PUBLIC_URL: "https://x", send: () => {
    attempts++;
    if (attempts === 1) return new Promise((_, rej) => { release = () => rej(new Error("HTTP request failed.")); });
    return "0xhash";
  } });
  const kicked = b.registerSelf();                      // the middleware's attempt, now pending
  await new Promise((r) => setImmediate(r));
  assert.equal(b.state().registered, true, "the pending attempt has claimed the guard");
  const loop = b.advertise();
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.equal(attempts, 1, "the loop waits instead of sending a second register");
  release();                                            // the middleware's attempt fails...
  await kicked; await loop;
  assert.equal(attempts, 2, "...and the loop's own next attempt goes through");
  assert.ok(b.state().enclaveId);
});

test("a PUBLIC_URL box re-registers its pinned origin when the address book repoints the registry", async () => {
  // the heartbeat calls advertise() on a repoint; before, it called registerFromShimCert, which a box without a shim
  // (metal0) can never satisfy, so it stayed registered on a registry nobody reads
  const b = box({ PUBLIC_URL: "https://api.enclave.host/t/metal0", send: () => "0xhash" });
  await b.advertise();
  b.repoint("0xBBBB");
  await b.advertise();
  assert.deepEqual(b.txs.map((t) => [t.address, t.endpoint]), [
    ["0xAAAA", "https://api.enclave.host/t/metal0"], ["0xBBBB", "https://api.enclave.host/t/metal0"]]);
});

test("a shim box still waits for its public SAN, then registers it", async () => {
  let reads = 0;
  const b = box({ send: () => "0xhash",
    shimCertHostname: async () => (++reads <= 2 ? null : "abc.containers.Cloud Provider.dev") });
  await b.advertise();
  assert.deepEqual(b.sleeps, [5, 10]);
  assert.deepEqual(b.txs.map((t) => t.endpoint), ["https://abc.containers.Cloud Provider.dev"]);
});

test("boot, the heartbeat's repoint path and the request middleware all go through the retrying entry points", () => {
  assert.match(src, /\nif \(REGISTRY_READY\) advertise\(\);\n/, "boot starts the retry loop");
  assert.doesNotMatch(src, /\nif \(PUBLIC_URL\) registerOnChain\(PUBLIC_URL\);/, "the one-shot boot registration is gone");
  const heartbeat = slice(/setInterval\(async \(\) => \{[\s\S]*?HEARTBEAT_SEC\) \* 1000\)/, "the registry heartbeat");
  assert.match(heartbeat, /registryRepointed\(\)\) return void advertise\(\)/);
  assert.match(src, /if \(REGISTRY_READY && !_registered\) registerSelf\(\)\.catch\(/, "the middleware kicks registerSelf");
});
