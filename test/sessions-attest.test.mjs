// Attested session keys (docs/design/sessions.md §10, phase g) end to end on a local chain: EnclaveKeyAttestations
// deployed by scripts/deploy-key-attestations.mjs (the relayer as its attestor), a SessionVaultFactory deployed by
// scripts/deploy-session-vault.mjs pinning it, and the REAL relay route POST /v1/sessions/attest driven through the SDK.
//
// What runs against what:
//   - The success path uses an INJECTED SNP verifier (attestor.verifySnp): no test can produce an AMD-signed report whose
//     report_data commits to a key made here. The stub stands in for the signature/chain check ONLY; everything the
//     route decides itself (report_data binding, guest policy, VMPL, signing key, measurement mapping, the verdict's
//     own fields, the chain state, the write) is the real code.
//   - The refusal paths of the DEFAULT verifier (relay/snp-verify.mjs verifyQuote, the AMD chains from
//     test/fixtures/amd seeded through its own ARK pin, KDS off) run for real: a report signed by a key that is not
//     AMD's, a report altered after signing, and a report with no VCEK at all.
// Every refusal is checked to have written nothing: the relayer's nonce is unchanged and the key has no binding.
// Skips the chain cases when Foundry (anvil/forge) or the built SDK is absent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, sign as cryptoSign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http as viemHttp, parseUnits, keccak256, encodeAbiParameters } from "viem";
import { foundry } from "viem/chains";
import { haveFoundry, startChain, deployPlatform, KEYS } from "./helpers/sessions-chain.mjs";
import { createSessionsService, sessionKeyReportData as relayReportData, snpMeasurementToBytes32 as relayMeasurement,
  keyAttestationsAbi, vcekAuxblob } from "../relay/sessions.mjs";
import { parseSnpReport } from "../relay/snp-verify.mjs";
import { JsonStore } from "../relay/store.js";
import { deployKeyAttestations, compileKeyAttestations } from "../scripts/deploy-key-attestations.mjs";
import { deploySessionVault } from "../scripts/deploy-session-vault.mjs";

const SDK = new URL("../sdk/sessions/dist/node.mjs", import.meta.url);
const sdk = fs.existsSync(SDK) ? await import(SDK) : null;
const skip = !haveFoundry() || !sdk ? "needs Foundry (anvil + forge) and a built SDK (cd sdk/sessions && node build.mjs)" : false;

const CHAIN_ID = 31337;
const MEAS = "a1".repeat(48), MEAS2 = "b2".repeat(48);
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "amd");
const chainPem = (p) => fs.readFileSync(path.join(FIXTURES, `${p}-cert_chain.pem`), "utf8");
const MIN_TCB = { Milan: { bootloader: 0, tee: 0, snp: 0, microcode: 0 }, Genoa: { bootloader: 0, tee: 0, snp: 0, microcode: 0 },
  Turin: { fmc: 0, bootloader: 0, tee: 0, snp: 0, microcode: 0 } };

// ---- an SNP report, laid out per the SEV-SNP ABI (the fields the relay reads) ----
function snpReport({ reportData, measurement = MEAS, policy = 0x30000n, vmpl = 0, version = 5, signingKey = 0,
  chip = randomBytes(64) } = {}) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(version, 0x00);
  r.writeBigUInt64LE(policy, 0x08);               // bit 16 reserved-must-be-one, SMT (17); DEBUG (19), MIGRATE_MA (18) off
  r.writeUInt32LE(vmpl, 0x30);
  r.writeUInt32LE(signingKey << 2, 0x48);
  Buffer.from(reportData).copy(r, 0x50);
  Buffer.from(measurement, "hex").copy(r, 0x90);
  chip.copy(r, 0x1a0);
  return r;
}

