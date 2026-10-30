// The boot GPU-price race (2026-10-23, metal0; D's review of 9f6d37bd): gsup starts the supervisor with GPU_COUNT=0, so its
// GPU price is 0 until the shielded card's probe passes, and advertise() runs before that. Tested on the REAL code paths:
//   - gsup.mjs is actually RUN (test/helpers/gsup-env-harness.mjs) on a metal0-shaped host config to capture the supervisor env;
//   - the supervisor's own price declarations (GPU_COUNT, IS_GPU, SELL_*_PRICE6, the pending state) are evaluated with exactly
//     that env, and its registerOnChain / bootRegistration(Action) / advertise / syncRegisteredPrice / adoptShieldedCards run
//     against a stub registry that applies register / setProofKey / setPrices on their receipts;
//   - BASELINE COUNTEREXAMPLE: the same scenario on 9f6d37bd's gsup + supervisor (the staged 08d1f838 image).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayReconcile } from '../network/registry-reconcile.mjs';

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(REPO, 'test/helpers/gsup-env-harness.mjs');
const BASE = '92223d0df0d488c0b33a47152b4636d17e5a09cb';
const CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app';
const FWCFG = '/sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.metal/raw';
const OP = '0x00000000000000000000000000000000000000aa';
const URL0 = 'https://api.enclave.host/t/metal0';
// metal0-shaped host config: per-app isolation, one shielded card on the untrusted host priced at $6/card-hr (= 1667/sec)
const ISO = { managerUrl: 'http://10.0.2.2:8095', pairingKey: 'ab'.repeat(32), dataAddr: '10.0.2.2:8096', release: true };
const FW_GPU = { name: 'metal0', publicUrl: URL0, relayUrl: 'wss://api.enclave.host/v1/fleet-tunnel', registryKey: '0x' + '11'.repeat(32),
  nodeRamGb: 96, isolation: ISO, isolationShieldedWorkers: [{ port: 9555, priceUsdHr: 6 }] };
const FW_CPU = { ...FW_GPU, isolationShieldedWorkers: undefined };

