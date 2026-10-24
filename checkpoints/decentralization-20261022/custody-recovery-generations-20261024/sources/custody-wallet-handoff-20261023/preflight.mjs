// READ-ONLY live preflight for root, before anything is served: runs both stages' preparation against the two production
// providers WITHOUT a journal write and WITHOUT a browser, and prints what each would request or why it refuses.
//   node preflight.mjs
// Journals (if present) are only read. Nothing is signed, sent, funded or written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFund, prepareAccept, observe } from "./stages.mjs";
import { clientsFor, withDeadline } from "./rpc.mjs";
import { PRODUCTION } from "./trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ro = (f) => ({ read: () => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { status: "ready" }), write: () => { throw Error("read-only"); } });
export async function preflight({ trust, clients, journals }) {
  const out = { at: new Date().toISOString(), notSigned: true, notSent: true, providers: clients.map((c) => c.host), journals: { fund: journals.fund.read().status, accept: journals.accept.read().status } };
  const run = async (fn) => { try { return { ready: true, request: await withDeadline(trust.deadlineMs, "preflight", fn) }; } catch (e) { return { ready: false, reason: e.message }; } };
  out.observed = await run(async () => { const o = await observe(clients, trust); return { ...o, anchor: { number: String(o.anchor.number), hash: o.anchor.hash, baseFee: String(o.anchor.baseFee) } }; });
  out.fund = await run(() => prepareFund({ trust, clients, journals }));
  out.accept = await run(() => prepareAccept({ trust, clients, journals }));
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const journals = { fund: ro(path.join(here, "journals", "fund.json")), accept: ro(path.join(here, "journals", "accept.json")) };
  console.log(JSON.stringify(await preflight({ trust: PRODUCTION, clients: clientsFor(PRODUCTION.rpcs, { timeoutMs: PRODUCTION.rpcTimeoutMs }), journals }), null, 2));
}
