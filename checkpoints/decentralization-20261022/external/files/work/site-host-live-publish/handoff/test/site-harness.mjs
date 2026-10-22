// Shared fixtures for the site-activation handoff tests: a fixture trust over the in-memory Base model (deployed ABIs),
// an injected wallet key standing in for the admin, an injected upload gateway, and a running handoff (site server +
// the reviewed stage-B queue through the production stageBStarter). Nothing here touches a network but loopback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import v8 from "node:v8";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { keccak256, encodePacked, recoverMessageAddress } from "../../../enclave/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../enclave/node_modules/viem/_esm/accounts/index.js";
import { cidParse } from "../../../enclave/scripts/site-release/unixfs.mjs";
import { SITE, sitePlan } from "../site-trust.mjs";
import { prepareSiteTx, verifySiteTx, startSiteCheck, releaseSiteCheck } from "../site-chain.mjs";
import { uploadMessage, runUpload, frozenWasm } from "../site-upload.mjs";
import { createSiteServer } from "../site-server.mjs";
import { reserveOperations, reserveAbi, createReserveQueue, stageBStarter } from "../reserve-queue.mjs";
import * as reviewedChain from "../../../lease-enrollment-signing/chain.mjs";
import { ENROLLMENT } from "../../../lease-enrollment-signing/trust.mjs";
import { fileJournal } from "../../../lease-enrollment-signing/handoff-server.mjs";
import { createModel, FIXTURE_HASHES } from "./site-model.mjs";

export const here = path.dirname(fileURLToPath(import.meta.url)), LOGS = path.resolve(here, "../../logs");
export const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", OTHER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const wallet = privateKeyToAccount(KEY), ADMIN = wallet.address.toLowerCase();
export const abi = await reserveAbi();
export const FROZEN = frozenWasm(SITE);                                   // production pins: size, sha256, CID (46 MB, read once)
export const sha = (b) => createHash("sha256").update(b).digest("hex");
// Every upload reads the 46 MB artifact (and a CAR as large); V8 frees those buffers only on a full GC, which it may defer
// past the queue's 512 MiB cap. The tests collect explicitly around every upload and after every test.
v8.setFlagsFromString("--expose-gc");
export const gc = vm.runInNewContext("gc");
/** runUpload with a full collection before and after (test memory only; the production call is unchanged). */
export const upload = async (args) => { gc(); try { return await runUpload(args); } finally { gc(); } };

/** A fixture trust: the production SITE with the test admin, fixture code hashes and the predicted id that follows. */
export function fixture({ ledgerNonce = 0 } = {}) {
  const t = { ...SITE, admin: ADMIN, codeHashes: { catalog: FIXTURE_HASHES.catalog, ledger: FIXTURE_HASHES.ledger, registry: FIXTURE_HASHES.registry, reserve: FIXTURE_HASHES.reserve, executor: FIXTURE_HASHES.executor },
    predictedId: keccak256(encodePacked(["address", "uint64"], [ADMIN, BigInt(ledgerNonce)])) };
  const base = { ...ENROLLMENT, admin: ADMIN, codeHashes: { ...ENROLLMENT.codeHashes, ledger: FIXTURE_HASHES.ledger, registry: FIXTURE_HASHES.registry },
    reserveRuntimeHash: FIXTURE_HASHES.reserve, executorRuntimeHash: FIXTURE_HASHES.executor, vaultFactoryCodeHash: FIXTURE_HASHES.factory };
  const plan = sitePlan(t), model = createModel({ t, reserveAbi: abi, base });
  return { t, base, plan, model };
}

// ---- the injected upload gateway (relay token route + add-wasm + CAR) -------------------------------------------------
export const varint = (n) => { const o = []; while (n >= 128) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
export function carOf(rootCid, blocks) {
  const c = cidParse(rootCid), uniq = new Map(); for (const [k, b] of blocks) uniq.set(Buffer.from(k).toString("hex"), [k, b]); blocks = [...uniq.values()];
  const h = Buffer.concat([Buffer.from([0xa2, 0x65]), Buffer.from("roots"), Buffer.from([0x81, 0xd8, 0x2a, 0x58, c.length + 1, 0]), c, Buffer.from([0x67]), Buffer.from("version"), Buffer.from([1])]);
  return Buffer.concat([varint(h.length), h, ...blocks.flatMap(([k, b]) => [varint(k.length + b.length), k, b])]);
}
export const UNIQUE = [...new Map(FROZEN.dag.blocks.map(([k, b]) => [Buffer.from(k).toString("hex"), [k, b]])).values()];
export const GOOD_CAR = carOf(SITE.expectedCid, UNIQUE);
gc();   // drop the import-time garbage (artifact verification, CAR assembly)
export const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]) });   // the 46 MB CAR is not copied
export function gateway(t, o = {}) {
  const seen = { token: 0, add: 0, car: 0, tokens: [], uploadedSha: null };
  const fetchFn = async (url, init = {}) => {
    assert.equal(init.redirect, "error", "every upload request refuses redirects");
    if (url === t.upload.tokenUrl) {
      seen.token++; const b = JSON.parse(init.body);
      const who = (await recoverMessageAddress({ message: `enclave-upload:${b.hash}:${b.expiry}`, signature: b.signature })).toLowerCase();
      if (o.tokenReply) return resp(200, JSON.stringify(o.tokenReply(b, who)));
      const token = "tok-" + "z".repeat(40); seen.tokens.push(token);
      return resp(200, JSON.stringify({ token, address: who, expiry: b.expiry }));
    }
    if (url === t.upload.addUrl) {
      seen.add++; assert.equal(init.headers["x-upload-token"], seen.tokens.at(-1)); assert.equal(init.headers["x-upload-address"], t.admin.toLowerCase());
      const h = createHash("sha256"); let n = 0; for await (const c of init.body) { h.update(c); n += c.length; }
      seen.uploadedSha = h.digest("hex"); seen.uploadedBytes = n;
      return resp(200, o.addReply ?? JSON.stringify({ cid: t.expectedCid, wasi: "0.2", world: "wasi:http/incoming-handler@0.2.6" }));
    }
    if (url === t.upload.carUrl(t.expectedCid)) { seen.car++; return o.carReply ? o.carReply() : resp(200, GOOD_CAR); }
    throw Error("unexpected URL " + url);
  };
  return { fetchFn, seen };
}

