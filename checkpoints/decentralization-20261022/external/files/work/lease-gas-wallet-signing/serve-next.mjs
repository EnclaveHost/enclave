import {clientsFor} from './rpc-clients.mjs';
// INACTIVE until root's review. Start ONE stage explicitly, only after the previous stage is confirmed:
//   node serve-next.mjs --stage executor --serve     (step 2: create the executor for the verified reserve)
//   node serve-next.mjs --stage bind --serve         (step 3: bind it, once)
// This process prepares requests and verifies receipts; MetaMask in the user's browser signs and broadcasts. The reserve
// journal of root's step-1 handoff (work/lease-gas-wallet/reserve-handoff-state.json) is READ, never written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { fileJournal } from "./handoff-server.mjs";
import { stageApp } from "./stage-app.mjs";
import { verifiedArtifacts } from "./artifacts.mjs";
import { PRODUCTION } from "./trust.mjs";

const args = process.argv.slice(2), stage = args[args.indexOf("--stage") + 1];
if (args.length !== 3 || !args.includes("--serve") || !["executor", "bind"].includes(stage))
  throw Error("usage: node serve-next.mjs --stage executor|bind --serve (explicit, after release review; this command never signs or submits)");
const here = path.dirname(fileURLToPath(import.meta.url)), work = path.resolve(here, "..");
const reserveFile = path.join(work, "lease-gas-wallet", "reserve-handoff-state.json");
const readOnly = (file) => ({ read: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { status: "ready" }), write: () => { throw Error("read-only journal"); } });
const journals = { reserve: readOnly(reserveFile), executor: fileJournal(path.join(here, "executor-handoff-state.json")), bind: fileJournal(path.join(here, "bind-handoff-state.json")) };
const clients = clientsFor(PRODUCTION.rpcs);
const receiptClients = clientsFor(['https://base-mainnet.public.blastapi.io','https://mainnet.base.org']);
const text = stage === "executor"
  ? { STEP: "2", TITLE: "Create the lease executor", LEDE: "This creates the executor contract that host operator keys delegate to, for the reserve verified in step 1. It holds no funds.",
      NOTE: "Binding it to the reserve is the separate step 3. Do not send funds to the reserve before step 3 is verified.", DONE: "The executor is verified. Binding it to the reserve is the separate step 3." }
  : { STEP: "3", TITLE: "Bind the executor to the reserve", LEDE: "This binds the verified executor to the verified reserve. It can be done only once; administrator rights stay with you.",
      NOTE: "App deposits are separate, per-app requests after this step is verified.", DONE: "All three setup steps are verified. App deposits are separate reviewed requests." };
const html = fs.readFileSync(path.join(here, "stage.html"), "utf8").replace(/\{\{(\w+)\}\}/g, (_m, k) => text[k]);
const app = stageApp({ stage, trust: PRODUCTION, artifacts: verifiedArtifacts({ trust: PRODUCTION }), clients, receiptClients, journals,
  assets: { "/": { type: "text/html", body: html }, "/app.js": { type: "text/javascript", body: fs.readFileSync(path.join(here, "next-app.js"), "utf8") },
    "/style.css": { type: "text/css", body: fs.readFileSync(path.join(work, "metamask-bridge", "style.css"), "utf8") } } });
console.log(JSON.stringify({ url: await app.listen(39655), stage, status: app.state.status, purpose: `${text.TITLE}; zero ETH; wallet confirmation required` }));
