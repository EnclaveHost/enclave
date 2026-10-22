// Shared fixtures for the IPNS Publisher release tests: a fixture trust (production PUB with a test owner key, fixture code
// hashes and a loopback upload gateway), the in-memory Base model, a REAL loopback gateway (token, add, CAR of the frozen
// artifact's own DAG), and the real handoff server driven over HTTP exactly as the page drives it. Nothing here touches a
// network but loopback; the frozen artifact is the production one (1.4 MB).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { privateKeyToAccount } from "../../../enclave/node_modules/viem/_esm/accounts/index.js";
import { keccak256, encodePacked } from "../../../enclave/node_modules/viem/_esm/index.js";
import { PUB, publisherPlan } from "../trust.mjs";
import { buildHandoffPlan } from "../handoff-plan.mjs";
import { prepareTx, verifyTx, startCheck, releaseCheck } from "../chain.mjs";
import { uploadMessage, runUpload, frozenWasm, carHeaderOf } from "../../../site-host-live-publish/handoff/site-upload.mjs";
import { cidString } from "../../../enclave/scripts/site-release/unixfs.mjs";
import { fileJournal } from "../../../lease-enrollment-signing/handoff-server.mjs";
import { createPublisherServer } from "../server.mjs";
import { createModel, FIXTURE_HASHES } from "./model.mjs";

export const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", OTHER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const wallet = privateKeyToAccount(KEY), OWNER = wallet.address.toLowerCase();
export const TOKEN = "tok-" + "z".repeat(40);
const FROZEN = frozenWasm(PUB);

/** varint (unsigned LEB128) */
const varint = (n) => { const b = []; do { let x = n & 127; n = Math.floor(n / 128); if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); };
/** The CARv1 of the frozen artifact's own DAG (what an honest gateway returns). */
export function honestCar() {
  const h = carHeaderOf(PUB.expectedCid), parts = [varint(h.length), h];
  for (const [c, b] of FROZEN.dag.blocks) { const cid = Buffer.from(c), data = Buffer.from(b); parts.push(varint(cid.length + data.length), cid, data); }
  return Buffer.concat(parts);
}

/** A loopback upload gateway (token, add-wasm, CAR); `mode` alters one answer. Records every request. */
export async function gateway(mode = "honest") {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    let n = 0; const parts = []; for await (const c of req) { n += c.length; if (n <= 65536) parts.push(c); }
    const body = n <= 65536 ? Buffer.concat(parts).toString("utf8") : null; hits.push({ method: req.method, url: req.url, bytes: n, headers: req.headers, body });
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/v1/apps/upload-token") return json(200, { token: TOKEN, address: OWNER, expiry: JSON.parse(body).expiry });
    if (req.url === "/add-wasm") return json(200, { cid: mode === "wrong-cid" ? "bafybeiwrongwrongwrong" : PUB.expectedCid, wasi: "0.2" });
    if (req.url.startsWith(`/ipfs/${PUB.expectedCid}`)) { const car = honestCar(); res.writeHead(200, { "content-type": "application/vnd.ipld.car" });
      return res.end(mode === "bad-car" ? Buffer.concat([car.subarray(0, car.length - 1), Buffer.from([car[car.length - 1] ^ 1])]) : car); }
    json(404, {});
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = "http://127.0.0.1:" + server.address().port;
  return { url, hits, close: () => { server.closeAllConnections(); return new Promise((ok) => server.close(ok)); } };
}

/** The fixture trust over a gateway: production PUB with the test owner and fixture code hashes. */
export function fixtureTrust(gw) {
  const appId = keccak256(encodePacked(["address", "string"], [OWNER, PUB.app.slug]));
  return { ...PUB, admin: OWNER, codeHashes: FIXTURE_HASHES, app: { ...PUB.app, appId },
    upload: { ...PUB.upload, tokenUrl: gw.url + "/v1/apps/upload-token", addUrl: gw.url + "/add-wasm", carUrl: (cid) => `${gw.url}/ipfs/${cid}?format=car&dag-scope=all` } };
}

/** A running handoff over a fresh (or given) journal dir and model. */
export async function handoff({ mode = "honest", dir = null, model = null, gw = null, tweak = [] } = {}) {
  gw ??= await gateway(mode);
  const t = fixtureTrust(gw), plan = publisherPlan(t), planSha256 = buildHandoffPlan(t).sha256;
  model ??= createModel({ t, plan });
  dir ??= fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ipns-release-"));
  const journals = Object.fromEntries(["session", "upload", "publish", "upgrade", "config"].map((k) => [k, fileJournal(path.join(dir, `${k}.json`))]));
  const clients = model.clients(tweak);
  const app = createPublisherServer({ t, plan, planSha256, journals,
    start: () => startCheck({ t, plan, clients }),
    prepare: (step, o) => prepareTx({ t, plan, step, clients, ...o }),
    verify: (step, attempts, hash) => verifyTx({ t, plan, step, attempts, hash, clients }),
    release: (nonce) => releaseCheck({ t, clients, nonce }),
    uploadMessage: (nowMs) => uploadMessage(t, nowMs),
    runUpload: ({ auth, signature, nowMs }) => runUpload({ t, auth, signature, fetchFn: fetch, nowMs }),
    assets: { "/": { type: "text/html", body: "<!doctype html>" } } });
  const origin = await app.listen(0);
  const token = app.view().token;
  /** POST as the page does (same origin, the launch token). -> { status, body } */
  const post = async (p, data = {}, headers = {}) => {
    const r = await fetch(origin + p, { method: "POST", headers: { "content-type": "application/json", origin, "x-signing-token": token, ...headers }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => (await fetch(origin + "/state")).json();
  const close = async () => { await app.close(); };
  return { t, plan, planSha256, model, dir, gw, app, origin, token, post, state, close, journals };
}

/** Sign the upload authorization as MetaMask would, and submit it. */
export async function doUpload(h, key = KEY) {
  const p = await h.post("/upload/prepare");
  const signature = await privateKeyToAccount(key).signMessage({ message: p.body.message });
  return { ...(await h.post("/upload/signature", { signature })), signature };
}
/** Prepare a step and land its exact transaction in the model; returns { prepared, hash, result }. */
export async function doStep(h, step, landOpts = {}) {
  const prepared = await h.post("/tx/prepare", { step });
  if (prepared.status !== 200) return { prepared };
  const hash = h.model.land(prepared.body.transaction, landOpts);
  return { prepared, hash, result: await h.post("/tx/result", { step, hash }) };
}
export const readJournalDir = (dir) => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
