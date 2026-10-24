// READ-ONLY live preflight for root, before anything is served: the full preparation (pinned facts, exhaustive impact,
// simulation, fees) against the two production providers, WITHOUT a journal write and WITHOUT a browser.
//   node preflight.mjs
// The journal (if present) is only read. Nothing is signed, sent or written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepare, observe } from "./activation.mjs";
import { clientsFor, withDeadline } from "./rpc.mjs";
import { PRODUCTION } from "./trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export async function preflight({ trust, clients, journalStatus }) {
  const out = { at: new Date().toISOString(), notSigned: true, notSent: true, providers: clients.map((c) => c.host), journal: journalStatus };
  const run = async (fn) => { try { return { ready: true, value: await withDeadline(trust.deadlineMs, "preflight", fn) }; } catch (e) { return { ready: false, reason: e.message }; } };
  out.observed = await run(async () => { const o = await observe(clients, trust); return { ...o, anchor: { number: String(o.anchor.number), hash: o.anchor.hash, baseFee: String(o.anchor.baseFee) } }; });
  out.activate = await run(() => prepare({ trust, clients }));
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = path.join(here, "journals", "activate.json");
  const journalStatus = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).status : "ready";
  console.log(JSON.stringify(await preflight({ trust: PRODUCTION, clients: clientsFor(PRODUCTION.rpcs, { timeoutMs: PRODUCTION.rpcTimeoutMs }), journalStatus }),
    (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
