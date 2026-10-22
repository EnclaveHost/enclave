// The site activation handoff (root runs it; it never signs, broadcasts, uploads on its own, funds or activates):
//   node serve-site-activation.mjs --print-plan
//       -> the exact handoff plan (steps 1-3 + the approved stage-B operations) and its sha256: the review artifact
//   node serve-site-activation.mjs --approved-plan sha256:<hex> --serve
//       -> refuses unless the rebuilt plan is exactly the approved one; serves http://127.0.0.1:39657 (steps 1-3). After a
//          create receipt verified on two providers with the reviewed deployment id, it starts the reviewed stage-B queue
//          on http://127.0.0.1:39656 (steps 4-5) and the page links to it. Every process, a restart included, re-verifies
//          that Created binding before it opens its own stage-B listener; if the listener fails, the page retries it.
// Only MetaMask in the user's browser signs. The upload runs in this process after the user's personal_sign and only
// for the pinned artifact; the token and the signature are never stored or printed.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkReusedPins, reserveOperations, reserveAbi, createReserveQueue, stageBStarter, ENR, SIGN } from "./reserve-queue.mjs";
import { SITE, sitePlan } from "./site-trust.mjs";
import { prepareSiteTx, verifySiteTx, startSiteCheck, releaseSiteCheck, makeStageBPrecheck } from "./site-chain.mjs";
import { uploadMessage, runUpload, frozenWasm } from "./site-upload.mjs";
import { createSiteServer } from "./site-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), W = path.resolve(here, "../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// this handoff's own reviewed files (filled from the review inventory; any change refuses to start)
const OWN_PINS = Object.freeze({
  "site-trust.mjs": "9e71ae3de0ef5aa9cd8b76eac5b744e418e05835ac578c11642acd80ddd72d5b", "site-chain.mjs": "061b8c49661c75d927c4adcaa1cadf790f4f950033d7cbcaf323b6f6772a8be9", "site-upload.mjs": "0769940c6cd448eb08e46c60ce7b5df83df37be0b5fe3f064d9525dbe4e22ffe", "site-server.mjs": "8af0fbaeb5adb0f91f818314e119756254ba7a98f8d7e530c29247abfc157cde",
  "site-app.js": "9f598da6939bab7b66f1a8960a8b2e8a3ca9295c55a9afcc0fb8a72976216faf", "site.html": "5f560382ac6647f8ab56ae80e3ce07d1024899a758b79ca9d363b1a164e62baa", "reserve-queue.mjs": "8f7700730b546215df27326f1bb8501bb25cba10e467c694acfc08c00c6b14b1",
  "../../enclave/contracts/EnclaveAppCatalog.abi.json": "ff0018053bf7c049a21c69aca3c44eed3d3223ee14c46f7960e4c2ab5e2a02e9",
  "../../enclave/contracts/EnclaveDeployments.abi.json": "653271f3aaec2641b7ce048a101e966296124dfeb8bf355d81036dcfc13330ba",
  "../../enclave/scripts/site-release/unixfs.mjs": "9f6a15811abbbde6b99bcd496a8e811f3cecaeed3290c619b93f3ecd3068313c",
});
for (const [f, h] of Object.entries(OWN_PINS)) if (sha(fs.readFileSync(path.join(here, f))) !== h) throw Error(`${f} changed since review`);
checkReusedPins();

