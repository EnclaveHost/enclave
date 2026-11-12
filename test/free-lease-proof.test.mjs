// supervisor.js and free leases (metal/free-lease-proof-patch.py): a lease at rate 0 gets no proof-of-time checkpoint,
// steady or final, because the ledger credits rate x proven time and the transaction is paid from the box's operator key;
// a paid lease, and one whose rate is unknown, is proven exactly as before. The operator key's runway is measured and
// said while low.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { gasRunway } from "../windows/node/gas-runway.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = fs.readFileSync(path.join(ROOT, "supervisor.js"), "utf8");
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, `markers ${a.slice(0, 30)}`); return src.slice(i, j); };
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const OPERATOR = "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB";
const soon = () => Math.floor(Date.now() / 1000) + 1800;
const lease = (id, rate, over = {}) => ({ id, rate, _onchain: true, status: "running", _leaseUntil: soon(), startedAt: Date.now() - 60_000, ...over });

function sandbox(recs, over = {}) {
  const seen = { log: [], warn: [], rounds: [], signed: [], sent: [] };
  const ctx = vm.createContext({
    console: { log: (m) => seen.log.push(m), warn: (m) => seen.warn.push(m) }, process: { env: {} }, Date, Math, Number, Object, String, Set,
    PROOF_READY: () => true, PROOF_INTERVAL_SEC: 300, _proof: { at: 0, proved: 0, rejected: 0, lastError: null },
    DEPLOYMENTS_ADDRESS: LEDGER, PROOF_OF_TIME_ADDRESS: "0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2", PROOF_ABI: [], CLAIM_READY: true,
    deployments: new Map(recs.map(r => [r.id, r])), gasRunway,
    proveAllLeases: async (mine, why) => { seen.rounds.push({ ids: Array.from(mine, r => r.id), why }); return mine.length; },
    chainClient: { getBlock: async () => ({ number: 100n, parentHash: "0x" + "11".repeat(32) }), getBalance: async () => over.wei ?? 10n ** 15n },
    signCheckpoint: async (rec, upto) => { seen.signed.push(rec.id); return { id: rec.id, upto }; },
    planCheckpoints: async ({ batch }) => batch.map(cp => ({ address: LEDGER, functionName: "checkpoint", args: [cp.id], ids: [cp.id] })),
    sendOperatorTx: (address, abi, fn, args) => { seen.sent.push(args[0]); const p = Promise.resolve("0xhash"); p.receipt = Promise.resolve({ status: "success", logs: [] }); return p; },
    claimSigner: () => ({ account: { address: OPERATOR } }),
  });
  const run = (code) => vm.runInContext(code.replace(/^const /gm, "var ").replace(/^let /gm, "var "), ctx);
  run(between(SRC, "const _freeProofSaid = new Set();", "// Is this deployment's app REALLY serving right now?"));
  run(between(SRC, "async function proofTick() {", "// A deployment is ending HERE and now"));
  run(between(SRC, "async function proveFinalPeriod(rec, why) {", "// Prove, then release, in that order"));
  return { ctx, seen };
}

test("the steady clock proves paid leases and leaves a free one alone, saying so once", async () => {
  const free = lease("0x5ff5", 0), paid = lease("0xaaaa", 0.000002), unknown = lease("0xbbbb", undefined);
  const { ctx, seen } = sandbox([free, paid, unknown]);
  await ctx.proofTick();
  assert.deepEqual(seen.rounds, [{ ids: ["0xaaaa", "0xbbbb"], why: "steady" }]);
  ctx._proof.at = 0; await ctx.proofTick();
  assert.equal(seen.rounds.length, 2);
  assert.deepEqual(seen.log, ["[proof] no checkpoints for 0x5ff5: a free lease (rate 0) has nothing to credit"]);
});

test("a host that holds only free leases sends no checkpoint round at all", async () => {
  const { ctx, seen } = sandbox([lease("0x5ff5", 0)]);
  await ctx.proofTick();
  assert.deepEqual(seen.rounds, []);
  assert.equal(seen.log.length, 1);
});

test("a free lease is not named while it would not have been proven anyway", async () => {
  const { ctx, seen } = sandbox([lease("0x5ff5", 0, { status: "provisioning" }), lease("0x6aaa", 0, { _leaseUntil: 1 })]);
  await ctx.proofTick();
  assert.deepEqual(seen.log, []);
});

