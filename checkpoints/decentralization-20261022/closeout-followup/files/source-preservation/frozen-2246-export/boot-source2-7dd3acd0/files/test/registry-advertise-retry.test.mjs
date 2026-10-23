// Self-registration retries until it goes through, for a box with a pinned PUBLIC_URL too. The registration functions of
// supervisor.js (registerOnChain, registerSelf, advertise), sliced out by text so the test runs
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
  slice(/async function bootRegistration\(id, endpoint, proofKey\) \{[\s\S]*?\n\}/, "bootRegistration"),
  slice(/function bootRegistrationAction\(row, want\) \{[\s\S]*?\n\}/, "bootRegistrationAction"),
  slice(/function gpuPricePending\(now = Date\.now\(\)\) \{[\s\S]*?\n\}/, "gpuPricePending"),
  slice(/async function registerSelf\(\) \{[\s\S]*?\n\}/, "registerSelf"),
  slice(/function advertised\(\) \{[\s\S]*?\n\}/, "advertised"),
  slice(/let _advertising = false;\nasync function advertise\(\) \{[\s\S]*?\n\}/, "advertise"),
].join("\n");

// One supervisor's registration state, with the chain and the clock stubbed. env.send(fn, args) answers each
// operator tx: return a hash, or throw. Backoff sleeps are recorded and yield to the event loop instead of waiting.
function box(env) {
  const sleeps = [], txs = [], logs = [], reads = [];
  const make = new Function("env", "sleeps", "txs", "logs", "reads", `
    let REGISTRY_ADDRESS = "0xAAAA";
    const REGISTRY_READY = true, PUBLIC_URL = env.PUBLIC_URL || "";
    let _registered = false, _registeredOn = null, _enclaveId = null, _advertisedEndpoint = null, _activeSeen = null;
    const keccak256 = (b) => "id(" + b + ")", stringToBytes = (s) => s;
    const registryRev = async () => 3;
    const PROOF_ACCOUNT = env.proofKey ? { address: env.proofKey } : null, REGISTRY_ABI = [], REGISTRY_ABI_V2 = [], REGISTRY_ABI_V1 = [];
    // the registry row as the box reads it (env.row: null = not registered, or throw = read failed) and the operator key
    const registryEntry = async (id) => { reads.push(id); return env.row ? env.row(id, REGISTRY_ADDRESS) : null; };
    const claimSigner = () => ({ account: { address: env.operator || "0x00000000000000000000000000000000000000aa" } });
    const ENCLAVE_REPO = "EnclaveHost/enclave", ENCLAVE_MEASUREMENT = "0x00", SELL_CPU_PRICE6 = 1, SELL_GPU_PRICE6 = 2;
    const IS_GPU = false, RECONCILE_SEC = 60;
    // nothing shielded expected here (test/boot-gpu-price.test.mjs covers the pending GPU price)
    const SHIELDED_GPU_EXPECTED = 0, GPU_DISCOVERY_WAIT_MS = 15 * 60_000, GPU_DISCOVERY_FROM = 0;
    // like the real queue: the promise is the HASH (at send), .receipt the confirmed outcome
    const sendOperatorTx = (address, _abi, fn, args) => {
      txs.push({ address, fn, endpoint: args[0], args });
      const p = Promise.resolve().then(() => env.send(fn, args));
      p.receipt = p.then(() => (env.receipt ? env.receipt(fn, args) : { status: "success" }));
      p.receipt.catch(() => {});
      return p;
    };
    const setInterval = () => ({ unref() {} });
    const setTimeout = (fn, ms) => {
      if (sleeps.length >= 50) throw new Error("still not registered after 50 retries");   // fail, don't spin forever
      sleeps.push(ms / 1000); setImmediate(fn); return { unref() {} };
    };
    const syncRegisteredPrice = async () => {}, syncRegisteredProofKey = async () => {}, syncDeclaredPayoutWallet = async () => {}, syncRegisteredActive = async () => {};
    const console = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    ${FNS}
    return { advertise, registerSelf,
      state: () => ({ registered: _registered, enclaveId: _enclaveId, endpoint: _advertisedEndpoint, advertising: _advertising }),
      repoint: (a) => { REGISTRY_ADDRESS = a; } };`);
  return Object.assign(make(env, sleeps, txs, logs, reads), { sleeps, txs, logs, reads });
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
  // the reconcile pass calls advertise() on a repoint; before, it called registerFromShimCert, which a box without a shim
  // (metal0) can never satisfy, so it stayed registered on a registry nobody reads
  const b = box({ PUBLIC_URL: "https://api.enclave.host/t/metal0", send: () => "0xhash" });
  await b.advertise();
  b.repoint("0xBBBB");
  await b.advertise();
  assert.deepEqual(b.txs.map((t) => [t.address, t.endpoint]), [
    ["0xAAAA", "https://api.enclave.host/t/metal0"], ["0xBBBB", "https://api.enclave.host/t/metal0"]]);
});

