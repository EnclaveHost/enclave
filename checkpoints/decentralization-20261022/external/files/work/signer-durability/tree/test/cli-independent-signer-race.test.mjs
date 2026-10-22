// One unresolved intent per signing account: concurrent sends from one journal, in one process and in separate
// processes, against a real anvil chain read through the CLI's QuorumChain. Every send is held at its first
// pending-nonce read until every other send has either reached that read too or finished, so the interleaving that
// raced in the old module (both pass the busy check, both read nonce N, both ask the wallet) is forced, not hoped for.
//   run: node --test --test-concurrency=1 test/cli-independent-signer-race.test.mjs
//   negative control: SIGNER_TREE=<tree with the old module> node --test ... (expected to FAIL: two intents at one nonce)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp } from "viem";
import { foundry } from "viem/chains";
import { A0, SINK, WAIT, tools, anvil, walletServer, forward, gatedChain, until, child, tmpRoot, cleanup } from "./helpers/signer-harness.mjs";

const TREE = path.resolve(process.env.SIGNER_TREE || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const S = await import(pathToFileURL(path.join(TREE, "cli/independent-signer.mjs")).href);
const { QuorumChain } = await import(pathToFileURL(path.join(TREE, "cli/independent.mjs")).href);
const T = tools ? { skip: tools } : { timeout: 120000 };

let chainRpc, walletRpc, pc, chain, tmp, n = 0;
const jdir = () => path.join(tmp, `journal-${++n}`);
const nonceOf = () => pc.getTransactionCount({ address: A0.address });
before(async () => {
  if (tools) return;
  ({ url: chainRpc, c: pc } = await anvil());
  ({ url: walletRpc } = await anvil());
  await pc.request({ method: "anvil_setCode", params: [SINK, "0x00"] });
  const c = () => createPublicClient({ chain: foundry, transport: viemHttp(chainRpc) });
  chain = new QuorumChain({ clients: [{ origin: chainRpc + "/a", client: c() }, { origin: chainRpc + "/b", client: c() }], quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
  tmp = tmpRoot("signer-race-");
});
after(() => cleanup(tmp));

const summary = (dir) => S.intentJournal(dir).list().map((r) => `${r.id} ${r.state} nonce ${r.nonce}`).join("; ");
/** Two sends at once in THIS process, each held at its pending-nonce read until both have reached it or finished. */
async function racePair(signers, opts) {
  let arrivals = 0, go;
  const gate = new Promise((r) => (go = r));
  const gated = gatedChain(chain, async () => { arrivals++; await gate; });
  const out = [];
  const runs = signers.map((s, i) => s.sendQuorumTx(gated, { to: SINK, data: `0x0${i + 1}`, ...WAIT, ...opts }).then((v) => (out[i] = { v }), (e) => (out[i] = { e })));
  await until(() => arrivals + out.filter(Boolean).length === signers.length, 15000, "both sends to reach the nonce read or finish");
  const arrivedBeforeGo = arrivals;
  go();
  await Promise.all(runs);
  return { out, arrivedBeforeGo };
}

test("same process, two signer objects on one journal (handoff): one intent; the other send never reads the nonce", T, async () => {
  const dir = jdir();
  const mk = () => S.createExternalSigner({ from: A0.address, chainId: 31337, mode: "handoff", journalDir: dir, onHandoff: (rec) => ({ handoff: rec.id, nonce: rec.nonce }) });
  const { out, arrivedBeforeGo } = await racePair([mk(), mk()]);
  const handoffs = S.intentJournal(dir).list().filter((r) => r.state === "handoff");
  assert.equal(handoffs.length, 1, `unresolved handoff intents for one account: ${summary(dir)}`);
  assert.equal(arrivedBeforeGo, 1, "only one send read the pending nonce");
  const busy = out.find((o) => o.e);
  assert.equal(busy?.e?.code, "busy");
});

test("same process, ONE signer object, two sends (wallet-send): the wallet is asked to send once", T, async () => {
  const w = await walletServer(async (m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } } : forward(chainRpc)(m));
  const s = S.createExternalSigner({ url: w.url, from: A0.address, chainId: 31337, mode: "wallet-send", journalDir: jdir(), approvalTimeoutMs: 5000, probeTimeoutMs: 2000 });
  const before = await nonceOf();
  const { out } = await racePair([s, s]);
  assert.equal(w.count("eth_sendTransaction"), 1, `eth_sendTransaction requests: ${w.count("eth_sendTransaction")}; intents: ${summary(s.journal.dir)}`);
  assert.equal(out.filter((o) => o.v?.status === "success").length, 1);
  assert.equal(out.find((o) => o.e)?.e?.code, "busy");
  assert.equal(await nonceOf(), before + 1);
});

test("same process, two signer objects (sign): one signature request, one broadcast", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const dir = jdir();
  const mk = () => S.createExternalSigner({ url: w.url, from: A0.address, chainId: 31337, mode: "sign", journalDir: dir, approvalTimeoutMs: 5000, probeTimeoutMs: 2000 });
  const before = await nonceOf();
  const { out } = await racePair([mk(), mk()]);
  assert.equal(w.count("eth_signTransaction"), 1, `eth_signTransaction requests: ${w.count("eth_signTransaction")}; intents: ${summary(dir)}`);
  assert.equal(out.filter((o) => o.v?.status === "success").length, 1);
  assert.equal(await nonceOf(), before + 1);
});

/** Two child processes on one journal: started together, each held at its nonce read until both reached it or finished. */
async function raceProcesses(cfg) {
  const kids = [0, 1].map((i) => child({ tree: TREE, chainRpc, from: A0.address, to: SINK, data: `0x0${i + 1}`, gate: true, ...cfg }));
  for (const k of kids) await k.wait("READY");
  for (const k of kids) k.send("START");
  await until(() => kids.every((k) => k.has("ARRIVED") || k.has("RESULT")), 20000, "both children to reach the nonce read or finish");
  const arrivedBeforeGo = kids.filter((k) => k.has("ARRIVED")).length;
  for (const k of kids) k.send("GO");
  for (const k of kids) await k.wait("RESULT", 30000);
  return { results: kids.map((k) => k.result()), arrivedBeforeGo };
}

test("separate processes, one journal (wallet-send): the wallet is asked to send once; the other process is refused before reading the nonce", T, async () => {
  const w = await walletServer(async (m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } } : forward(chainRpc)(m));
  const dir = jdir(), before = await nonceOf();
  const { results, arrivedBeforeGo } = await raceProcesses({ url: w.url, mode: "wallet-send", journalDir: dir });
  assert.equal(w.count("eth_sendTransaction"), 1, `eth_sendTransaction requests: ${w.count("eth_sendTransaction")}; intents: ${summary(dir)}`);
  assert.equal(arrivedBeforeGo, 1);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find((r) => !r.ok).code, "busy");
  assert.equal(await nonceOf(), before + 1);
});

test("separate processes, one journal (sign): one signature request and one broadcast", T, async () => {
  const w = await walletServer(forward(walletRpc));
  const dir = jdir(), before = await nonceOf();
  const { results } = await raceProcesses({ url: w.url, mode: "sign", journalDir: dir });
  assert.equal(w.count("eth_signTransaction"), 1, `eth_signTransaction requests: ${w.count("eth_signTransaction")}; intents: ${summary(dir)}`);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(await nonceOf(), before + 1);
});

test("separate processes, one journal (handoff): one handoff intent", T, async () => {
  const dir = jdir();
  const { results } = await raceProcesses({ mode: "handoff", journalDir: dir });
  const handoffs = S.intentJournal(dir).list().filter((r) => r.state === "handoff");
  assert.equal(handoffs.length, 1, `unresolved handoff intents for one account: ${summary(dir)}`);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
});
