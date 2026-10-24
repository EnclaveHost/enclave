// INACTIVE until root's review and a fresh read-only preflight (custody-proof-app publish/bin/publish-prepare.mjs --prepare).
// Root starts it explicitly:   node serve.mjs --serve
// It listens on 127.0.0.1:39675 only (NOT the factory handoff's 39672). It uploads the one pinned component with the
// administrator's MetaMask-signed authorization, verifies storage, prepares the publish transaction and verifies the
// receipt on two public providers. MetaMask in the administrator's browser signs; this process never reads keys or signs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileJournal } from "./handoff-server.mjs";
import { canaryApp } from "./stage-app.mjs";
import { assets } from "./page.mjs";
import { clientsFor } from "./rpc.mjs";
import { makePreparer } from "./publish-stage.mjs";
import { PRODUCTION, PORT } from "./trust.mjs";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--serve") throw Error("usage: node serve.mjs --serve (explicit, after root's review; this command never signs or submits)");
const here = path.dirname(fileURLToPath(import.meta.url));
const journals = { upload: fileJournal(path.join(here, "journals", "upload.json")), publish: fileJournal(path.join(here, "journals", "publish.json")) };
const clients = clientsFor(PRODUCTION.rpcs, { timeoutMs: PRODUCTION.rpcTimeoutMs });
const app = canaryApp({ trust: PRODUCTION, clients, preparer: makePreparer(PRODUCTION), journals, assets: assets() });
const stop = () => app.close().finally(() => process.exit(0));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
console.log(JSON.stringify({ url: await app.listen(PORT), upload: app.upload.state.status, publish: app.state.status, wallet: "MetaMask approval required for each step; nothing is signed or sent by this process" }));
