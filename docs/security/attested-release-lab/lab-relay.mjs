// The relay side of the attested-release SNP LAB (phase 2 with enclave-5d): the three release endpoints served through the
// REAL handleRelease (relay/secrets.js + relay/secrets-release.mjs) with the providers wired as the api-relay wires them:
//   - the REAL measurement predictor (relay/measurement-predict.mjs): known-answer test at start, the catalog read through two
//     or more AGREEING public RPCs, the component CAR-verified, the domain releases pinned by id;
//   - verifyGuestEvidence = verifier/index.mjs verifyEvidence with AMD KDS collateral and the pinned ARK roots;
//   - runtimeIdOf, the response signature and the seal exactly as production.
// LAB substitutions, each printed at start and never presented as production evidence:
//   (a) the ledger row and confirmRow come from the lab file (the lab deployment holds no lease on chain);
//   (b) the lease holder's chip comes from a real report the lab hands in, proven by its AMD chain (VCEK from KDS -> ASK ->
//       the pinned ARK, signature, chip and TCB) and provenSnpChip: the rule the tunnel attach applies, without the tunnel;
//   (c) the operator (the ticket signer) is the lab supervisor's address; the release signing key is a synthetic seed;
//   (d) the secrets and configs are synthetic, from the lab file.
//
//   node lab-relay.mjs keygen <seed file>   a synthetic release signing seed (0600); prints the raw public key for the lab pins
//   node lab-relay.mjs serve <lab.json>     start-up checks, then serve /v1/secrets/{release-ticket,release,release-status}
//   node lab-relay.mjs dry-run <lab.json>   start-up checks, then drive the handler in-process with a per-run operator key
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash, createVerify, randomBytes, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "../../..");
const [mode, arg] = process.argv.slice(2);
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)}Z ${s}`);
const die = (s) => { console.error(`lab-relay: ${s}`); process.exit(1); };

if (mode === "keygen") {
  if (!arg) die("usage: keygen <seed file>");
  if (fs.existsSync(arg)) die(`${arg} exists; a lab key is generated once per run`);
  const R = await import(path.join(root, "relay/secrets-release.mjs"));
  const seed = randomBytes(32);
  fs.writeFileSync(arg, seed.toString("hex") + "\n", { mode: 0o600 });
  const pub = R.ed25519RawPublic(R.signingKeyFromSeed(seed));
  console.log(JSON.stringify({ seedFile: path.resolve(arg), publicKeyHex: pub.toString("hex"), publicKeyBase64: pub.toString("base64"), keyId: R.keyIdOf(pub),
    note: "SYNTHETIC lab release signing key: pin publicKey in the LAB front only" }, null, 1));
  process.exit(0);
}
if (!["serve", "dry-run"].includes(mode) || !arg) die("usage: keygen <seed file> | serve <lab.json> | dry-run <lab.json>");
const lab = JSON.parse(fs.readFileSync(arg, "utf8"));
const need = (k, ok) => { if (!ok) die(`lab file: ${k}`); };
const D = lab.deployment || {};
need("deployment.id (bytes32)", /^0x[0-9a-f]{64}$/.test(D.id || ""));
need("deployment.endpoint (https URL)", /^https?:\/\//.test(D.endpoint || ""));
need("deployment.appRef (catalog://…)", /^catalog:\/\/0x[0-9a-fA-F]{64}\/\d+$/.test(D.appRef || ""));
need("operator (0x address)", mode === "dry-run" || /^0x[0-9a-fA-F]{40}$/.test(lab.operator || ""));
need("chipReport (a JSON document with a base64 `report`, or {doc:{report}})", lab.chipReport && fs.existsSync(lab.chipReport));
need("signingSeedFile", lab.signingSeedFile && fs.existsSync(lab.signingSeedFile));
need("minTcb", lab.minTcb && typeof lab.minTcb === "object");
need("rpcs (two or more https URLs on distinct hosts)", Array.isArray(lab.rpcs) && new Set(lab.rpcs.map((u) => new URL(u).host)).size >= 2);
need("predictor", lab.predictor && typeof lab.predictor === "object");

// (d) a synthetic {config, secrets} file (enclave-5d's): the config is what resolveConfigCid serves for the envelope's CID,
// the secrets are what the release carries. Values are never printed.
if (lab.syntheticFile) {
  const syn = JSON.parse(fs.readFileSync(lab.syntheticFile, "utf8"));
  need("syntheticFile: {config, secrets}", syn && typeof syn.config === "object" && syn.secrets && typeof syn.secrets === "object");
  const cid = (() => { try { return JSON.parse(D.configCid || "{}").configCid; } catch { return null; } })();
  need("deployment.configCid: an envelope naming a configCid, for the synthetic config", typeof cid === "string" && cid);
  lab.configCids = { ...(lab.configCids || {}), [cid]: syn.config };
  lab.secrets = syn.secrets;
}
// the relay's configuration, as the api-relay reads it (set before the modules load)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "attested-release-lab-"));
Object.assign(process.env, {
  SECRETS_KEY: randomBytes(32).toString("hex"), AUTH_DATA_DIR: dataDir, SECRETS_ATTESTED_RELEASE: "1",
  SECRETS_RELEASE_DEPLOYMENTS: D.id, SECRETS_RELEASE_VMPL: "0", SECRETS_RELEASE_MIN_TCB: JSON.stringify(lab.minTcb),
  SECRETS_RELEASE_SIGNING_KEY: fs.readFileSync(lab.signingSeedFile, "utf8").trim(),
});
const { initSecrets, handleSecrets, applyPut } = await import(path.join(root, "relay/secrets.js"));
const R = await import(path.join(root, "relay/secrets-release.mjs"));
const M = await import(path.join(root, "relay/measurement-predict.mjs"));
const { provenSnpChip, parseSnpReport, snpProductHint, kdsVcekUrl, certChain, vcekMatchesReport } = await import(path.join(root, "relay/snp-verify.mjs"));
const { verifyEvidence, httpCollateral } = await import(path.join(root, "verifier/index.mjs"));
const { createPublicClient, http: viemHttp, keccak256, stringToBytes } = await import("viem");
const { base } = await import("viem/chains");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
await initSecrets();
if (lab.secrets && Object.keys(lab.secrets).length) applyPut(D.id, JSON.stringify({ set: lab.secrets }));

const pub = R.ed25519RawPublic(R.signingKeyFromSeed(Buffer.from(process.env.SECRETS_RELEASE_SIGNING_KEY, "hex")));
say(`LAB relay for ${D.id} (${D.appRef}, ${D.isPublic === false ? "private" : "public"}); release signing public key ${pub.toString("hex")} (keyId ${R.keyIdOf(pub)}; SYNTHETIC)`);
say("LAB (a): the ledger row and confirmRow come from the lab file; (b) the chip from a supplied report's AMD chain; (c) the ticket signer is the lab operator; (d) synthetic secrets and configs");

// ---- (b) the lease holder's chip: a real report, its AMD chain verified here, then the relay's own provenSnpChip rule ----
async function amdChainOf(report) {
  const p = parseSnpReport(report), product = snpProductHint(p);
  if (!product) throw new Error("the report names no product line");
  const vcek = new X509Certificate(Buffer.from(await (await fetch(kdsVcekUrl(product, p))).arrayBuffer()));
  const [ask, ark] = await certChain(product);
  if (!vcek.verify(ask.publicKey) || !ask.verify(ark.publicKey)) throw new Error("the VCEK does not chain to the pinned ARK");
  const rs = (b) => { b = Buffer.from(b).reverse(); let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const r = rs(p.signature.subarray(0, 48)), s = rs(p.signature.subarray(0x48, 0x48 + 48));
  const seq = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s]);
  const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
  if (!v.verify({ key: vcek.publicKey, dsaEncoding: "der" }, Buffer.concat([Buffer.from([0x30, seq.length]), seq]))) throw new Error("the VCEK signature does not verify");
  const mismatch = vcekMatchesReport(vcek.raw, product, p);
  if (mismatch) throw new Error(mismatch);
  return product;
}
const chipDoc = JSON.parse(fs.readFileSync(lab.chipReport, "utf8"));
const chipReport = Buffer.from((chipDoc.doc || chipDoc).report, "base64");
const product = await amdChainOf(chipReport).catch((e) => die(`the chip report does not verify: ${e.message}`));
const chip = provenSnpChip(chipReport, { ok: true, vcekVerified: true });
if (!chip) die("the chip report proves no chip (not VCEK-signed, or CHIP_ID zero)");
say(`(b) chip proven by its AMD chain (${product}): ${chip.slice(0, 16)}…`);

// ---- the predictor, as the api-relay builds it ----
const clients = lab.rpcs.map((u) => createPublicClient({ chain: base, transport: viemHttp(u, { timeout: 6_000 }) }));
const BOOK = lab.addressBook || "0xab214342d5A490150A4A977063A2f88E21F80907";
const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const bookKey = (n) => "0x" + Buffer.from(n, "ascii").toString("hex").padEnd(64, "0");
const agreedBook = async (n) => {
  const got = await Promise.all(clients.map((c) => c.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "addr", args: [bookKey(n)] })));
  if (got.some((a) => a.toLowerCase() !== got[0].toLowerCase())) throw new Error(`the RPCs disagree about ${n}`);
  return got[0];
};
const catalogAddr = await agreedBook("appCatalog");
const predictor = M.makePredictor({ ...lab.predictor, readCatalog: M.catalogReader(clients, catalogAddr) });
if (predictor.problems.length) die(`predictor: missing ${predictor.problems.join(", ")}`);
const kat = await predictor.selfTest();
if (!kat.ok) die(`known-answer test: ${kat.reason}`);
say(`predictor: ${kat.reason}; toolchain ${lab.predictor.commit.slice(0, 12)}; admitted ${lab.predictor.admit.map((a) => a.slice(0, 12)).join(", ")}`);
const t0 = Date.now(), pre = await predictor.expectedFor(D.appRef, { forPrivate: D.isPublic === false });
if (!pre.ok) die(`the lab deployment's version has no prediction: ${pre.code}: ${pre.reason}`);
say(`prediction for ${D.appRef} (${Date.now() - t0} ms): AppID ${pre.appId}; ${pre.images.map((i) => `release ${i.release.slice(0, 12)} -> ${i.measurement}`).join("; ")}`);
{ // the derivation record(s) the prediction was made from, for the guest side to diff against the supervisor's own
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(D.appRef), cat = await M.catalogReader(clients, catalogAddr)(m[1].toLowerCase(), Number(m[2]));
  const rids = [...new Set(pre.images.map((i) => i.runtimeId))];
  for (const rid of rids) { const rec = M.derivationRecord(D.appRef, cat.version, rid); say(`derivation record (recordSha256 ${createHash("sha256").update(M.canonical(rec)).digest("hex")}): ${M.canonical(rec)}`); }
  say(`the version on chain: cid ${cat.version.cid}, memMb ${cat.version.memMb}, ports ${JSON.stringify(cat.version.ports)}, approval ${cat.version.approval}, yanked ${cat.version.yanked}`);
}

