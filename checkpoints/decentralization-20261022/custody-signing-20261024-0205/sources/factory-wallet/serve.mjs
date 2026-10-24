// INACTIVE until root's review and a fresh read-only preflight (node preflight.mjs). Root starts it explicitly:
//   node serve.mjs --serve
// It listens on 127.0.0.1:39672 only. It prepares the request and verifies the receipt on two public providers;
// MetaMask in the administrator's browser signs and broadcasts. This process never reads keys, signs or sends.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileJournal } from "./handoff-server.mjs";
import { activationApp } from "./stage-app.mjs";
import { assets } from "./page.mjs";
import { clientsFor } from "./rpc.mjs";
import { PRODUCTION } from "./trust.mjs";

export const PORT = 39672;
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--serve") throw Error("usage: node serve.mjs --serve (explicit, after root's review; this command never signs or submits)");
const here = path.dirname(fileURLToPath(import.meta.url));
const journal = fileJournal(path.join(here, "journals", "activate.json"));
const clients = clientsFor(PRODUCTION.rpcs, { timeoutMs: PRODUCTION.rpcTimeoutMs });
const app = activationApp({ trust: PRODUCTION, clients, journal, assets: assets() });
const stop = () => app.close().finally(() => process.exit(0));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
console.log(JSON.stringify({ url: await app.listen(PORT), status: app.state.status, wallet: "MetaMask confirmation required; nothing is sent by this process" }));