// ---- the stand-in for the AMD signature check (see the header): a verdict shaped like verifyQuote's ----
const stub = { calls: 0, mode: "pass" };
async function stubVerifier(report, { minTcb, vmpl }) {
  stub.calls++;
  assert.ok(minTcb && typeof minTcb === "object", "the route hands the verifier its TCB policy");
  const p = parseSnpReport(report);
  const measurement = p.measurement.toString("hex");
  if (stub.mode === "badsig") return { ok: false, measurement: null, reasons: ["VCEK signature over the report is invalid"] };
  const v = { ok: true, measurement, reasons: ["(stub) AMD signature chain verified"], vcekVerified: true, vmpl: p.vmpl,
    tcb: { product: "Genoa", reported: { bootloader: 9, tee: 0, snp: 23, microcode: 72 }, checked: true } };
  if (stub.mode === "no-vcek") return { ...v, vcekVerified: false, reasons: ["WARN: AMD signature chain inconclusive (no VCEK)"] };
  if (stub.mode === "tcb-unjudged") return { ...v, tcb: { ...v.tcb, checked: false } };
  if (stub.mode === "other-measurement") return { ...v, measurement: MEAS2 };
  if (stub.mode === "other-vmpl") return { ...v, vmpl: vmpl + 1 };
  return v;
}

let chain, P, ka, factory2, svc, server, relayUrl, tmp, relayClient;
const stores = [];
const owner = privateKeyToAccount(KEYS.owner);
const relayer = privateKeyToAccount(KEYS.relayer);
const deployer = privateKeyToAccount(KEYS.deployer);
const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };

function service(attestor, name) {
  return createSessionsService({
    pc: chain.pc, wc: createWalletClient({ chain: foundry, account: relayer, transport: viemHttp(chain.rpc) }),
    account: relayer, chainId: CHAIN_ID, factory: factory2, book: P.book, usdc: P.usdc, router: P.router,
    startBlock: P.deployBlock, ethUsd: 3000, minFee6: 500, now: chain.now,
    feesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    store: (stores[stores.length] = new JsonStore(path.join(tmp, `${name}-idx.json`), {})),
    journal: (stores[stores.length] = new JsonStore(path.join(tmp, `${name}-j.json`), { txs: [] }, { durable: true })),
    attestor, log: (...a) => { if (process.env.SESSIONS_TEST_LOG) console.log(`[${name}]`, ...a); },
  });
}
async function serve(s) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://relay.test");
    if (u.pathname.startsWith("/v1/sessions")) return s.handle(req, res, u, null);
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

before(async () => {
  if (skip) return;
  chain = await startChain();
  P = await deployPlatform(chain);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-attest-"));
  const k = await deployKeyAttestations({ rpc: chain.rpc, chain: foundry, privateKey: KEYS.deployer, owner: deployer.address,
    attestor: relayer.address, log: () => {} });
  ka = k.address;
  const f = await deploySessionVault({ rpc: chain.rpc, chain: foundry, privateKey: KEYS.deployer, usdc: P.usdc, book: P.book,
    router: P.router, keyAttestations: ka, maxVault6: parseUnits("1000", 6), log: () => {} });
  factory2 = f.factory;
  svc = service({ address: ka, minTcb: MIN_TCB, vmpl: 0, measurements: "*", verifySnp: stubVerifier }, "relay");
  ({ srv: server, url: relayUrl } = await serve(svc));
  relayClient = new sdk.RelayClient(relayUrl);
});