async function runGsup(gsupFile, fw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsup-env-'));
  try {
    const out = path.join(dir, 'supervisor-spawn.json');
    const H = { out, files: { '/proc/cmdline': CMDLINE + '\n', [FWCFG]: JSON.stringify(fw), '/opt/metal/flavor-env.json': '{}' } };
    await pexec(process.execPath, ['--import', HARNESS, gsupFile], { env: { PATH: process.env.PATH, GSUP_HARNESS: JSON.stringify(H) }, cwd: dir, timeout: 30000 });
    return JSON.parse(fs.readFileSync(out, 'utf8')).env;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// 9f6d37bd's gsup, run as a byte copy beside the real bundles it imports (same relative paths), as the custody env test does
async function runBaseGsup(fw) {
  const dir = fs.mkdtempSync(path.join(REPO, 'metal/guest/.base-'));
  try {
    for (const f of fs.readdirSync(path.join(REPO, 'metal/guest'))) if (/\.mjs$/.test(f) && f !== 'gsup.mjs') fs.copyFileSync(path.join(REPO, 'metal/guest', f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'gsup.mjs'), execFileSync('git', ['-C', REPO, 'show', `${BASE}:metal/guest/gsup.mjs`]));
    return await runGsup(path.join(dir, 'gsup.mjs'), fw);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// mutation runs (../mutants-price.sh) point these at a mutated copy; normally the repo's own files
const GSUP = process.env.BOOT_PRICE_GSUP || path.join(REPO, 'metal/guest/gsup.mjs');
const CURRENT_SRC = fs.readFileSync(process.env.BOOT_PRICE_SUPERVISOR || path.join(REPO, 'supervisor.js'), 'utf8');
const BASE_SRC = execFileSync('git', ['-C', REPO, 'show', `${BASE}:supervisor.js`], { maxBuffer: 64 << 20 }).toString();

function pieces(src) {
  const one = (re, what, optional = false) => { const m = re.exec(src); if (!m && !optional) throw new Error(`${what} not in supervisor.js`); return m ? m[0] : ''; };
  return [
    one(/^let GPU_COUNT .*$/m, 'GPU_COUNT'), one(/^let IS_GPU .*$/m, 'IS_GPU'),
    one(/^const SELL_CPU_PRICE6 = .*$/m, 'SELL_CPU_PRICE6'), one(/^let SELL_GPU_PRICE6 .*$/m, 'SELL_GPU_PRICE6'),
    one(/^const SHIELDED_GPU_EXPECTED[\s\S]*?\nfunction gpuPricePending\(now = Date\.now\(\)\) \{[\s\S]*?\n\}/m, 'the pending state', true),
    one(/function registryRepointed\(\) \{[\s\S]*?\n\}/, 'registryRepointed'),
    one(/async function registerOnChain\(endpoint\) \{[\s\S]*?\n\}/, 'registerOnChain'),
    one(/async function bootRegistration\(id, endpoint, proofKey\) \{[\s\S]*?\n\}/, 'bootRegistration'),
    one(/function bootRegistrationAction\(row, want\) \{[\s\S]*?\n\}/, 'bootRegistrationAction'),
    one(/async function syncRegisteredPrice\(id\) \{[\s\S]*?\n\}/, 'syncRegisteredPrice'),
    one(/function adoptShieldedCards\(values\) \{[\s\S]*?\n\}/, 'adoptShieldedCards'),
    one(/async function registerSelf\(\) \{[\s\S]*?\n\}/, 'registerSelf'),
    one(/function advertised\(\) \{[\s\S]*?\n\}/, 'advertised'),
    one(/let _advertising = false;\nasync function advertise\(\) \{[\s\S]*?\n\}/, 'advertise'),
  ].join('\n');
}

// One supervisor process: its env (as gsup handed it), a clock, and the registry row it will find.
function box(src, env, { row = null, failReads = 0, sendFails = 0 } = {}) {
  const chain = { row: row && { ...row }, txs: [], reads: 0 };
  const clock = { t: 1_000_000 };
  const logs = [], sleeps = [], passes = [];
  const make = new Function('process', 'Date', 'chain', 'clock', 'logs', 'sleeps', 'passes', 'mayReconcile', 'failReads', 'sendFails', `
    let REGISTRY_ADDRESS = "0xAAAA";
    const REGISTRY_READY = true, PUBLIC_URL = process.env.PUBLIC_URL || "", RECONCILE_SEC = 900;
    let _registered = false, _registeredOn = null, _enclaveId = null, _advertisedEndpoint = null, _activeSeen = null;
    const keccak256 = (b) => "id(" + b + ")", stringToBytes = (s) => s;
    const registryRev = async () => 4;
    const PROOF_ACCOUNT = { address: "0x000000000000000000000000000000000000bEEF" }, REGISTRY_ABI = [], REGISTRY_ABI_V2 = [], REGISTRY_ABI_V1 = [];
    const ENCLAVE_REPO = "EnclaveHost/enclave", ENCLAVE_MEASUREMENT = "0x" + "00".repeat(32);
    const claimSigner = () => ({ account: { address: "${OP}" } });
    let reads = 0, sends = 0;
    const registryEntry = async (id) => {
      chain.reads++;
      if (++reads <= failReads) throw new Error("HTTP request failed.");
      return chain.row ? { ...chain.row } : null;
    };
    const sendOperatorTx = (address, _abi, fn, args) => {
      const p = Promise.resolve().then(() => {
        if (++sends <= sendFails) throw new Error("insufficient funds for gas * price + value");
        chain.txs.push({ fn, args: [...args] });   // exactly as sent: uint64 prices stay BigInt
        return "0xtx" + chain.txs.length;
      });
      p.receipt = p.then(() => {
        const a = chain.txs[chain.txs.length - 1].args;
        if (fn === "register") chain.row = { endpoint: a[0], repo: a[1], measurement: a[2], operator: "${OP}", active: true,
          cpuPricePerSec6: BigInt(a[3]), gpuPricePerSec6: BigInt(a[4]), proofKey: a[5] };
        if (fn === "setProofKey") chain.row = { ...chain.row, proofKey: a[1] };
        if (fn === "setPrices") chain.row = { ...chain.row, cpuPricePerSec6: BigInt(a[1]), gpuPricePerSec6: BigInt(a[2]) };
        return { status: "success" };
      });
      p.receipt.catch(() => {});
      return p;
    };
    const setInterval = (fn) => { passes.push(fn); return { unref() {} }; };
    const setTimeout = (fn, ms) => { if (sleeps.length >= 50) throw new Error("still not registered after 50 retries"); sleeps.push(ms / 1000); setImmediate(fn); return { unref() {} }; };
    const syncRegisteredProofKey = async () => {}, syncDeclaredPayoutWallet = async () => {}, syncRegisteredActive = async () => {};
    // what adoptShieldedCards touches besides the price
    let gpuCards = [], _shieldedAdopted = false, _shieldedPool = null, CARD_VRAM_SRC = "default", CARD_VRAM_GB = 141, CARD_TFLOPS = 989, SM_TOTAL = 0;
    const round1 = (x) => Math.round(x * 10) / 10, reconcilePools = () => {};
    const console = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    ${pieces(src)}
    return { advertise, sell: () => ({ IS_GPU, SELL_CPU_PRICE6, SELL_GPU_PRICE6, pending: typeof gpuPricePending === "function" ? gpuPricePending() : null }),
      // the shielded probe passes: the card's verdict reaches adoptShieldedCards (pricePerSec6 as gsup writes it)
      discover: (pricePerSec6) => adoptShieldedCards([{ id: 0, vramGb: 24, vramBudgetGb: 20, cardTflops: 82, pricePerSec6 }]),
      enclaveId: () => _enclaveId };`);
  const b = make({ env }, { now: () => clock.t }, chain, clock, logs, sleeps, passes, mayReconcile, failReads, sendFails);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return Object.assign(b, { chain, clock, logs, sleeps, settle,
    pass: async () => { for (const fn of passes) await fn(); await settle(); } });
}
// metal0's actual row (root's 2-RPC read, block 53001451): this operator's, active, every field exact but the old boot's proof key
const METAL0_ROW = { endpoint: URL0, repo: 'EnclaveHost/enclave', measurement: '0x' + '00'.repeat(32), operator: OP, active: true,
  cpuPricePerSec6: 834n, gpuPricePerSec6: 1667n, proofKey: '0x8604ce59f394daf05b235122E5Dc054F5C2bB453' };
const fns = (b) => b.chain.txs.map((t) => t.fn);

test('the captured gsup env: GPU_COUNT=0, no GPU price, and (fix) the expected shielded card', async () => {
  const now = await runGsup(GSUP, FW_GPU);
  assert.equal(now.GPU_COUNT, '0'); assert.equal(now.SELL_GPU_PRICE6, undefined); assert.equal(now.SHIELDED_GPU_EXPECTED, '1');
  assert.equal((await runGsup(GSUP, FW_CPU)).SHIELDED_GPU_EXPECTED, undefined, 'a CPU-only host expects nothing');
  assert.equal((await runGsup(GSUP, { ...FW_GPU, isolationShieldedWorkers: [{ priceUsdHr: 6 }] })).SHIELDED_GPU_EXPECTED, undefined,
    'a worker without a port is never probed, so it is not expected either');
  const base = await runBaseGsup(FW_GPU);
  assert.equal(base.GPU_COUNT, '0'); assert.equal(base.SHIELDED_GPU_EXPECTED, undefined);
});

test('BASELINE COUNTEREXAMPLE (9f6d37bd = staged 08d1f838): advertise before discovery sends a full register(gpu=0), then re-prices to 1667', async () => {
  const b = box(BASE_SRC, await runBaseGsup(FW_GPU), { row: METAL0_ROW });
  assert.deepEqual(b.sell(), { IS_GPU: false, SELL_CPU_PRICE6: 834, SELL_GPU_PRICE6: 0, pending: null });
  await b.advertise(); await b.settle();
  assert.deepEqual(fns(b), ['register'], 'not the setProofKey the funding preflight priced');
  assert.equal(b.chain.txs[0].args[4], 0n, 'register() writes GPU price 0: the row loses its 1667');
  assert.ok(b.logs.some((l) => /the registered fields differ/.test(l)));
  b.discover(1667); await b.settle();
  assert.deepEqual(fns(b), ['register', 'setPrices'], 'and discovery pays a second transaction to put 1667 back');
  assert.deepEqual(b.chain.txs[1].args.slice(1), [834n, 1667n]);
});

test('FIX: before discovery the boot takes ONE setProofKey, keeps the row\'s 1667, and discovery sends nothing', async () => {
  const b = box(CURRENT_SRC, await runGsup(GSUP, FW_GPU), { row: METAL0_ROW });
  assert.deepEqual(b.sell(), { IS_GPU: false, SELL_CPU_PRICE6: 834, SELL_GPU_PRICE6: 0, pending: true });
  await b.advertise(); await b.settle();
  assert.deepEqual(fns(b), ['setProofKey']);
  assert.ok(b.enclaveId(), 'adopted after the receipt and an exact re-read');
  assert.ok(b.logs.some((l) => /only the proof key differs; GPU price pending shielded discovery/.test(l)));
  await b.pass();                                   // the reconcile pass (and the immediate sync after adoption) before discovery
  assert.deepEqual(fns(b), ['setProofKey'], 'no setPrices(834, 0) while the card is still being discovered');
  assert.equal(b.chain.row.gpuPricePerSec6, 1667n);
  b.discover(1667); await b.settle(); await b.pass();
  assert.deepEqual(b.sell(), { IS_GPU: true, SELL_CPU_PRICE6: 834, SELL_GPU_PRICE6: 1667, pending: false });
  assert.deepEqual(fns(b), ['setProofKey'], 'the discovered price is the row\'s: nothing to publish');
});

test('the fix needs gsup\'s expectation: the new supervisor under the old gsup env behaves exactly as before (no silent pending)', async () => {
  const b = box(CURRENT_SRC, await runBaseGsup(FW_GPU), { row: METAL0_ROW });
  assert.equal(b.sell().pending, false);
  await b.advertise(); await b.settle();
  assert.deepEqual(fns(b), ['register']); assert.equal(b.chain.txs[0].args[4], 0n);
});

test('CPU-only host: never pending; an exact row takes setProofKey, a row still carrying a GPU price is corrected as before', async () => {
  const env = await runGsup(GSUP, FW_CPU);
  const a = box(CURRENT_SRC, env, { row: { ...METAL0_ROW, gpuPricePerSec6: 0n } });
  assert.equal(a.sell().pending, false);
  await a.advertise(); await a.settle(); await a.pass();
  assert.deepEqual(fns(a), ['setProofKey']);
  const b = box(CURRENT_SRC, env, { row: METAL0_ROW });
  await b.advertise(); await b.settle();
  assert.deepEqual(fns(b), ['register']); assert.equal(b.chain.txs[0].args[4], 0n, 'no card: no GPU price claimed');
});

test('failed or absent discovery is bounded: no re-price during the 15 min wait, then 0 is published as before (no permanent stall)', async () => {
  const b = box(CURRENT_SRC, await runGsup(GSUP, FW_GPU), { row: METAL0_ROW });
  await b.advertise(); await b.settle();
  b.clock.t += 14 * 60_000; await b.pass();
  assert.deepEqual(fns(b), ['setProofKey']);
  b.clock.t += 61_000; await b.pass();
  assert.equal(b.sell().pending, false);
  assert.deepEqual(fns(b), ['setProofKey', 'setPrices']);
  assert.deepEqual(b.chain.txs[1].args.slice(1), [834n, 0n], 'no card after the wait: the row stops claiming one');
  // a late card still takes the box back to its price
  b.discover(1667); await b.settle();
  assert.deepEqual(b.chain.txs[2].args.slice(1), [834n, 1667n]);
});

test('while pending: a failed read defers (no register at an unknown price), another differing field registers with the row\'s own GPU price', async () => {
  const env = await runGsup(GSUP, FW_GPU);
  const a = box(CURRENT_SRC, env, { row: METAL0_ROW, failReads: 2 });
  await a.advertise(); await a.settle();
  assert.deepEqual(fns(a), ['setProofKey'], 'two failed reads: retried, never a full register');
  assert.deepEqual(a.sleeps, [5, 10]);
  assert.ok(a.logs.some((l) => /registry read failed \(HTTP request failed\.\): no decision; the next attempt reads again/.test(l)));
  const b = box(CURRENT_SRC, env, { row: { ...METAL0_ROW, cpuPricePerSec6: 900n } });
  await b.advertise(); await b.settle();
  assert.deepEqual(fns(b), ['register']);
  assert.deepEqual(b.chain.txs[0].args.slice(3, 5), [834n, 1667n], 'the CPU price is restated, the GPU price stays the row\'s own');
  const f = box(CURRENT_SRC, env, { row: { ...METAL0_ROW, operator: '0x' + 'bb'.repeat(20) } });
  await f.advertise(); await f.settle();
  assert.equal(f.chain.txs[0].fn, 'register'); assert.equal(f.chain.txs[0].args[4], 0n, 'another operator\'s GPU price is not ours to restate');
  // no row of ours to keep a price from: 0 (nothing discovered), and discovery publishes the card's price afterwards
  const c = box(CURRENT_SRC, env, { row: null });
  await c.advertise(); await c.settle();
  assert.equal(c.chain.txs[0].args[4], 0n);
  c.discover(1667); await c.settle();
  assert.deepEqual(fns(c), ['register', 'setPrices']);
});

test('owner re-pricing is published only once the card is adopted; a CPU re-price while pending keeps the GPU price', async () => {
  const env = await runGsup(GSUP, FW_GPU);
  const b = box(CURRENT_SRC, env, { row: METAL0_ROW });
  await b.advertise(); await b.settle(); await b.pass();
  assert.deepEqual(fns(b), ['setProofKey']);
  b.discover(556); await b.settle();                   // the operator changed the card to $2/hr
  assert.deepEqual(fns(b), ['setProofKey', 'setPrices']);
  assert.deepEqual(b.chain.txs[1].args.slice(1), [834n, 556n]);
  const c = box(CURRENT_SRC, { ...env, SELL_CPU_PRICE6: '900' }, { row: METAL0_ROW });
  await c.advertise(); await c.settle();
  assert.deepEqual(fns(c), ['register'], 'a CPU difference still re-registers (the boot restates prices)');
  assert.deepEqual(c.chain.txs[0].args.slice(3, 5), [900n, 1667n]);
});

test('a FAILED registry read sends nothing in every state (pending, discovered, CPU-only); only a later successful read decides', async () => {
  const gpuEnv = await runGsup(GSUP, FW_GPU), cpuEnv = await runGsup(GSUP, FW_CPU);
  const states = [
    ['pending', gpuEnv, false, METAL0_ROW],
    ['card discovered before the first read', gpuEnv, true, METAL0_ROW],
    ['CPU-only', cpuEnv, false, { ...METAL0_ROW, gpuPricePerSec6: 0n }],
  ];
  for (const [state, env, discoverFirst, exact] of states) {
    for (const [what, row, want, gpu] of [
      ['exact row (old proof key)', exact, ['setProofKey'], null],
      ['missing row', null, ['register'], discoverFirst ? 1667n : 0n],
      ['inactive row', { ...exact, active: false }, ['register'], exact.gpuPricePerSec6],
      ['differing row', { ...exact, repo: 'Other/repo' }, ['register'], exact.gpuPricePerSec6]]) {
      const label = `${state} / ${what}`;
      const b = box(CURRENT_SRC, env, { row, failReads: 2 });
      if (discoverFirst) b.discover(1667);
      assert.equal(b.sell().pending, state === 'pending', label);
      // the first attempt: one failed read, nothing sent; the loop retries (5 s, then 10 s)
      await b.advertise(); await b.settle();
      assert.deepEqual(b.sleeps, [5, 10], label);
      assert.ok(b.logs.filter((l) => /registry read failed \(HTTP request failed\.\): no decision/.test(l)).length === 2, label);
      assert.deepEqual(fns(b), want, `${label}: the later successful read decides`);
      if (gpu !== null) assert.equal(b.chain.txs[0].args[4], gpu, `${label}: GPU price written`);
      assert.ok(b.enclaveId(), label);
    }
  }
});

test('the pending GPU price is restated EXACTLY: a uint64 beyond Number precision survives a register and a CPU re-price', async () => {
  const HUGE = 2n ** 63n + 12345n;                     // > Number.MAX_SAFE_INTEGER: Number() would round it
  assert.notEqual(BigInt(Number(HUGE)), HUGE);
  const env = await runGsup(GSUP, FW_GPU);
  // a CPU difference at boot while pending: register() restates the row's exact GPU price
  const a = box(CURRENT_SRC, env, { row: { ...METAL0_ROW, cpuPricePerSec6: 900n, gpuPricePerSec6: HUGE } });
  await a.advertise(); await a.settle();
  assert.deepEqual(fns(a), ['register']);
  assert.equal(a.chain.txs[0].args[3], 834n); assert.equal(a.chain.txs[0].args[4], HUGE);
  assert.equal(a.chain.row.gpuPricePerSec6, HUGE);
  // an adopted row whose CPU price then differs: the reconcile pass re-prices the CPU and restates the exact GPU price
  const b = box(CURRENT_SRC, env, { row: { ...METAL0_ROW, gpuPricePerSec6: HUGE } });
  await b.advertise(); await b.settle(); await b.pass();
  assert.deepEqual(fns(b), ['setProofKey'], 'the huge price compares equal: nothing to re-price');
  b.chain.row = { ...b.chain.row, cpuPricePerSec6: 900n };
  await b.pass();
  assert.deepEqual(fns(b), ['setProofKey', 'setPrices']);
  assert.deepEqual(b.chain.txs[1].args.slice(1), [834n, HUGE]);
});