test("a box with no PUBLIC_URL cannot name itself, so it never registers (and never spins a retry loop)", async () => {
  const b = box({ send: () => "0xhash" });
  await b.advertise();
  assert.deepEqual(b.txs, [], "no register tx without an origin to register");
  assert.deepEqual(b.sleeps, [], "no backoff loop either");
  await b.registerSelf();
  assert.deepEqual(b.txs, []);
  assert.ok(b.logs.some((l) => /no PUBLIC_URL/.test(l)), "it says why");
});

test("boot, the reconcile pass's repoint path and the request middleware all go through the retrying entry points", () => {
  assert.match(src, /\nif \(REGISTRY_READY\) advertise\(\);\n/, "boot starts the retry loop");
  assert.doesNotMatch(src, /\nif \(PUBLIC_URL\) registerOnChain\(PUBLIC_URL\);/, "the one-shot boot registration is gone");
  const reconcile = slice(/setInterval\(async \(\) => \{[\s\S]*?RECONCILE_SEC\) \* 1000\)/, "the registry reconcile pass");
  assert.match(reconcile, /registryRepointed\(\)\) return void advertise\(\)/);
  assert.match(src, /if \(REGISTRY_READY && !_registered\) registerSelf\(\)\.catch\(/, "the middleware kicks registerSelf");
});

// ---- boot adoption (2026-10-23, metal0): an already-registered, active row of this operator is adopted, with at most a
// setProofKey, instead of a full register() the operator's gas balance could not pay ----
const URL0 = "https://api.enclave.host/t/metal0", OP = "0x00000000000000000000000000000000000000aa";
const KEY_NEW = "0x000000000000000000000000000000000000bEEF", KEY_OLD = "0x000000000000000000000000000000000000dEaD";
const row = (over = {}) => ({ endpoint: URL0, repo: "EnclaveHost/enclave", measurement: "0x00", operator: OP, active: true,
  cpuPricePerSec6: 1n, gpuPricePerSec6: 2n, proofKey: KEY_OLD, ...over });
const ok = () => "0xhash";
const fns = (b) => b.txs.map((t) => t.fn);

test("adopt: every field already exact, the proof key included -> no transaction at all", async () => {
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_OLD, row: () => row(), send: ok });
  await b.advertise();
  assert.deepEqual(b.txs, []);
  assert.equal(b.state().enclaveId, "id(" + URL0 + ")");
  assert.ok(b.logs.some((l) => /adopted the existing registration .*already registered exactly.*no transaction/.test(l)));
});

test("only the proof key differs -> ONE setProofKey with this boot's key, adopted after its confirmed receipt", async () => {
  let key = KEY_OLD;
  let receiptSeen = false;
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row({ proofKey: key }),
    send: (fn, args) => { assert.equal(fn, "setProofKey"); assert.deepEqual(args, ["id(" + URL0 + ")", KEY_NEW]); return "0xpk"; },
    receipt: () => { key = KEY_NEW; receiptSeen = true; return { status: "success" }; } });
  await b.advertise();
  assert.deepEqual(fns(b), ["setProofKey"]);
  assert.ok(receiptSeen);
  assert.equal(b.state().enclaveId, "id(" + URL0 + ")");
  assert.ok(b.logs.some((l) => /only the proof key differs\): proofKey=0x0+beef tx=0xpk/i.test(l)));
});

test("any registered field that differs keeps the full register(): endpoint, repo, measurement, cpu or gpu price", async () => {
  for (const over of [{ endpoint: URL0 + "/" }, { repo: "enclavehost/enclave" }, { measurement: "0x01" }, { cpuPricePerSec6: 834n }, { gpuPricePerSec6: 1667n }]) {
    const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row(over), send: ok });
    await b.advertise();
    assert.deepEqual(fns(b), ["register"], JSON.stringify(over, (k, v) => typeof v === "bigint" ? String(v) : v));
    assert.ok(b.logs.some((l) => /the registered fields differ/.test(l)));
  }
});