after(() => {
  for (const st of stores) clearInterval(st._timer);
  server?.close(); chain?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- helpers ----
const binding = (keyHash) => chain.pc.readContract({ address: ka, abi: keyAttestationsAbi, functionName: "bindingOf", args: [keyHash] });
const relayerNonce = () => chain.pc.getTransactionCount({ address: relayer.address });
async function newKey() {
  const store = new sdk.MemoryStore();
  const { signer, record } = await sdk.newSessionKey(store, { relay: relayUrl, chainId: CHAIN_ID, label: "enclave key", extractable: true });
  return { signer, record, store };
}
const evidenceFor = (signer, over = {}) => ({ type: "sev-snp",
  report: snpReport({ reportData: sdk.sessionKeyReportData(CHAIN_ID, signer.x, signer.y), ...over }) });
/** a refusal that must leave the chain untouched */
async function refused(promise, code, keyHash, re) {
  const n0 = await relayerNonce();
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
  assert.equal(await relayerNonce(), n0, "nothing was sent");
  if (keyHash) assert.deepEqual(await binding(keyHash), ["0x" + "00".repeat(32), false], "nothing was recorded");
}

// ======================= pure: the binding bytes =======================

test("report_data: the SDK and the relay compute the same bytes, and they are the documented preimage's sha256", async (t) => {
  if (!sdk) return t.skip("needs the built SDK");
  const x = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
  const y = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
  const want = createHash("sha256").update(Buffer.concat([Buffer.from("enclave-session-key-v1", "ascii"),
    Buffer.from(BigInt(8453).toString(16).padStart(64, "0"), "hex"), Buffer.from(x.toString(16).padStart(64, "0"), "hex"),
    Buffer.from(y.toString(16).padStart(64, "0"), "hex")])).digest();
  assert.deepEqual(Buffer.from(relayReportData(8453, x, y)), want);
  assert.deepEqual(Buffer.from(sdk.sessionKeyReportData(8453, x, y)), want);
  assert.notDeepEqual(Buffer.from(sdk.sessionKeyReportData(84532, x, y)), want, "the chain id is bound");
  assert.notDeepEqual(Buffer.from(sdk.sessionKeyReportData(8453, y, x)), want, "x and y are not interchangeable");
  // the measurement mapping, both sides
  const m48 = Buffer.from(MEAS, "hex");
  const m32 = "0x" + createHash("sha256").update(m48).digest("hex");
  assert.equal(relayMeasurement(MEAS), m32);
  assert.equal(sdk.snpMeasurementToBytes32("0x" + MEAS), m32);
  assert.throws(() => relayMeasurement("aa".repeat(32)), /48 bytes/);
  assert.throws(() => sdk.snpMeasurementToBytes32("0x" + "aa".repeat(32)), /48 bytes/);
});

test("the relay's hand-written EnclaveKeyAttestations ABI matches the compiled contract", () => {
  const compiled = compileKeyAttestations().abi;
  const sig = (e) => `${e.type} ${e.name}(${(e.inputs || []).map((i) => i.type + (i.indexed ? " indexed" : "")).join(",")})`
    + (e.outputs ? ` -> (${e.outputs.map((o) => o.type === "tuple" ? `(${o.components.map((c) => c.type).join(",")})` : o.type).join(",")})` : "");
  const have = new Set(compiled.map(sig));
  for (const e of keyAttestationsAbi) assert.ok(have.has(sig(e)), `${sig(e)} is not in the compiled ABI`);
});

test("vcekAuxblob lays out one VCEK entry the way the guest's certificate table does", () => {
  const der = Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), randomBytes(256)]);
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  for (const v of [pem, der.toString("hex"), "0x" + der.toString("hex")]) {
    const a = vcekAuxblob(v);
    assert.equal(a.subarray(0, 16).toString("hex"), "63da758de6644564adc5f4b93be8accd");
    assert.equal(a.readUInt32LE(16), 48);
    assert.equal(a.readUInt32LE(20), der.length);
    assert.ok(a.subarray(24, 48).every((b) => b === 0), "zero terminator");
    assert.deepEqual(a.subarray(48), der);
  }
  assert.throws(() => vcekAuxblob("not a cert"), /DER certificate/);
});

// ======================= the route, on chain =======================

