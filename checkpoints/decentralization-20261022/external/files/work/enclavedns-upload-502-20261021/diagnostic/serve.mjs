// DIAGNOSTIC COPY (work/enclavedns-upload-502-20261021/diagnostic, 2026-10-21) of the reviewed wallet-handoff/serve.mjs
// e2b32010. Only changes: the handoff's own files (trust, plan, chain, server, page, pins, artifact) and its journals are
// used IN PLACE from H, and runUpload's fetch is wrapped by ./upload-diagnostic.mjs (an HTTP >= 400 answer to the exact
// upload POST prints ONE "UPLOAD-DIAGNOSTIC {fixed fields}" line on stderr). Lock: ./files.lock.json (./make-lock.mjs).
// The EnclaveDNS 0.1.5 release handoff (root starts it; it never signs, broadcasts, uploads on its own, funds or deploys):
//   node serve.mjs --print-plan
//       -> the exact handoff plan (3 steps) on stdout and its sha256 on stderr: the review artifact
//   node serve.mjs --approved-plan sha256:<plan> --approved-files sha256:<files.lock.json> --serve
//       -> refuses unless the rebuilt plan is exactly the approved one AND every own and reused source file is exactly the
//          one in the approved lock; checks the frozen artifact (size, sha256, CID); then serves http://127.0.0.1:39681.
// Only MetaMask in the user's browser signs. The upload runs in this process after the user's personal_sign and only for
// the pinned artifact; the token and the signature are never stored or printed. Journals (public data only): ./journals.
// Adapted from the reviewed IPNS Publisher handoff serve.mjs (3 steps instead of 4; another port; nothing else).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const H = path.resolve(here, "../../enclavedns-stale-20261021/wallet-handoff"), own = (f) => pathToFileURL(path.join(H, f)).href;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const argOf = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] || "" : "");

// every file this process loads (own and reused), byte-pinned BEFORE any of them is imported
const lockText = fs.readFileSync(path.join(here, "files.lock.json"), "utf8"), lock = JSON.parse(lockText);
if (!args.includes("--print-plan") && argOf("--approved-files") !== "sha256:" + sha(lockText)) throw Error("refusing to serve: pass --approved-files sha256:<the reviewed files.lock.json sha256>");
for (const [f, h] of Object.entries(lock.files)) if (sha(fs.readFileSync(path.resolve(here, f))) !== h) throw Error(`${f} changed since review`);

const { DNS } = await import(own("trust.mjs"));
const { buildHandoffPlan } = await import(own("handoff-plan.mjs"));
const { plan, text: planText, sha256: planSha256 } = buildHandoffPlan(DNS);
if (args.includes("--print-plan")) { process.stdout.write(planText); process.stderr.write(`plan sha256:${planSha256}\nfiles sha256:${sha(lockText)}\n`); process.exit(0); }
if (!args.includes("--serve") || argOf("--approved-plan") !== "sha256:" + planSha256) throw Error("refusing to serve: pass --approved-plan sha256:<the reviewed plan sha256> --serve");

const { prepareTx, verifyTx, startCheck, releaseCheck } = await import(own("chain.mjs"));
const { uploadMessage, runUpload, frozenWasm } = await import("../../site-host-live-publish/handoff/site-upload.mjs");
const { createPublisherServer } = await import(own("server.mjs"));
const { clientsFor } = await import("../../lease-gas-wallet-signing/rpc-clients.mjs");
const { fileJournal } = await import("../../lease-enrollment-signing/handoff-server.mjs");
const { diagnosticFetch } = await import("./upload-diagnostic.mjs");
frozenWasm(DNS);   // size, sha256 and CID of the frozen artifact, before anything starts

const [publicnode, basePub, blast] = clientsFor([DNS.rpcs[0], DNS.rpcs[1], DNS.receiptRpcs[0]]);
const clients = [publicnode, basePub], receiptClients = [blast, basePub];
const jdir = path.join(H, "journals");
const journals = Object.fromEntries(["session", "upload", "publish", "upgrade"].map((k) => [k, fileJournal(path.join(jdir, `${k}.json`))]));
const W = path.resolve(here, "../..");
const app = createPublisherServer({ t: DNS, plan, planSha256, journals,
  start: () => startCheck({ t: DNS, plan, clients }),
  prepare: (step, o) => prepareTx({ t: DNS, plan, step, clients, ...o }),
  verify: (step, attempts, hash) => verifyTx({ t: DNS, plan, step, attempts, hash, clients: receiptClients }),
  release: (nonce) => releaseCheck({ t: DNS, clients, nonce }),
  uploadMessage: (nowMs) => uploadMessage(DNS, nowMs),
  runUpload: ({ auth, signature, nowMs }) => runUpload({ t: DNS, auth, signature, nowMs,
    fetchFn: diagnosticFetch(fetch, { addUrl: DNS.upload.addUrl, emit: (d) => process.stderr.write("UPLOAD-DIAGNOSTIC " + JSON.stringify(d) + "\n") }) }),
  assets: { "/": { type: "text/html", body: fs.readFileSync(path.join(H, "index.html"), "utf8") }, "/app.js": { type: "text/javascript", body: fs.readFileSync(path.join(H, "app.js"), "utf8") },
    "/style.css": { type: "text/css", body: fs.readFileSync(path.join(W, "metamask-bridge/style.css"), "utf8") + fs.readFileSync(path.join(W, "lease-enrollment-signing/queue.css"), "utf8") } } });
const url = await app.listen(DNS.port);
console.log(JSON.stringify({ url, plan: "sha256:" + planSha256, files: "sha256:" + sha(lockText), next: app.view().next, diagnostic: "upload HTTP>=400: fixed fields on stderr", purpose: "EnclaveDNS 0.1.5: upload authorization, publish, upgrade the existing deployment through its SessionVault" }));
