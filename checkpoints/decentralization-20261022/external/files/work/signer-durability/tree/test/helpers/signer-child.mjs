// One external-signer send in its OWN process, for the cross-process and crash tests of cli/independent-signer.mjs.
//   node signer-child.mjs '<json>'   { tree, chainRpc, journalDir, mode, url, from, to, data, gate, publish, crashAt }
// stdout, one line each and written synchronously (a line is out before any later kill):
//   READY            set up; waits for START on stdin
//   ARRIVED          (gate) paused just before its first pending-nonce read; waits for GO on stdin
//   BROADCASTING     (publish) eth_sendRawTransaction is about to leave; PUBLISHED once one RPC accepted it
//   RESULT <json>    the send's outcome
// crashAt kills THIS process with SIGKILL at an exact filesystem step: "intent-rename" (an intent's tmp file is written
// and flushed, not yet renamed into place), "after-intent" (that rename done, nothing after it) or "release-marker" (an
// intent is decided on disk, its reservation not yet released). publish: "hang-before" | "hang-after" stops forever around the first broadcast, for the parent to kill.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const cfg = JSON.parse(process.argv[2]);
const say = (l) => fs.writeSync(1, l + "\n");
const die = () => process.kill(process.pid, "SIGKILL");
if (cfg.crashAt === "intent-rename") { const o = fs.renameSync; fs.renameSync = (a, b) => { if (/tx-[0-9a-z-]+\.json$/.test(String(b))) die(); return o(a, b); }; }
if (cfg.crashAt === "after-intent") { const o = fs.renameSync; fs.renameSync = (a, b) => { const r = o(a, b); if (/tx-[0-9a-z-]+\.json$/.test(String(b))) die(); return r; }; }
if (cfg.crashAt === "release-marker") { const o = fs.openSync; fs.openSync = (p, ...a) => { if (String(p).endsWith(".released")) die(); return o(p, ...a); }; }

const lines = readline.createInterface({ input: process.stdin });
const heard = new Set(), waiting = new Map();
lines.on("line", (l) => { heard.add(l); waiting.get(l)?.(); });
const hear = (l) => heard.has(l) ? Promise.resolve() : new Promise((r) => waiting.set(l, r));

const { createPublicClient, http } = await import("viem");
const { foundry } = await import("viem/chains");
const { QuorumChain } = await import(pathToFileURL(path.join(cfg.tree, "cli/independent.mjs")).href);
const S = await import(pathToFileURL(path.join(cfg.tree, "cli/independent-signer.mjs")).href);

const client = () => {
  const c = createPublicClient({ chain: foundry, transport: http(cfg.chainRpc) });
  return new Proxy(c, { get: (t, k) => k !== "request" ? t[k] : async (a) => {
    if (a.method !== "eth_sendRawTransaction" || !cfg.publish) return t.request(a);
    say("BROADCASTING");
    if (cfg.publish === "hang-before") return new Promise(() => {});
    const r = await t.request(a);
    say("PUBLISHED");
    return cfg.publish === "hang-after" ? new Promise(() => {}) : r;
  } });
};
const chain = new QuorumChain({ clients: [{ origin: cfg.chainRpc + "/a", client: client() }, { origin: cfg.chainRpc + "/b", client: client() }],
  quorum: 2, confirmations: 0, maxBlockAgeMs: 600000, chainId: 31337 });
let arrived = false;
const each = chain.each.bind(chain);
chain.each = async (fn, what) => {
  if (cfg.gate && what === "pending nonce" && !arrived) { arrived = true; say("ARRIVED"); await hear("GO"); }
  return each(fn, what);
};
const signer = S.createExternalSigner({ url: cfg.url, from: cfg.from, chainId: 31337, mode: cfg.mode, journalDir: cfg.journalDir,
  approvalTimeoutMs: 20000, probeTimeoutMs: 5000, onHandoff: (rec) => ({ handoff: rec.id, nonce: rec.nonce }) });
say("READY");
await hear("START");
let result;
try {
  const r = await signer.sendQuorumTx(chain, { to: cfg.to, data: cfg.data, timeoutMs: 15000, pollMs: 50 });
  result = { ok: true, intent: r.intent ?? r.handoff, hash: r.transactionHash ?? null };
} catch (e) { result = { ok: false, code: e.code ?? null, intent: e.intent ?? null, reservation: e.reservation ?? null, message: String(e.message) }; }
say("RESULT " + JSON.stringify(result));
process.exit(0);