test("an attested key opens a measurement-bound grant through the relay, and an unattested one cannot", { skip }, async () => {
  const cfg = await relayClient.config();
  assert.equal(cfg.keyAttestations, ka);
  const vault = await sdk.vaultAddress(chain.pc, factory2, owner.address);
  const usdc = await sdk.usdcDomain(chain.pc, P.usdc, CHAIN_ID);
  const measurement = relayMeasurement(MEAS);

  // a key nobody attested: the vault refuses the grant (the relay relays its NoAttestation)
  const loose = await newKey();
  const g0 = sdk.buildGrant({ sessionKey: loose.signer.keyHash, label: "unattested", preset: "browser",
    policy: { budget: parseUnits("1", 6), measurement } });
  await assert.rejects(sdk.openSession({ relay: relayClient, owner: ownerSigner, chainId: CHAIN_ID, vault, grant: g0, usdc }),
    (e) => e.code === "policy" && e.detail?.error === "NoAttestation");

  // the enclave's key: attested, then the same grant shape opens
  const { signer, record, store } = await newKey();
  const calls = stub.calls;
  const res = await sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) });
  assert.equal(stub.calls, calls + 1, "the verifier judged the report");
  assert.equal(res.keyHash, signer.keyHash);
  assert.equal(res.measurement, measurement);
  assert.equal(res.snpMeasurement, MEAS);
  assert.match(res.mapping, /sha256/);
  assert.equal(res.contract, ka);
  assert.equal(res.attestor, relayer.address);
  assert.equal(res.already, false);
  assert.match(res.txHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await binding(signer.keyHash), [measurement, false]);
  const rec = await chain.pc.readContract({ address: ka, abi: keyAttestationsAbi, functionName: "getBinding", args: [signer.keyHash] });
  assert.equal(rec.attestor, relayer.address);

  // the same evidence again: nothing to write
  const n0 = await relayerNonce();
  const again = await sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) });
  assert.equal(again.already, true);
  assert.equal(again.txHash, null);
  assert.equal(await relayerNonce(), n0);

  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "attested", preset: "browser",
    policy: { budget: parseUnits("1", 6), measurement } });
  const out = await sdk.openSession({ relay: relayClient, owner: ownerSigner, chainId: CHAIN_ID, vault, grant, usdc });
  const done = await sdk.completeSession(store, record, { vault, owner: owner.address, grant, rpc: chain.rpc });
  const session = await sdk.sessionFromRecord(done);
  const st = await session.status();
  assert.equal(st.live, true);
  assert.equal(st.measurement, measurement);
  const t0 = await chain.pc.readContract({ address: P.usdc, abi: P.abi.usdc.abi, functionName: "balanceOf", args: [P.treasury] });
  const mk = { appRef: P.storeRef, gpuMilli: 0, cpuMilli: 1000, appPort: 8080, ports: "", isPublic: false, configCid: "",
    maxRate6: 1000n, env: "staging", fund6: 1000n };
  const paid = await session.call("deploy.create", mk);
  const t1 = await chain.pc.readContract({ address: P.usdc, abi: P.abi.usdc.abi, functionName: "balanceOf", args: [P.treasury] });
  // (in this rig the ledger's platform payout IS the treasury, so the funding's platform share lands there too)
  assert.ok(t1 >= t0 + paid.fee, "the operation ran (its relay fee reached the treasury)");

  // governance revokes the key (a TCB advisory): the next operation is refused by the vault, and the key cannot be re-attested
  const gov = chain.wc(KEYS.deployer);
  await chain.pc.waitForTransactionReceipt({ hash: await gov.writeContract({ address: ka, abi: [
    { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }],
  functionName: "revoke", args: [signer.keyHash] }) });
  await assert.rejects(session.call("deploy.create", mk),
    (e) => e.code === "policy" && e.detail?.error === "NoAttestation");
  const n1 = await relayerNonce();
  await assert.rejects(sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) }),
    (e) => e.code === "key_revoked");
  assert.equal(await relayerNonce(), n1, "nothing was sent");
  void out;
});

test("refusals: report_data, guest policy, VMPL, signing key, length, evidence type, key - and nothing is written", { skip }, async () => {
  const { signer } = await newKey();
  const ask = (evidence, k = signer) => sdk.requestAttestation(relayClient, { x: k.x, y: k.y, evidence });
  const calls = stub.calls;
  const kh = signer.keyHash;
  // report_data for another chain, for another key, and not bound at all
  await refused(ask({ type: "sev-snp", report: snpReport({ reportData: sdk.sessionKeyReportData(8453, signer.x, signer.y) }) }),
    "report_data_mismatch", kh);
  const other = await newKey();
  await refused(ask({ type: "sev-snp", report: snpReport({ reportData: sdk.sessionKeyReportData(CHAIN_ID, other.signer.x, other.signer.y) }) }),
    "report_data_mismatch", kh);
  await refused(ask({ type: "sev-snp", report: snpReport({ reportData: Buffer.alloc(64) }) }), "report_data_mismatch", kh);
  // a DEBUG guest (the host can read the key), a migratable one, another VMPL, a VLEK-signed report
  await refused(ask(evidenceFor(signer, { policy: 0x30000n | (1n << 19n) })), "policy_refused", kh, /DEBUG/);
  await refused(ask(evidenceFor(signer, { policy: 0x30000n | (1n << 18n) })), "policy_refused", kh, /MIGRATE_MA/);
  await refused(ask(evidenceFor(signer, { vmpl: 2 })), "vmpl_mismatch", kh);
  await refused(ask(evidenceFor(signer, { signingKey: 1 })), "not_vcek_signed", kh);
  await refused(ask(evidenceFor(signer, { version: 1 })), "bad_report", kh);
  assert.equal(stub.calls, calls, "none of those reached the verifier (no KDS fetch for a report that cannot pass)");
  // malformed input
  const ev = evidenceFor(signer);
  await refused(ask({ ...ev, report: Buffer.concat([ev.report, Buffer.alloc(1)]) }), "bad_report", kh);
  await refused(ask({ ...ev, report: ev.report.subarray(0, 0x330) }), "bad_report", kh);
  await refused(ask({ ...ev, type: "tdx" }), "unsupported_evidence", kh);
  await refused(ask({ ...ev, vcek: "garbage" }), "bad_vcek", kh);
  await refused(relayClient.request("POST", "/attest", { x: signer.x, y: signer.y + 1n, evidence: { type: "sev-snp", report: "0x" + ev.report.toString("hex") } }),
    "bad_key");
  await refused(relayClient.request("POST", "/attest", { x: signer.x, y: signer.y }), "bad_request", kh);
  await refused(relayClient.request("POST", "/attest", { x: "nope", y: signer.y, evidence: ev }), "bad_request", kh);
  assert.equal(stub.calls, calls);
});

