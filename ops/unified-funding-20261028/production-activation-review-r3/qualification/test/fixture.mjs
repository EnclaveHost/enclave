// TEST FIXTURE ONLY. Scripted public chain reads for node:test; NOT a live observation and never a production pin.
// The pins, decisions and every public input come from the actual files (via generate-preparation-inputs.mjs); only the
// chain reads are scripted, and only the observation + decisions files live in a fresh temp directory.
//
// Runtime code cannot be synthesized for addresses whose code hash is pinned (receipts, deployment observation, reviewed
// fee observation): keccak preimages. PUBLIC_CODE_BUNDLE=<absolute path> supplies them, either a capture-observation.mjs
// output (only its code|<address> reads are taken) or a JSON {address: runtimeHex} map. Every entry is checked against its
// pinned hash before use; a wrong one fails the run. Without it, tests that need the real walk are skipped with the reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOK_DEPLOYMENTS, BindingRefused, CHAIN_ID, EIP1967_IMPL_SLOT, K, codehashOf, collectBindings, lower }
  from "../../production-activation-prep-r1/lib/bindings.mjs";
import { loadContext, sha } from "../../production-activation-prep-r1/lib/context.mjs";
import { OBSERVATION_SCHEMA } from "../../production-activation-prep-r1/prepare-activation.mjs";
import { generateDraft } from "../generate-preparation-inputs.mjs";

export const NOW = 1793300000;                                            // TEST clock, passed to prepare({ now })
export const TEST_PROVIDERS = Object.freeze(["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io"]);
export const TEST_BLOCK = Object.freeze({ number: "53300000", hash: `0x${"7e57".repeat(16)}`, timestamp: String(NOW - 20), baseFeePerGas: "5000000" });
export const TEST_BALANCE = "200000000000000";
const T = (n) => `0x7e57${n.toString(16).padStart(36, "0")}`;             // TEST-only addresses (legacy implementation, pools)
export const synthCode = (a) => `0xfe${lower(a).slice(2)}`;              // INVALID opcode + address: distinct, never a pinned hash

/** address -> pinned runtime code hash, from the actual pinned inputs. */
export function pinnedCodehashes(ctx, D) {
  const R = ctx.reviewedFee, h = {};
  for (const c of Object.values(ctx.receipts.byName)) h[lower(c.address)] = lower(c.runtimeCodehash);
  h[lower(D.expected.implementation)] = lower(D.expected.implementationCodehash);
  h[lower(R.oracle.address)] = R.oracle.proxyCodehash; h[lower(R.oracle.implementation)] = R.oracle.implementationCodehash;
  h[lower(R.feed.address)] = R.feed.proxyCodehash; h[lower(R.feed.aggregator)] = R.feed.aggregatorCodehash;
  h[lower(R.sequencer.address)] = R.sequencer.proxyCodehash; h[lower(R.sequencer.aggregator)] = R.sequencer.aggregatorCodehash;
  return h;
}

let bundle = null;
function codeBundle(ctx, D) {
  if (bundle) return bundle;
  const p = process.env.PUBLIC_CODE_BUNDLE;
  if (!p) return (bundle = { codes: {}, why: "PUBLIC_CODE_BUNDLE is not set: pinned runtime code cannot be synthesized (keccak preimage)" });
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const src = {};
  if (j?.schema === OBSERVATION_SCHEMA) {
    for (const [k, v] of Object.entries(j.providers?.[0]?.reads ?? {})) if (k.startsWith("code|")) src[k.slice(5)] = lower(v);
  } else for (const [a, v] of Object.entries(j ?? {})) src[lower(a)] = lower(v);
  const codes = {}, missing = [];
  for (const [a, h] of Object.entries(pinnedCodehashes(ctx, D))) {
    if (typeof src[a] !== "string") { missing.push(a); continue; }
    if (codehashOf(src[a]) !== h) throw new Error(`PUBLIC_CODE_BUNDLE code for ${a} hashes to ${codehashOf(src[a])}, not the pinned ${h}`);
    codes[a] = src[a];
  }
  return (bundle = { codes, why: missing.length ? `PUBLIC_CODE_BUNDLE lacks pinned code for ${missing.join(", ")}` : null });
}