const plan = sitePlan(SITE);
const abi = await reserveAbi();
const stageB = reserveOperations({ id: SITE.predictedId, depositWei: SITE.stageB.depositWei, abi });
if (stageB.opsSha256 !== SITE.stageB.approvedOpsSha256) throw Error("the stage-B operations are not the approved ones");
const handoffPlan = {
  format: "site-activation-handoff-plan/v1", status: "NOT SIGNED - review artifact", chainId: SITE.chainId, admin: SITE.admin,
  wasm: { sha256: SITE.wasm.sha256, bytes: SITE.wasm.bytes }, expectedCid: SITE.expectedCid, release: SITE.release, appId: plan.appId, predictedDeploymentId: SITE.predictedId,
  steps: plan.steps.map((s) => ({ n: s.n, step: s.step, kind: s.kind, title: s.title, destination: s.destination, amountWei: s.amountWei,
    ...(s.kind === "personal_sign" ? { message: `enclave-upload:${SITE.wasm.sha256}:<unix time of signing + ${SITE.upload.expirySec}>`, signer: SITE.admin }
      : { from: s.from, to: s.to, value: s.value, data: s.data, gasCap: "0x" + s.gasCap.toString(16) }) })),
  stageB: { depositWei: String(SITE.stageB.depositWei), opsSha256: stageB.opsSha256, port: SITE.stageB.port,
    operations: stageB.operations.map((o) => ({ n: 4 + o.index, kind: o.kind, title: o.title, from: o.from, to: o.to, value: o.value, gasCap: o.gas, data: o.data, policy: o.policy })) },
  totals: { valueWei: String(SITE.stageB.depositWei), usdc: "0", walletConfirmations: 5, types: { personal_sign: 1, eth_sendTransaction: 4 } },
};
const planText = JSON.stringify(handoffPlan, null, 1) + "\n", planSha256 = sha(planText);
const args = process.argv.slice(2);
if (args.includes("--print-plan")) { process.stdout.write(planText); process.stderr.write(`plan sha256:${planSha256}\n`); process.exit(0); }
const pinArg = args[args.indexOf("--approved-plan") + 1] || "";
if (!args.includes("--serve") || pinArg !== "sha256:" + planSha256) throw Error("refusing to serve: pass --approved-plan sha256:<the reviewed plan sha256> --serve");
frozenWasm(SITE);   // size, sha256 and CID of the frozen artifact, before anything starts

const { clientsFor } = await import(path.join(SIGN, "rpc-clients.mjs"));
const { fileJournal } = await import(path.join(ENR, "handoff-server.mjs"));
const [publicnode, basePub, blast] = clientsFor([SITE.rpcs[0], SITE.rpcs[1], SITE.receiptRpcs[0]]);
const clients = [publicnode, basePub], receiptClients = [blast, basePub];
// labelled PRE-check only (create + the approved stage-B operations as one simulated bundle; site-chain.mjs)
const stageBPrecheck = makeStageBPrecheck({ t: SITE, plan, operations: stageB.operations, reserveAbi: abi });
const jdir = path.join(here, "journals-activation");
const journals = Object.fromEntries(["session", "upload", "publish", "create"].map((k) => [k, fileJournal(path.join(jdir, `${k}.json`))]));
// stage B: the reviewed queue on its own disk journals (a submitted deposit/configure attempt survives a restart)
const stageBQueue = stageBStarter({ port: SITE.stageB.port, open: (id) => createReserveQueue({ id, depositWei: SITE.stageB.depositWei, approvedOpsSha256: SITE.stageB.approvedOpsSha256, abi, clients, receiptClients,
  journalDir: path.join(here, "journals", id.slice(2, 18)) }) });
const app = createSiteServer({ t: SITE, plan, journals,
  start: () => startSiteCheck({ t: SITE, plan, clients }),
  prepare: (step, o) => prepareSiteTx({ t: SITE, plan, step, clients, ...o, stageBPrecheck }),
  verify: (step, attempts, hash) => verifySiteTx({ t: SITE, plan, step, attempts, hash, clients: receiptClients }),
  release: (nonce) => releaseSiteCheck({ t: SITE, clients, nonce }),
  uploadMessage: (nowMs) => uploadMessage(SITE, nowMs),
  runUpload: ({ auth, signature, nowMs }) => runUpload({ t: SITE, auth, signature, fetchFn: fetch, nowMs }),
  startStageB: stageBQueue.start,
  assets: { "/": { type: "text/html", body: fs.readFileSync(path.join(here, "site.html"), "utf8") }, "/app.js": { type: "text/javascript", body: fs.readFileSync(path.join(here, "site-app.js"), "utf8") },
    "/style.css": { type: "text/css", body: fs.readFileSync(path.join(W, "metamask-bridge/style.css"), "utf8") + fs.readFileSync(path.join(ENR, "queue.css"), "utf8") } } });
const url = await app.listen(39657);
// a restart after step 3: this process re-verifies the Created binding and opens its own stage-B listener; a failure is
// shown on the page, which retries it (POST /handover) without any new signature
if (app.state.create.status === "confirmed") await app.handover().catch(() => {});
console.log(JSON.stringify({ url, plan: "sha256:" + planSha256, next: app.view().next, stageB: app.view().stageB.url, stageBError: app.view().stageB.error, purpose: "site activation: upload authorization, publish, create; then the reviewed lease-gas page (deposit + configure)" }));