test("refusals from the verdict: a bad signature, no VCEK, an unjudged TCB, a verdict that disagrees with the report", { skip }, async () => {
  const { signer } = await newKey();
  const ask = () => sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) });
  try {
    stub.mode = "badsig";
    await refused(ask(), "evidence_refused", signer.keyHash, /signature over the report is invalid/);
    stub.mode = "no-vcek";
    await refused(ask(), "evidence_refused", signer.keyHash, /VCEK/);
    stub.mode = "tcb-unjudged";
    await refused(ask(), "evidence_refused", signer.keyHash, /TCB/);
    stub.mode = "other-measurement";
    await refused(ask(), "evidence_refused", signer.keyHash, /measurement/);
    stub.mode = "other-vmpl";
    await refused(ask(), "evidence_refused", signer.keyHash, /VMPL/);
    // and a masked CHIP_ID proves no chip, whatever the verdict says
    stub.mode = "pass";
    await refused(sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer, { chip: Buffer.alloc(64) }) }),
      "evidence_refused", signer.keyHash, /VCEK/);
  } finally { stub.mode = "pass"; }
});

test("a key belongs to one image: a second measurement is refused, and so is anything the allowlist does not name", { skip }, async () => {
  const { signer } = await newKey();
  await sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) });
  const n0 = await relayerNonce();
  await assert.rejects(sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer, { measurement: MEAS2 }) }),
    (e) => e.code === "measurement_conflict");
  assert.equal(await relayerNonce(), n0);
  assert.deepEqual(await binding(signer.keyHash), [relayMeasurement(MEAS), false]);

  // an allowlisting relay (same contract, same key): only the named image
  const strict = service({ address: ka, minTcb: MIN_TCB, vmpl: 0, measurements: [MEAS2], verifySnp: stubVerifier }, "strict");
  const s = await serve(strict);
  try {
    const k = await newKey();
    const rc = new sdk.RelayClient(s.url);
    await refused(sdk.requestAttestation(rc, { x: k.signer.x, y: k.signer.y, evidence: evidenceFor(k.signer) }),
      "measurement_not_allowed", k.signer.keyHash);
    const ok = await sdk.requestAttestation(rc, { x: k.signer.x, y: k.signer.y, evidence: evidenceFor(k.signer, { measurement: MEAS2 }) });
    assert.equal(ok.measurement, relayMeasurement(MEAS2));
  } finally { s.srv.close(); }
});

