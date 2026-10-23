// INACTIVE until root's review and fresh live preflight (node preflight.mjs). Start ONE stage explicitly:
//   node serve.mjs --stage fund --serve      (optional: 0.000005 ETH to the existing metal0 operator)
//   node serve.mjs --stage accept --serve    (acceptOwner(metal0), only after the operator's proposal is two blocks deep)
// Both use the same loopback port, so only one stage can be served at a time. This process prepares requests and
// verifies receipts on two public providers; MetaMask in the user's browser signs and broadcasts. It never reads keys.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileJournal } from "./handoff-server.mjs";
import { stageApp } from "./stage-app.mjs";
import { assetsFor } from "./page.mjs";
import { clientsFor } from "./rpc.mjs";
import { PRODUCTION } from "./trust.mjs";

export const PORT = 39671;
const args = process.argv.slice(2), stage = args[args.indexOf("--stage") + 1];
if (args.length !== 3 || !args.includes("--serve") || !["fund", "accept"].includes(stage))
  throw Error("usage: node serve.mjs --stage fund|accept --serve (explicit, after root's review; this command never signs or submits)");
const here = path.dirname(fileURLToPath(import.meta.url));
const journals = { fund: fileJournal(path.join(here, "journals", "fund.json")), accept: fileJournal(path.join(here, "journals", "accept.json")) };
const other = journals[stage === "fund" ? "accept" : "fund"];
journals[stage === "fund" ? "accept" : "fund"] = { read: other.read, write: () => { throw Error("read-only journal"); } };
const clients = clientsFor(PRODUCTION.rpcs, { timeoutMs: PRODUCTION.rpcTimeoutMs });
const app = stageApp({ stage, trust: PRODUCTION, clients, journals, assets: assetsFor(stage) });
const stop = () => app.close().finally(() => process.exit(0));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
console.log(JSON.stringify({ url: await app.listen(PORT), stage, status: app.state.status, purpose: app.state.request?.purpose ?? stage, wallet: "MetaMask confirmation required; nothing is sent by this process" }));