test("unchanged paths: not registered, another operator's row, an inactive row, a pre-schema-3 registry", async () => {
  const cases = [
    [() => null, /not registered yet/], [() => row({ operator: "0x0000000000000000000000000000000000000000" }), /not registered yet/],
    [() => row({ operator: "0x00000000000000000000000000000000000000bb" }), /another operator/],
    [() => row({ active: false }), /inactive on chain/],
  ];
  for (const [r, re] of cases) {
    const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: r, send: ok });
    await b.advertise();
    assert.deepEqual(fns(b), ["register"], String(re));
    assert.ok(b.logs.some((l) => re.test(l)), String(re));
  }
  // another operator's row: register() reverts "not operator" on chain, exactly as before -> retried, never adopted
  let n = 0;
  const f = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row({ operator: "0x00000000000000000000000000000000000000bb" }),
    send: () => { if (++n <= 2) throw new Error("execution reverted: not operator"); return "0xhash"; } });
  await f.advertise();
  assert.deepEqual(fns(f), ["register", "register", "register"]);
});

test("a FAILED registry read sends nothing and retries; only a later SUCCESSFUL read decides (never a blind register)", async () => {
  // a failed RPC is no evidence that the row is missing or different: every outcome after two failed reads
  for (const [label, ok, want] of [["exact row", () => row({ proofKey: KEY_NEW }), []], ["old proof key", () => row(), ["setProofKey"]],
    ["missing row", () => null, ["register"]], ["inactive row", () => row({ active: false }), ["register"]],
    ["differing row", () => row({ repo: "Other/repo" }), ["register"]]]) {
    let reads = 0, sentDuringFailures = -1;
    const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, send: () => "0xtx",
      receipt: (fn) => ({ status: "success" }),
      row: () => { if (++reads <= 2) { sentDuringFailures = b.txs.length; throw new Error("HTTP request failed."); }
                   return label === "old proof key" && reads > 3 ? row({ proofKey: KEY_NEW }) : ok(); } });
    await b.advertise();
    assert.equal(sentDuringFailures, 0, `${label}: zero writes while the reads fail`);
    assert.deepEqual(b.sleeps, [5, 10], `${label}: the normal backoff`);
    assert.ok(b.logs.some((l) => /registry read failed \(HTTP request failed\.\): no decision; the next attempt reads again/.test(l)), label);
    assert.deepEqual(fns(b), want, label);
    assert.ok(b.state().enclaveId, label);
  }
});

test("setProofKey failure: a reverted receipt or a failed send is not adopted and is retried; never escalated to register()", async () => {
  let n = 0, key = KEY_OLD;
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row({ proofKey: key }), send: () => "0xpk" + (++n),
    receipt: () => (n === 1 ? { status: "reverted" } : (key = KEY_NEW, { status: "success" })) });
  await b.advertise();
  assert.deepEqual(fns(b), ["setProofKey", "setProofKey"]);
  assert.deepEqual(b.sleeps, [5], "one backoff after the reverted attempt");
  assert.ok(b.logs.some((l) => /setProofKey 0xpk1 did not succeed \(reverted\)/.test(l)));
  assert.ok(b.state().enclaveId);
  let m = 0, k = KEY_OLD;
  const c = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row({ proofKey: k }), send: () => { if (++m <= 2) throw new Error("insufficient funds for gas * price + value"); return "0xpk"; },
    receipt: () => { k = KEY_NEW; return { status: "success" }; } });
  await c.advertise();
  assert.deepEqual(fns(c), ["setProofKey", "setProofKey", "setProofKey"]);
  assert.ok(!c.txs.some((t) => t.fn === "register"));
});