test("the route is off without a complete attestor config, and refuses when the relay is not an attestor", { skip }, async () => {
  const { signer } = await newKey();
  const ev = evidenceFor(signer);
  for (const [name, attestor, re] of [
    ["off", undefined, /not enabled/],
    ["no-tcb", { address: ka, vmpl: 0, measurements: "*" }, /minimum-TCB/],
    ["no-vmpl", { address: ka, minTcb: MIN_TCB, measurements: "*" }, /VMPL/],
    ["no-measurements", { address: ka, minTcb: MIN_TCB, vmpl: 0 }, /measurement policy/],
    ["bad-measurements", { address: ka, minTcb: MIN_TCB, vmpl: 0, measurements: ["abcd"] }, /measurement policy/],
    ["no-address", { minTcb: MIN_TCB, vmpl: 0, measurements: "*" }, /EnclaveKeyAttestations address/],
  ]) {
    const s = await serve(service(attestor, name));
    try {
      await refused(sdk.requestAttestation(new sdk.RelayClient(s.url), { x: signer.x, y: signer.y, evidence: ev }),
        "attest_disabled", signer.keyHash, re);
    } finally { s.srv.close(); }
  }
  // a registry that has not named this relay
  const bare = await deployKeyAttestations({ rpc: chain.rpc, chain: foundry, privateKey: KEYS.deployer, owner: deployer.address, log: () => {} });
  const s = await serve(service({ address: bare.address, minTcb: MIN_TCB, vmpl: 0, measurements: "*", verifySnp: stubVerifier }, "bare"));
  try {
    const n0 = await relayerNonce();
    await assert.rejects(sdk.requestAttestation(new sdk.RelayClient(s.url), { x: signer.x, y: signer.y, evidence: ev }),
      (e) => e.code === "attestor_not_authorized");
    assert.equal(await relayerNonce(), n0);
  } finally { s.srv.close(); }
});

// ======================= the default verifier (relay/snp-verify.mjs), for real =======================

test("the default verifier refuses a report not signed by AMD, a report altered after signing, and one with no VCEK", { skip }, async () => {
  // A self-signed P-384 "VCEK" naming SEV-Milan (as test/snp-vcek-signature.test.mjs does): the report's signature
  // verifies against it, and the pinned AMD chain (fixtures, seeded through the ARK pin) must refuse it.
  const d = fs.mkdtempSync(path.join(tmp, "vcek-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1", "-nodes",
    "-keyout", `${d}/k.pem`, "-out", `${d}/c.pem`, "-days", "1", "-subj", "/CN=SEV-Milan"], { stdio: "ignore" });
  const key = fs.readFileSync(`${d}/k.pem`), pem = fs.readFileSync(`${d}/c.pem`, "utf8");
  const real = service({ address: ka, minTcb: MIN_TCB, vmpl: 0, measurements: "*", kds: false,
    certChains: { Milan: chainPem("Milan"), Genoa: chainPem("Genoa"), Turin: chainPem("Turin") } }, "real");
  const s = await serve(real);
  const rc = new sdk.RelayClient(s.url);
  try {
    const { signer } = await newKey();
    const signed = () => {
      const r = snpReport({ reportData: sdk.sessionKeyReportData(CHAIN_ID, signer.x, signer.y) });
      const sig = cryptoSign("sha384", r.subarray(0, 0x2a0), { key, dsaEncoding: "ieee-p1363" });
      Buffer.from(sig.subarray(0, 48)).reverse().copy(r, 0x2a0);
      Buffer.from(sig.subarray(48, 96)).reverse().copy(r, 0x2a0 + 0x48);
      return r;
    };
    const ask = (report, extra = { vcek: pem }) => sdk.requestAttestation(rc, { x: signer.x, y: signer.y, evidence: { type: "sev-snp", report, ...extra } });
    await refused(ask(signed()), "evidence_refused", signer.keyHash, /VCEK does not chain to ASK/);
    const tampered = signed(); tampered[0x10] ^= 1;
    await refused(ask(tampered), "evidence_refused", signer.keyHash, /signature over the report is invalid/);
    // the same, handed over as the guest's own certificate table
    const aux = vcekAuxblob(pem);
    await refused(ask(signed(), { auxblob: "0x" + aux.toString("hex") }), "evidence_refused", signer.keyHash, /VCEK does not chain to ASK/);
    // no VCEK and KDS off: unverifiable, so refused (never "measurement only")
    await refused(ask(signed(), {}), "evidence_refused", signer.keyHash, /no VCEK available/);
    // a seeded chain whose root is not AMD's never gets in
    assert.throws(() => service({ address: ka, minTcb: MIN_TCB, vmpl: 0, measurements: "*", kds: false, certChains: { Milan: pem } }, "fake-root"),
      /not AMD's pinned root/);
  } finally { s.srv.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

// keyHash as the vault computes it, for the record
test("the relay's keyHash is the vault's keccak256(abi.encode(x, y))", { skip }, async () => {
  const { signer } = await newKey();
  assert.equal(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [signer.x, signer.y])), signer.keyHash);
  const ok = await sdk.requestAttestation(relayClient, { x: signer.x, y: signer.y, evidence: evidenceFor(signer) });
  assert.equal(ok.keyHash, signer.keyHash);
});