/** The scripted, honest chain: every value the actual inputs say it must be; unpinned-hash code is synthetic. */
async function record(ctx, codes) {
  const D = ctx.decisions, R = ctx.reviewedFee, O = ctx.original, S = ctx.receipts.byName;
  const F = lower(S.FundingSessionVaultFactory.address), A = lower(S.LeaseGasDexAdapter.address), impl = lower(D.expected.implementation);
  const [usdc, weth, swapRouter, dexFactory, ledger, reserve, maxEthOut] = ctx.adapterArgs;
  const calls = {
    [K.call(F, "implementation")]: impl,
    [K.call(impl, "factory")]: F, [K.call(impl, "gasAdapter")]: A, [K.call(impl, "usdc")]: O.usdc, [K.call(impl, "book")]: O.book,
    [K.call(impl, "legacyFactory")]: O.legacyFactory,
    [K.call(A, "usdc")]: usdc, [K.call(A, "weth")]: weth, [K.call(A, "swapRouter")]: swapRouter, [K.call(A, "factory")]: dexFactory,
    [K.call(A, "ledger")]: ledger, [K.call(A, "reserve")]: reserve, [K.call(A, "maxEthOut")]: maxEthOut,
    [K.call(O.book, "addr", [BOOK_DEPLOYMENTS])]: ledger, [K.call(reserve, "ledger")]: ledger,
    [K.call(O.legacyFactory, "implementation")]: T(1),
    [K.call(D.intake.quoter, "factory")]: dexFactory, [K.call(D.intake.quoter, "WETH9")]: weth,
    ...Object.fromEntries(D.intake.feeTiers.map((t) => [K.call(A, "poolFor", [t]), T(t)])),
    [K.call(R.feed.address, "aggregator")]: R.feed.aggregator, [K.call(R.feed.address, "decimals")]: String(R.feed.decimals),
    [K.call(R.feed.address, "description")]: R.feed.description, [K.call(R.sequencer.address, "aggregator")]: R.sequencer.aggregator,
  };
  const reads = {};
  const rec = (k, v) => { if (v !== undefined) reads[k] = v; return v; };
  const r = {
    code: async (a) => rec(K.code(a), codes[lower(a)] ?? (lower(a) === lower(D.relayer) ? "0x" : synthCode(a))),
    call: async (a, fn, args = []) => rec(K.call(a, fn, args), calls[K.call(a, fn, args)]),
    storage: async (a, s) => rec(K.storage(a, s), lower(a) === lower(R.oracle.address) && lower(s) === EIP1967_IMPL_SLOT
      ? `0x${"0".repeat(24)}${lower(R.oracle.implementation).slice(2)}` : undefined),
    nonce: async (a, tag) => rec(K.nonce(a, tag), "42"),
    balance: async (a) => rec(K.balance(a), TEST_BALANCE),
  };
  // without the bundle the walk stops at the first pinned code hash; the reads up to there are kept
  try { await collectBindings(r, ctx); } catch (e) { if (!(e instanceof BindingRefused)) throw e; }
  return reads;
}

const write = (dir, name, v) => { const p = path.join(dir, name); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o640 }); return p; };
const pin = (p) => ({ path: p, sha256: sha(fs.readFileSync(p)) });

/** Fresh temp dir with TEST decisions + TEST observation pinned beside the actual inputs. `decisions` mutates the decisions
 *  AFTER the honest chain is recorded (the chain does not depend on them); `observation` mutates the TEST observation. */
export async function setup({ decisions: mutD = () => {}, observation: mutO = () => {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qual-r2-")));
  const { pins, decisions } = generateDraft({ now: NOW });
  const D = { ...decisions, reviewedBy: "TEST-FIXTURE (not a review)", reviewRef: "TEST-FIXTURE production-activation-qualification-r2" };
  const pinsPath = path.join(dir, "pins.json");
  const save = () => fs.writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
  pins.inputs.decisions = pin(write(dir, "decisions.json", D));
  save();
  const ctx = await loadContext(pinsPath, { capture: true });
  const B = codeBundle(ctx, D);
  const reads = await record(ctx, B.codes);
  const o = { schema: OBSERVATION_SCHEMA, readOnly: true, test: true,
    note: "TEST FIXTURE: scripted synthetic public reads for node:test. NOT a live observation; never pin it for production.",
    capturedAt: NOW - 5, providers: TEST_PROVIDERS.map((url) => ({ url, chainId: CHAIN_ID, block: { ...TEST_BLOCK }, reads: { ...reads } })) };
  mutO(o);
  const observationPath = write(dir, "observation.json", o);
  pins.inputs.observation = pin(observationPath);
  const D2 = structuredClone(D);
  mutD(D2);
  pins.inputs.decisions = pin(write(dir, "decisions.json", D2));
  save();
  return { dir, pinsPath, observationPath, out: path.join(dir, "out"), decisions: D2, observation: o, ctx, bundleWhy: B.why };
}