// ---- a running handoff (site server + model + stage-B queue) ----------------------------------------------------------
export const memJournal = () => { let v = { status: "ready" }; return { read: () => structuredClone(v), write: (x) => { v = structuredClone(x); } }; };
export function hit(origin, p, { method = "POST", body, token, headers = {} } = {}) {
  const u = new URL(origin + p);
  return new Promise((ok, fail) => {
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { host: u.host, origin, "content-type": "application/json", ...(token ? { "x-signing-token": token } : {}), ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, json: b ? JSON.parse(b) : null }));
    });
    r.on("error", fail); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
  });
}
/** Site journals on disk under `dir` (what a restarted process reads back). */
export const fileJournals = (dir) => Object.fromEntries(["session", "upload", "publish", "create"].map((k) => [k, fileJournal(path.join(dir, `${k}.json`))]));
/**
 * A running handoff: the site server plus the reviewed stage-B queue opened through the production stageBStarter on
 * the stage-B journal directory `tmp` (reused across a restart) and `stageBPort` (0 = any free port).
 */
export async function launch(fx, { journals, gw = gateway(fx.t), now = () => Date.now(), approvedOps, tmp, stageBPort = 0, clients = fx.model.clients(), runUploadFn = null } = {}) {
  journals ??= Object.fromEntries(["session", "upload", "publish", "create"].map((k) => [k, memJournal()]));
  tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "site-handoff-"));
  const ops = reserveOperations({ id: fx.t.predictedId, depositWei: fx.t.stageB.depositWei, abi, base: fx.base });
  const stageB = { opened: 0, starter: null, get url() { return this.starter.url; } };
  stageB.starter = stageBStarter({ port: stageBPort, open: async (id) => { stageB.opened++;
    return createReserveQueue({ id, depositWei: fx.t.stageB.depositWei, approvedOpsSha256: approvedOps ?? ops.opsSha256, abi, clients, receiptClients: clients, journalDir: tmp, chain: reviewedChain, base: fx.base }); } });
  const app = createSiteServer({ t: fx.t, plan: fx.plan, journals, now,
    start: () => startSiteCheck({ t: fx.t, plan: fx.plan, clients }),
    prepare: (step, o) => prepareSiteTx({ t: fx.t, plan: fx.plan, step, clients, ...o }),
    verify: (step, attempts, hash) => verifySiteTx({ t: fx.t, plan: fx.plan, step, attempts, hash, clients }),
    release: (nonce) => releaseSiteCheck({ t: fx.t, clients, nonce }),
    uploadMessage: (nowMs) => uploadMessage(fx.t, nowMs),
    runUpload: runUploadFn ?? (({ auth, signature, nowMs }) => upload({ t: fx.t, auth, signature, fetchFn: gw.fetchFn, nowMs })),
    startStageB: stageB.starter.start });
  const origin = await app.listen(0);
  return { app, origin, token: app.view().token, gw, stageB, journals, tmp, close: async () => { await app.close(); await stageB.starter.close(); } };
}
export async function signUpload(h, key = KEY) {
  const p = await hit(h.origin, "/upload/prepare", { token: h.token }); assert.equal(p.status, 200, JSON.stringify(p.json));
  const signature = await privateKeyToAccount(key).signMessage({ message: p.json.message });
  return { prepared: p.json, res: await hit(h.origin, "/upload/signature", { token: h.token, body: { signature } }), signature };
}
export async function sendStep(h, fx, step, landOpts) {
  const p = await hit(h.origin, "/tx/prepare", { token: h.token, body: { step } }); assert.equal(p.status, 200, JSON.stringify(p.json));
  const hash = fx.model.land(p.json.transaction, landOpts);
  return { prepared: p.json, hash, res: await hit(h.origin, "/tx/result", { token: h.token, body: { step, hash } }) };
}