test("after a CONFIRMED setProofKey, only a fully current re-read adopts: a failed or stale re-read throws, and the next attempt adopts read-only", async () => {
  for (const [label, second] of [["failed re-read", () => { throw new Error("HTTP request failed."); }], ["stale (lagging) key", () => row()]]) {
    let reads = 0;
    // read 1: old key -> setProofKey; read 2: failed / still old -> NOT adopted; read 3: current -> adopted, no second tx
    const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (++reads === 1 ? row() : reads === 2 ? second() : row({ proofKey: KEY_NEW })), send: () => "0xpk" });
    await b.advertise();
    assert.deepEqual(fns(b), ["setProofKey"], label);
    assert.deepEqual(b.sleeps, [5], `${label}: one backoff, then a read-only adoption`);
    assert.ok(b.logs.some((l) => /after setProofKey 0xpk the row is not adoptable yet/.test(l)), label);
    assert.ok(b.logs.some((l) => /adopted the existing registration .*already registered exactly.*no transaction/.test(l)), label);
    assert.ok(b.state().enclaveId, label);
  }
  // still stale on the next attempt too: no adoption; that attempt publishes this boot's key again
  let reads = 0;
  const c = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (++reads <= 3 ? row() : row({ proofKey: KEY_NEW })), send: () => "0xpk" });
  await c.advertise();
  assert.deepEqual(fns(c), ["setProofKey", "setProofKey"]);
  // concurrent entry points (boot loop + request middleware) still send one transaction
  const d = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (d.reads.length >= 2 ? row({ proofKey: KEY_NEW }) : row()), send: () => "0xpk" });
  await Promise.all([d.advertise(), d.registerSelf(), d.advertise()]);
  assert.deepEqual(fns(d), ["setProofKey"]);
});

test("a superseded key is never accepted on the strength of an earlier receipt", async () => {
  // the receipt confirms OUR key, but the re-read shows another one (a later writer): not adopted
  const OTHER = "0x000000000000000000000000000000000000c0de";
  let reads = 0;
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (++reads === 1 ? row() : reads === 2 ? row({ proofKey: OTHER }) : row({ proofKey: KEY_NEW })), send: () => "0xpk" });
  await b.advertise();
  assert.deepEqual(fns(b), ["setProofKey"], "not adopted on read 2; read 3 shows our key current: read-only adoption");
  assert.ok(b.logs.some((l) => /not adoptable yet \(only the proof key differs\)/.test(l)));
  assert.ok(b.state().enclaveId);
});

test("after setProofKey: a deactivated row or any other changed field is not adopted; the next attempt takes the matching path", async () => {
  let reads = 0;
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (++reads === 1 ? row() : reads === 2 ? row({ proofKey: KEY_NEW, active: false }) : row({ active: false })),
    send: () => "0xtx" });
  await b.advertise();
  assert.deepEqual(fns(b), ["setProofKey", "register"]);
  assert.ok(b.logs.some((l) => /not adoptable yet \(inactive on chain/.test(l)));
  for (const over of [{ repo: "Other/repo" }, { measurement: "0x02" }, { cpuPricePerSec6: 9n }, { gpuPricePerSec6: 9n }]) {
    let r = 0;
    const c = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => (++r === 1 ? row() : row({ ...over, proofKey: KEY_NEW })), send: () => "0xtx" });
    await c.advertise();
    assert.deepEqual(fns(c), ["setProofKey", "register"], JSON.stringify(over, (k, v) => typeof v === "bigint" ? String(v) : v));
    assert.ok(c.logs.some((l) => /not adoptable yet \(the registered fields differ\)/.test(l)));
  }
});

test("root confirms setProofKey externally (the box's own send cannot be pre-paid): the box adopts read-only", async () => {
  let rootSent = false, n = 0;
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_NEW, row: () => row({ proofKey: rootSent ? KEY_NEW : KEY_OLD }),
    send: () => { if (++n === 2) rootSent = true; throw new Error("insufficient funds for gas * price + value"); } });
  await b.advertise();
  assert.deepEqual(fns(b), ["setProofKey", "setProofKey"], "two refused sends, then the row is current");
  assert.ok(b.logs.some((l) => /already registered exactly.*no transaction/.test(l)));
  assert.ok(b.state().enclaveId);
});

test("repoint: an adopted row on registry A does not stand for registry B", async () => {
  const b = box({ PUBLIC_URL: URL0, proofKey: KEY_OLD, row: (id, reg) => (reg === "0xAAAA" ? row() : null), send: ok });
  await b.advertise();
  assert.deepEqual(b.txs, []);
  b.repoint("0xBBBB");
  await b.advertise();
  assert.deepEqual(b.txs.map((t) => [t.address, t.fn]), [["0xBBBB", "register"]]);
});