// ---- (a) the ledger row: live lease, runner = the endpoint's registry id ----
const runner = keccak256(stringToBytes(D.endpoint)).toLowerCase();
const row = () => ({ id: D.id, owner: lab.owner || "0x" + "00".repeat(20), runner, leaseUntil: String(Math.floor(Date.now() / 1000) + 1800),
                     appRef: D.appRef, isPublic: D.isPublic !== false, configCid: D.configCid || "", active: true });
let operator = (lab.operator || "").toLowerCase(), dryOp = null;
if (mode === "dry-run") { dryOp = privateKeyToAccount(generatePrivateKey()); operator = dryOp.address.toLowerCase(); say(`dry-run: a per-run operator key ${operator}`); }
const collateral = httpCollateral();
const ctx = {
  json: (res, code, body) => { res.statusCode = code; if (res.setHeader) res.setHeader("content-type", "application/json"); res.end ? res.end(JSON.stringify(body)) : Object.assign(res, { code, body }); },
  readBody: (req, max) => req.body !== undefined ? Promise.resolve(Buffer.from(JSON.stringify(req.body))) : new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (d) => { n += d.length; if (n > max) { reject(new Error("body too large")); req.destroy(); } else parts.push(d); });
    req.on("end", () => resolve(Buffer.concat(parts))); req.on("error", reject);
  }),
  clientIp: (req) => (req.socket && req.socket.remoteAddress) || "127.0.0.1",
  ledgerRows: async () => [row()], ledgerExpire: () => {},
  endpointIdOf: async (ep) => keccak256(stringToBytes(String(ep))).toLowerCase(),
  operatorOfEndpoint: async (ep) => (String(ep).replace(/\/+$/, "") === D.endpoint.replace(/\/+$/, "") ? operator : null),
  hostEligibility: () => ({ eligible: true, reason: "LAB: no fleet eligibility feed" }),
  leaseHolderChipIds: async (ep) => (String(ep).replace(/\/+$/, "") === D.endpoint.replace(/\/+$/, "") ? [chip] : []),
  confirmRow: async (id) => { if (id !== D.id) throw new Error("the lab ledger holds no such deployment"); return row(); },
  runtimeIdOf: (r) => Buffer.from(M.runtimeIdOfJson(JSON.stringify(r)), "hex"),
  expectedGuestFor: (r, o) => predictor.expectedFor(r && r.appRef, o),
  predictorProblems: () => predictor.problems,
  versionConfigFor: async () => lab.versionConfig ?? null,
  resolveConfigCid: async (cid) => (lab.configCids && cid in lab.configCids ? lab.configCids[cid] : null),
  verifyGuestEvidence: (doc, { allowedMeasurements, minTcb, expectedVmpl, expectedBinding, expectedAppId, expectedHostData }) => verifyEvidence(doc, {
    policy: { snp: { allowedMeasurements, minTcb, expectedVmpl } },
    context: { transportKeySpki: Buffer.from(doc.transportKey, "base64"), expectedBinding, expectedAppId, expectedHostData, now: new Date().toISOString() },
    collateral }),
};
const handle = (req, res) => {
  const u = new URL(req.url, "http://lab");
  const t = Date.now(), end = res.end.bind(res);
  res.end = (b) => { let e = ""; try { e = JSON.parse(b).error || "ok"; } catch {} say(`${req.method} ${u.pathname} -> ${res.statusCode} ${e} (${Date.now() - t} ms)`); return end(b); };
  if (!u.pathname.startsWith("/v1/secrets/")) { res.statusCode = 404; return res.end(JSON.stringify({ error: "not_found" })); }
  handleSecrets(req, res, u, ctx).catch((e) => { res.statusCode = 500; res.end(JSON.stringify({ error: "internal", message: String(e.message) })); });
};