test("a lease that becomes paid is proven from the next round, and named again if it turns free", async () => {
  const rec = lease("0x5ff5", 0);
  const { ctx, seen } = sandbox([rec]);
  await ctx.proofTick();
  rec.rate = 0.000001; ctx._proof.at = 0; await ctx.proofTick();
  assert.deepEqual(seen.rounds, [{ ids: ["0x5ff5"], why: "steady" }]);
  rec.rate = 0; ctx._proof.at = 0; await ctx.proofTick();
  assert.equal(seen.rounds.length, 1);
  assert.equal(seen.log.length, 2);
});

test("the final period: nothing signed or sent for a free lease, settled as before for a paid one", async () => {
  const { ctx, seen } = sandbox([]);
  await ctx.proveFinalPeriod(lease("0x5ff5", 0), "owner delete");
  assert.deepEqual([seen.signed, seen.sent], [[], []]);
  await ctx.proveFinalPeriod(lease("0xaaaa", 0.000002), "owner delete");
  assert.deepEqual([seen.signed, seen.sent], [["0xaaaa"], ["0xaaaa"]]);
  assert.match(seen.log.at(-1), /0xaaaa final period settled/);
});

test("the operator key's gas: read on its own interval, quiet while it lasts, said hourly while low", async () => {
  const ok = sandbox([]);
  await ok.ctx.operatorGasTick(); await ok.ctx.operatorGasTick();
  assert.deepEqual(ok.seen.warn, []);
  assert.equal(ok.ctx._gas.samples.length, 1, "the second call inside the interval reads nothing");
  assert.deepEqual([ok.ctx._gas.wei, ok.ctx._gas.low], [10n ** 15n, false]);

  const low = sandbox([], { wei: 160000000000n });   // what metal0's key held on 2026-11-12: less than one registration
  await low.ctx.operatorGasTick();
  assert.equal(low.seen.warn.length, 1);
  assert.match(low.seen.warn[0], new RegExp(`^\\[gas\\] operator key ${OPERATOR} is low: 0\\.000000 ETH, about 0 lease transactions' worth; once it is empty`));
  low.ctx._gas.at = 0; await low.ctx.operatorGasTick();
  assert.equal(low.seen.warn.length, 1, "not repeated within the hour");
  assert.equal(low.ctx._gas.low, true);
});

test("wiring: the gas watch rides the renewal clock and the host record reports it", () => {
  assert.match(SRC, /await stage\("proof", proofTick\);\n    await stage\("gas", operatorGasTick\);/);
  assert.match(SRC, /operatorGas: _gas\.wei === null \? null : \{/);
  assert.match(SRC, /import \{ gasRunway \} from "\.\/windows\/node\/gas-runway\.mjs";/);
});

// metal0's control image overlays its own (older) supervisor.js: the same patch must apply there, on top of the snpVm
// patch that image already carries. Skipped off that host.
const DEPLOYED = "/home/steven/enclave-prod/metal-deabf8f90/supervisor.js";
test("the patch applies to metal0's deployed supervisor generation, and not twice", { skip: !fs.existsSync(DEPLOYED) }, () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "free-lease-sup-")), "supervisor.js");
  fs.copyFileSync(DEPLOYED, tmp);
  execFileSync("python3", ["-I", path.join(ROOT, "metal/snpvm-supervisor-patch.py"), tmp]);
  execFileSync("python3", ["-I", path.join(ROOT, "metal/free-lease-proof-patch.py"), tmp]);
  execFileSync(process.execPath, ["--check", tmp]);
  const out = fs.readFileSync(tmp, "utf8");
  for (const [a, b] of [["const _freeProofSaid = new Set();", "// Is this deployment's app REALLY serving right now?"],
    ["async function proofTick() {", "// A deployment is ending HERE and now"]])
    assert.equal(between(out, a, b), between(SRC, a, b), "the deployed generation gets main's text");
  assert.throws(() => execFileSync("python3", ["-I", path.join(ROOT, "metal/free-lease-proof-patch.py"), tmp], { stdio: "pipe" }), /already skips free leases/);
  assert.throws(() => execFileSync("python3", ["-I", path.join(ROOT, "metal/free-lease-proof-patch.py"), path.join(ROOT, "supervisor.js")], { stdio: "pipe" }),
    /already skips free leases/, "main carries the change in source");
});
