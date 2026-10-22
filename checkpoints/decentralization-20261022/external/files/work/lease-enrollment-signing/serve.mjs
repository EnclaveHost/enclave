// INACTIVE until root unlocks gate.mjs after the user's budget approval. Then, explicitly:
//   node serve.mjs --approved-proposal sha256:<hex of complete-bootstrap-funding-proposal.json> --serve
// Serves the 25-operation enrollment queue on root's original origin http://127.0.0.1:39655 (stop the previous stage
// server first). This process prepares requests and verifies receipts; MetaMask in the user's browser signs and sends
// each one after the user starts the sequence. It never signs, broadcasts, funds or activates anything itself.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fileJournal } from "./handoff-server.mjs";
import { createQueueServer } from "./queue-server.mjs";
import { validatePlan } from "./plan.mjs";
import { prepareOperation, verifyOperation, startCheck, releaseCheck } from "./chain.mjs";
import { APPROVAL_GATE } from "./gate.mjs";
import { ENROLLMENT } from "./trust.mjs";
import { clientsFor } from "../lease-gas-wallet-signing/rpc-clients.mjs";
import { verifiedArtifacts } from "../lease-gas-wallet-signing/artifacts.mjs";
import { PRODUCTION } from "../lease-gas-wallet-signing/trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(here, "../..");
const args = process.argv.slice(2), pinArg = args[args.indexOf("--approved-proposal") + 1] || "";
if (args.length !== 3 || !args.includes("--serve") || !/^sha256:[0-9a-f]{64}$/.test(pinArg))
  throw Error("usage: node serve.mjs --approved-proposal sha256:<hex> --serve (explicit, after the user's budget approval; this command never signs or submits)");
const pin = pinArg.slice(7);
if (APPROVAL_GATE.locked !== false || APPROVAL_GATE.approvedProposalSha256 !== pin) throw Error("the enrollment approval gate is locked or approves another proposal; root unlocks it only after the user's budget approval");
// the reused root modules are exactly the reviewed ones (read-only imports; root's signing directory is never written)
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const signing = path.join(ROOT, "work/lease-gas-wallet-signing");
for (const [f, h] of Object.entries({ "handoff-server.mjs": "fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75", "rpc-clients.mjs": "a46de84eba226dd17d8f8521014186b8a4dd1f940e6d29ef7de9770b82b1b201",
  "artifacts.mjs": "6cb2f95ca862210412f46faffb3d1331e2206734297907839a918e5ee87831a7", "trust.mjs": "0636f14538e2ff3658c8e56b6e750ae15fb11c4bf33c328b3b6340b070b1faf0",
  "stages.mjs": "a4994bdb8b6c6d32f06fdcb5db2205c759982f3e8e67101d11bdcdb5e729d37c" }))
  if (sha(path.join(signing, f)) !== h) throw Error(`reused module ${f} changed since review`);
if (sha(path.join(here, "handoff-server.mjs")) !== sha(path.join(signing, "handoff-server.mjs"))) throw Error("the transport copy differs from root's");

const abi = verifiedArtifacts({ trust: PRODUCTION }).EnclaveLeaseGasReserve.abi;   // source/artifact provenance re-verified
const review = path.join(ROOT, "outputs/app-lease-gas-review");
const files = () => ({ proposal: fs.readFileSync(path.join(review, "complete-bootstrap-funding-proposal.json")), enrollment: fs.readFileSync(path.join(review, "enrollment-bootstrap-proposal.json")),
  identities: fs.readFileSync(path.join(review, "lease-relay-identities.json")) });
const plan = validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: pin, ...files() });
const recheck = () => { if (validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: pin, ...files() }).planSha256 !== plan.planSha256) throw Error("the plan changed"); };
const [publicnode, base, blast] = clientsFor([ENROLLMENT.rpcs[0], ENROLLMENT.rpcs[1], ENROLLMENT.receiptRpcs[0]]);   // one paced client per host
if (ENROLLMENT.rpcs[1] !== ENROLLMENT.receiptRpcs[1]) throw Error("unexpected RPC layout");
const clients = [publicnode, base], receiptClients = [blast, base];
const journalDir = path.join(here, "journals");
const app = createQueueServer({
  operations: plan.operations, planSha256: plan.planSha256, setupHashes: ENROLLMENT.setupHashes,
  journals: plan.operations.map((_o, i) => fileJournal(path.join(journalDir, `op-${String(i + 1).padStart(2, "0")}.json`))),
  session: (() => { const j = fileJournal(path.join(journalDir, "session.json")); return { read: () => { const s = j.read(); return s.status === "ready" ? { status: "not started" } : s; }, write: j.write }; })(),
  start: (ops) => { recheck(); return startCheck({ trust: ENROLLMENT, abi, ops, clients }); },
  prepare: (op, { reservedNonce, laterValueWei }) => { recheck(); return prepareOperation({ trust: ENROLLMENT, abi, op, planSha256: plan.planSha256, reservedNonce, laterValueWei, clients }); },
  verify: (op, attempts, hash) => verifyOperation({ trust: ENROLLMENT, abi, op, attempts, hash, clients: receiptClients }),
  release: (_op, nonce) => releaseCheck({ trust: ENROLLMENT, clients, nonce }),
  assets: { "/": { type: "text/html", body: fs.readFileSync(path.join(here, "queue.html"), "utf8") }, "/app.js": { type: "text/javascript", body: fs.readFileSync(path.join(here, "queue-app.js"), "utf8") },
    "/style.css": { type: "text/css", body: fs.readFileSync(path.join(ROOT, "work/metamask-bridge/style.css"), "utf8") + fs.readFileSync(path.join(here, "queue.css"), "utf8") } },
});
const v = app.view();
console.log(JSON.stringify({ url: await app.listen(39655), plan: "sha256:" + plan.planSha256, operations: v.totals.operations, confirmed: v.totals.confirmed, remainingSignatures: v.totals.remainingSignatures,
  remainingWei: v.totals.remainingWei, session: v.session, purpose: "lease-gas enrollment: 11 app deposits, 11 policies, 1 DNS claimant, 2 relay balances; each needs its own MetaMask confirmation" }));
