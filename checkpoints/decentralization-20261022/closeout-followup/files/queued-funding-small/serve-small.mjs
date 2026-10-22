// serve-small.mjs (queued-funding-small): root-queued-recovery-20261022/serve.mjs c5b1feda with ONLY the paths, the small plan,
// the default port 39693, one more refusal (any intent in the 0.01 ETH package's journal) and per-origin request serialization
// (serial-fetch.mjs: the QuorumChain gets injected peers over the reviewed boundedFetch, one request at a time per RPC) changed.
// serve.mjs: ROOT's entry point for the optional batch top-up handoff (the same shape as the reviewed
// work/ens-outage-20261022/deposit-serve.mjs). Nothing here signs or broadcasts; the wallet is asked only from the page,
// once per intent, after the user clicks.
//   node serve-small.mjs --multicall3-codehash 0x… --expect-total-wei 1000000000000000 --state
//        fresh quorum check only: writes state.json (no intent, no wallet, no server)
//   node serve-small.mjs --multicall3-codehash 0x… --expect-total-wei 1000000000000000 --prepare
//        fresh check, then ONE journaled intent through the external signer (quorum simulation, gas estimate, agreed
//        pending nonce, fee caps): writes request.json. Nothing is sent and the wallet is not asked.
//   node serve-small.mjs --multicall3-codehash 0x… --expect-total-wei 1000000000000000 --serve [--port 39693]
//        loopback-only page; writes local-url.txt (0600, carries the page token). The wallet is asked only when the
//        user clicks "Review in MetaMask", after a fresh recheck and exact simulation at a new agreed block.
// The Multicall3 code hash is root's independently established value; it is never assumed here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(HERE, "../..");
const { QuorumChain } = await import(path.join(W, "wallet-handoff-bridge/tree/cli/independent.mjs"));
const { intentJournal } = await import(path.join(W, "wallet-handoff-bridge/tree/cli/independent-signer.mjs"));
const { createBridge } = await import(path.join(W, "ens-outage-20261022/deposit-ui/bridge.mjs"));
const { batchPlan, PLAN_PREFIX } = await import(path.join(HERE, "batch-plan-small.mjs"));

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const mode = ["--state", "--prepare", "--serve"].find((m) => process.argv.includes(m));
if (!mode || !arg("--multicall3-codehash") || !arg("--expect-total-wei")) {
  console.error("usage: serve.mjs --multicall3-codehash 0x… --expect-total-wei WEI --state|--prepare|--serve [--port N]"); process.exit(2);
}
const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const journalDir = path.join(HERE, "journal");
const journal = intentJournal(journalDir);
// other journals that hold this account's intents: an unresolved one there shares the nonce space, so nothing here proceeds
const OTHER_JOURNALS = [path.join(W, "ens-outage-20261022/deposit-journal"), path.join(W, "root-queued-recovery-20261022/journal")].filter((d) => fs.existsSync(d));
for (const d of OTHER_JOURNALS) {
  const open = intentJournal(d).unresolved(OWNER, 8453);            // read-only scan; throws on an unreadable intent file
  if (open.length) { console.error(`refusing: intent ${open[0].id} (${open[0].state}) in ${d} is unresolved for ${OWNER}; settle it first`); process.exit(3); }
}
// the 0.01 ETH package and this one fund the SAME 10 reserves: any intent of a batch plan in its journal (open, confirmed or
// anything else) refuses here, so the two are never both paid
const bigJournal = path.join(W, "root-queued-recovery-20261022/journal");
if (fs.existsSync(bigJournal)) {
  const any = intentJournal(bigJournal).list().filter((r) => String(r.bridge?.plan || "").startsWith(PLAN_PREFIX));
  if (any.length) { console.error(`refusing: the 0.01 ETH batch package has intent ${any[0].id} (${any[0].state}); one of the two batches only`); process.exit(3); }
}
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
const plan = batchPlan({ manifest, from: OWNER, multicall3CodeHash: arg("--multicall3-codehash"), expectTotalWei: arg("--expect-total-wei"), intents: () => journal.list() });
// the same three RPCs, quorum 2, confirmations 2, freshness 120 s; only the peers' transport is serialized per origin
const { createRequire } = await import("node:module");
const vreq = createRequire(path.join(W, "wallet-handoff-bridge/tree/cli/independent.mjs"));      // the viem QuorumChain itself uses
const { createPublicClient, http: viemHttp } = await import(vreq.resolve("viem"));
const { base } = await import(vreq.resolve("viem/chains"));
const { boundedFetch } = await import(path.join(W, "wallet-handoff-bridge/tree/network/authority-profile.mjs"));
const { serialPeers } = await import(path.join(HERE, "serial-fetch.mjs"));
const RPCS = ["https://mainnet.base.org", "https://base-rpc.polkachu.com", "https://base-rpc.publicnode.com"];
const chain = new QuorumChain({ clients: serialPeers({ rpcs: RPCS, createPublicClient, viemHttp, chain: base, boundedFetch, timeoutMs: 12000 }),
  chainId: 8453, quorum: 2, confirmations: 2, maxBlockAgeMs: 120000 });
// about 10 deposits (each an external ledger.get) + Multicall3 overhead: the signer's own estimate decides; these are ceilings
const bridge = createBridge({ chain, plan, journalDir, maxFeeGwei: 0.1, gasCap: 1_200_000n, waitOpts: { timeoutMs: 180000, pollMs: 3000 },
  log: (m) => console.error(`[batch-topup] ${m}`) });
const out = (f, v) => fs.writeFileSync(path.join(HERE, f), JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x), 2) + "\n", { mode: 0o600 });

if (mode === "--state" || mode === "--prepare") {
  const state = await bridge.state({ fresh: true });
  out("state.json", { plan: plan.id, manifestSha256: plan.manifestSha256, state });
  const step = state.steps[0];
  console.log(JSON.stringify({ plan: plan.id, verdict: step.verdict.state, reason: step.verdict.reason || null, canPrepare: step.canPrepare, block: step.verdict.block }, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
  if (mode === "--prepare") {
    if (!step.canPrepare) { console.error("not prepared: the step is not ready (see state.json)"); process.exit(2); }
    const r = await bridge.prepare(step.id);
    out("request.json", r);
    console.log(JSON.stringify({ prepared: r.id, nonce: r.nonce, to: r.params.to, value: r.params.value, calldataKeccak: r.calldataKeccak, maxNetworkFeeWei: r.maxNetworkFeeWei }));
  }
} else {
  const x = await bridge.listen({ port: Number(arg("--port") || 39693) });
  fs.writeFileSync(path.join(HERE, "local-url.txt"), x.url + "\n", { mode: 0o600 });
  console.log(`Batch top-up handoff listening on ${x.origin}; the page URL (with its token) is in local-url.txt. No wallet request was sent.`);
  process.on("SIGTERM", () => x.close());
  process.on("SIGINT", () => x.close().then(() => process.exit(0)));
}