if (mode === "serve") {
  const [host, port] = String(lab.listen || "127.0.0.1:18443").split(":");
  const server = lab.tls ? https.createServer({ cert: fs.readFileSync(lab.tls.cert), key: fs.readFileSync(lab.tls.key) }, handle) : http.createServer(handle);
  server.listen(Number(port), host, () => say(`serving ${lab.tls ? "https" : "http"}://${host}:${port}/v1/secrets/* (LAB)`));
  // optional plain HTTP on LOOPBACK for the supervisor half only: the ticket (its security is the operator signature and the
  // live lease, not TLS) and the status. The release itself is served only over the TLS listener the guest pins.
  if (lab.plainListen) {
    const [ph, pp] = String(lab.plainListen).split(":");
    if (!["127.0.0.1", "::1", "localhost"].includes(ph)) die("plainListen must be a loopback address");
    http.createServer((req, res) => {
      const p = new URL(req.url, "http://lab").pathname;
      if (p !== "/v1/secrets/release-ticket" && p !== "/v1/secrets/release-status") { res.statusCode = 404; return res.end(JSON.stringify({ error: "tls_only", message: "only the ticket and status are served here" })); }
      handle(req, res);
    }).listen(Number(pp), ph, () => say(`serving http://${ph}:${pp}/v1/secrets/{release-ticket,release-status} (LAB, loopback, supervisor half only)`));
  }
} else {
  // dry-run: the handler in-process, a per-run operator, no guest. Proves the wiring up to evidence judgement.
  const call = async (method, p, body) => { const res = {}; await handleSecrets({ method, body, socket: { remoteAddress: "127.0.0.1" } }, res, new URL("http://lab" + p), ctx); return res; };
  const fails = []; const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const st = await call("GET", `/v1/secrets/release-status?id=${D.id}`);
  expect(st.code === 200 && st.body.listed === true, `release-status lists the lab deployment (${st.code} ${JSON.stringify(st.body)})`);
  const ts = Math.floor(Date.now() / 1000), ep = D.endpoint.replace(/\/+$/, "");
  const tk = await call("POST", "/v1/secrets/release-ticket", { id: D.id, endpoint: ep, ts, opSig: await dryOp.signMessage({ message: `enclave-secrets-release-ticket:${D.id}:${ep}:${ts}` }) });
  expect(tk.code === 200 && typeof tk.body.ticket === "string", `a ticket for the operator-signed request (${tk.code} ${tk.body.error || ""})`);
  const junk = { format: "sev-snp-guest-domain-v1", abi: "enclave-domain-abi/2", report: Buffer.alloc(0x4a0).toString("base64"),
                 transportKey: Buffer.alloc(91).toString("base64"), runtime: { name: "not-a-runtime" } };
  const rel = await call("POST", "/v1/secrets/release", { id: D.id, ticket: tk.body.ticket, sealKey: randomBytes(32).toString("base64"), evidence: junk });
  expect(rel.code === 403 && rel.body.sealed === undefined, `evidence that is no guest's is refused and nothing is released (${rel.code} ${rel.body.error}: ${String(rel.body.message).slice(0, 80)})`);
  const again = await call("POST", "/v1/secrets/release", { id: D.id, ticket: tk.body.ticket, sealKey: randomBytes(32).toString("base64"), evidence: junk });
  expect(again.code === 403 && again.body.error === "bad_ticket", "the ticket was consumed by that 403");
  // a REAL chip-signed guest document (the chip report's own guest: right runtime, another image and binding) reaches the
  // evidence verifier with KDS collateral, and is refused there or by the relay's re-read
  if (chipDoc.doc && chipDoc.doc.runtime) {
    const real = { ...chipDoc.doc }; delete real.nonce;   // a release document states none
    const t2s = Math.floor(Date.now() / 1000) + 1;
    const t2 = await call("POST", "/v1/secrets/release-ticket", { id: D.id, endpoint: ep, ts: t2s, opSig: await dryOp.signMessage({ message: `enclave-secrets-release-ticket:${D.id}:${ep}:${t2s}` }) });
    const r2 = await call("POST", "/v1/secrets/release", { id: D.id, ticket: t2.body.ticket, sealKey: randomBytes(32).toString("base64"), evidence: real });
    expect(t2.code === 200 && r2.code === 403 && r2.body.error === "evidence_refused" && r2.body.sealed === undefined,
      `a real guest's report of another image is refused by the evidence verifier (${r2.code} ${r2.body.error}: ${String(r2.body.message).slice(0, 110)})`);
  }
  const other = await call("GET", `/v1/secrets/release-status?id=0x${"ab".repeat(32)}`);
  expect(other.code === 200 && other.body.listed === false, "another deployment is not listed");
  console.log(fails.length ? `FAIL ${fails.length}` : "PASS lab relay dry run (wiring through the real handler, predictor and chip proof; no guest)");
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}
