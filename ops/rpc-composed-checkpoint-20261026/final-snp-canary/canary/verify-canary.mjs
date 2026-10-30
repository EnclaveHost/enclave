// verify-canary.mjs: the canary's host-side check of the booted VERIFIER-ONLY direct-control guest, with PUBLISHED code only
// (tree = git archive of 10cdf913): metal/measured-control-verify.mjs verifyMeasuredControl + tlsGet, verifier/envelope.mjs +
// verifier/snp.mjs verifySnp (the SAME step-5 call the published verifier makes, here on the captured evidence), verifier/
// collateral-cache.mjs over verifier/collateral.mjs, verifier/metal-box.mjs TCB_FLOORS, and network/attested-verifier-client.mjs
// (checkAttestedReplicas, attestedOutcome, createAttestedVerifier, pinnedPost: the production verifier-only client). No new
// cryptography, no synthetic roots: AMD collateral is a COPY of the public cache (optionally refreshed from AMD KDS).
//   node canary/verify-canary.mjs --url https://127.0.0.1:P --config owner.json --wrong-config wrong.json --measurement <96 hex>
//        --expect-runtime runtime.json --collateral-dir DIR [--kds on|off] [--deadline-sec N] --out result.json
// There is NO registry read: a verifier-only replica is accepted by attestedOutcome only with registry === null.
// Exit 0 ONLY when acceptance() passes. REQUIRED:
//   A. positive (fresh nonce): the published verifier's statement/config+HOST_DATA/TLS key/AMD report with the expected
//      measurement/running supervisor checks, status "pending" (registry null) and attestedOutcome(...) = "attested";
//      archived evidence: HTTP 200, digest + HOST_DATA = owner config, TLS peer = statement key, same boot, mode snp,
//      runtime gsup/helper/supervisor = the image manifest, no mcp/platformApi runtime, no native member;
//   B. offline re-verification of the CAPTURED evidence through verifySnp: control (unchanged bytes) = verified (non-vacuity);
//      one flipped report byte = rejected; a changed statement byte = rejected (binding); another nonce = rejected (replay);
//   C. live rejections (fresh nonce each): wrong measurement -> rejected at the report (hardware measurement false);
//      wrong config (another unsafeSigner) -> rejected at config;
//   D. route fail-closed while the Base backend is unready: the production client attests the replica ("attested") and its
//      eth_blockNumber read FAILS with HTTP 502; direct pinned POSTs: a read -> 502 {"error":"service_unreachable"} (every
//      probe), a write method -> 403 method_refused; a wrong-measurement client never attests and its read fails;
//      checkAttestedReplicas refuses a caller whose sequencer pin differs from the bound config.
// Adapted 2026-10-25 from the root-reviewed native-final-canary/canary/verify-canary.mjs (a5bea76c).
import fs from "node:fs";
import tls from "node:tls";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tree");
const imp = (p) => import(path.join(TREE, p));
const { verifyMeasuredControl, tlsGet } = await imp("metal/measured-control-verify.mjs");
const MC = await imp("metal/guest/measured-control.mjs");
const { parseEnvelope } = await imp("verifier/envelope.mjs");
const { verifySnp } = await imp("verifier/snp.mjs");
const { cachedCollateral } = await imp("verifier/collateral-cache.mjs");
const { httpCollateral } = await imp("verifier/collateral.mjs");
const { TCB_FLOORS } = await imp("verifier/metal-box.mjs");
const AV = await imp("network/attested-verifier-client.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const flipHex = (m) => (m[0] === "0" ? "1" : "0") + m.slice(1);

export function hardwareVerdict(final, expectedMeasurement) {
  const c = final?.checks || {};
  const parts = { statement: c.statement === true, config: c.config === true, endpointKey: c["endpoint key"] === true,
    report: c.report === true && final?.identity?.measurement === expectedMeasurement, supervisor: c.supervisor === true };
  return { hardwarePass: Object.values(parts).every(Boolean), parts, wrapperStatus: final?.status ?? null, registryCheck: "registry" in c ? c.registry : "absent" };
}

/** the published verifier's step 5 (measured-control-verify.mjs), unchanged, on a captured evidence document */
export async function offlineReport(ev, { nonce, peerSpki, measurement, hostData, collateral, now = new Date() }) {
  try {
    const env = parseEnvelope({ format: "sev-snp-guest-domain-v1", report: ev.report, abi: "enclave-domain-abi/2", ...(typeof ev.certs === "string" ? { certs: ev.certs } : {}) });
    const v = await verifySnp(env, { allowedMeasurements: [measurement], minTcb: TCB_FLOORS, crl: "required" },
      { transportKeySpki: peerSpki, expectedBinding: MC.bindingFor(ev.statement, nonce), expectedAppId: MC.CONTROL_ROLE, expectedHostData: Buffer.from(hostData, "hex"), now,
        ...(typeof ev.certs === "string" ? { auxblob: Buffer.from(ev.certs, "base64") } : {}) }, collateral);
    return { status: v.status, failed: Object.entries(v.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k), reasons: (v.reasons || []).filter((r) => /REJECT/.test(r)).slice(0, 3) };
  } catch (e) { return { status: "error", error: String(e.message).slice(0, 200) }; }
}
export function tamperReport(ev, offset = 0x90) {     // one byte inside the signed report body (the MEASUREMENT field)
  const b = Buffer.from(ev.report, "base64"); b[offset] ^= 0x01; return { ...ev, report: b.toString("base64") };
}
export function tamperStatement(ev) {                 // one hex digit of the bound config digest inside the statement text
  const st = MC.parseStatement(ev.statement), d = st.configDigest, d2 = flipHex(d);
  if (!ev.statement.includes(d)) throw new Error("statement does not carry its digest verbatim");
  return { ...ev, statement: ev.statement.replace(d, d2) };
}

export function acceptance(R) {
  const v = R.verdict || hardwareVerdict(null, R.expected?.measurement), s = R.statementChecks || {}, rt = s.runtime || {};
  const expectedRuntime = Object.keys(R.expected?.runtime || {}), off = R.offline || {}, live = R.liveRejections || {}, rte = R.route || {};
  const required = {
    "A verifier: statement": v.parts?.statement === true, "A verifier: config + HOST_DATA": v.parts?.config === true,
    "A verifier: TLS peer = attested control key": v.parts?.endpointKey === true,
    "A verifier: AMD report verified with the expected measurement": v.parts?.report === true,
    "A verifier: running supervisor holds the minted keys": v.parts?.supervisor === true,
    "A verifier-only: status pending with registry null (no registry read)": v.wrapperStatus === "pending" && v.registryCheck === null,
    "A verifier-only: attestedOutcome = attested (production acceptance rule)": R.attestedOutcome?.status === "attested",
    "A evidence: HTTP 200": R.evidence?.status === 200,
    "A evidence: statement config digest = owner config": s.configDigest === true, "A evidence: statement HOST_DATA = owner config": s.hostData === true,
    "A evidence: TLS peer = statement control key": s.peerIsControlTls === true,
    "A evidence: same boot as the verifier (control key)": s.controlTlsSpkiSha256 != null && s.controlTlsSpkiSha256 === R.final?.identity?.controlTlsSpkiSha256,
    "A evidence: mode snp": s.mode === "snp",
    "A evidence: runtime gsup/helper/supervisor = the image manifest": expectedRuntime.length === 3 && expectedRuntime.every((k) => rt[k] === true),
    "A evidence: no mcpSha256/platformApiSha256 runtime": s.noMcpOrPlatformApi === true,
    "A evidence: no native member": s.noNative === true,
    "B offline control: captured evidence re-verifies (non-vacuity)": off.control?.status === "verified",
    "B tamper: flipped report byte rejected": off.reportByte?.status === "rejected",
    "B tamper: changed statement byte rejected": off.statementByte?.status === "rejected",
    "B replay: another nonce rejected": off.otherNonce?.status === "rejected",
    "C wrong measurement rejected at the report": live.wrongMeasurement?.status === "rejected" && live.wrongMeasurement?.checks?.report === false && live.wrongMeasurement?.hardwareMeasurement === false,
    "C wrong config rejected at config": live.wrongConfig?.status === "rejected" && live.wrongConfig?.checks?.config === false,
    "D client: replica attested while the backend is unready": rte.client?.attest?.[0] === true && rte.client?.replicaStatus === "attested",
    "D client: read fails closed (HTTP 502)": rte.client?.read?.ok === false && /HTTP 502/.test(rte.client?.read?.error || ""),
    "D route: every read probe 502 service_unreachable": Array.isArray(rte.readProbes) && rte.readProbes.length >= 2 && rte.readProbes.every((p) => p.status === 502 && p.error === "service_unreachable"),
    "D route: write method 403 method_refused": rte.writeProbe?.status === 403 && rte.writeProbe?.error === "method_refused",
    "D client: wrong measurement never attests and its read fails": rte.wrongClient?.attest?.[0] === false && rte.wrongClient?.read?.ok === false,
    "D client: a different sequencer pin is refused before any connection": rte.signerMismatchRefused === true,
  };
  const failed = Object.entries(required).filter(([, ok]) => !ok).map(([k]) => k);
  return { pass: failed.length === 0, required, failed,
    diagnostic: { chipId: R.final?.identity?.chipId ?? null, operatorIsTheConfiguredCanaryAddress: s.operatorMatchesConfig ?? null,
      offlineFailedChecks: Object.fromEntries(Object.entries(off).map(([k, x]) => [k, x?.failed ?? x?.error ?? null])),
      note: "no-key/no-claim authority is proven by the harness from the launcher's own fw_cfg and host config and the restricted QEMU network" } };
}

async function tlsUp(port, deadline) {
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    const ok = await new Promise((r) => { const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, timeout: 3000 }, () => { s.end(); r(true); });
      s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
    if (ok) return { up: true, tries };
    await sleep(2000);
  }
  return { up: false, tries };
}
const probe = async (url, spki, method) => {
  try {
    const g = await AV.pinnedPost(url, MC.CHAIN_VERIFIER_ROUTE, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] })), { pinSha256: spki, timeoutMs: 20000 });
    let j = null; try { j = JSON.parse(g.body.toString("utf8")); } catch {}
    return { at: new Date().toISOString(), method, status: g.status, error: j?.error ?? null };
  } catch (e) { return { at: new Date().toISOString(), method, status: null, error: String(e.message).slice(0, 200) }; }
};
async function clientRun(url, config, M, collateral, signer) {
  const c = AV.createAttestedVerifier({ replicas: [{ url, config, measurements: [M], minTcb: TCB_FLOORS, crl: "required" }], unsafeSigner: signer, collateral, timeoutMs: 20000 });
  try {
    const attest = await c.attest();
    let read; try { read = { ok: true, result: await c.request("eth_blockNumber", [], 30000) }; } catch (e) { read = { ok: false, error: String(e.message).slice(0, 400) }; }
    const st = c.status();
    return { attest, read, replicaStatus: st.replicas[0]?.status ?? null, reasons: st.replicas[0]?.reasons ?? [] };
  } finally { c.close(); }
}

async function main() {
  const url = arg("url"), out = arg("out"), M = String(arg("measurement", ""));
  if (!/^https:\/\/127\.0\.0\.1:\d{1,5}$/.test(url || "") || !out || !/^[0-9a-f]{96}$/.test(M)) { console.error("usage: see the header (loopback https url, 96-hex measurement, --out)"); process.exit(2); }
  const deadline = Date.now() + 1000 * Number(arg("deadline-sec", 150));
  const config = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(arg("config"), "utf8")));
  const wrongConfig = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(arg("wrong-config"), "utf8")));
  const digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  if (MC.configDigest(wrongConfig) === digest) { console.error("wrong-config equals the owner config"); process.exit(2); }
  const runtime = JSON.parse(fs.readFileSync(arg("expect-runtime"), "utf8"));
  const kds = arg("kds", "on") === "on";
  const R = { url, expected: { measurement: M, configDigest: digest, hostData, runtime }, collateral: { kds }, registryRead: false, attempts: [] };
  R.readiness = await tlsUp(Number(new URL(url).port), deadline);
  if (!R.readiness.up) { R.error = "the control front never accepted a TLS handshake before the deadline"; return finish(R, 1); }
  const nonce = randomBytes(32);
  let ev = null, peerSpki = null;
  try {
    const g = await tlsGet(url, `${MC.EVIDENCE_PATH}?nonce=${nonce.toString("hex")}`, { timeoutMs: 20000 });
    ev = g.status === 200 ? JSON.parse(g.body.toString("utf8")) : null; peerSpki = g.peerSpki;
    const st = ev ? MC.parseStatement(ev.statement) : null;
    R.evidence = { nonce: nonce.toString("hex"), status: g.status, peerSpkiSha256: g.peerSpki ? sha(g.peerSpki) : null, document: ev };
    if (st) R.statementChecks = {
      configDigest: st.configDigest === digest, hostData: st.hostData === hostData, peerIsControlTls: !!g.peerSpki && sha(g.peerSpki) === st.keys.controlTls.spkiSha256,
      runtime: Object.fromEntries(Object.entries(runtime).map(([k, v]) => [k, st.runtime?.[k] === v])),
      noMcpOrPlatformApi: !("mcpSha256" in (st.runtime || {})) && !("platformApiSha256" in (st.runtime || {})),
      noNative: !("native" in st), controlTlsSpkiSha256: st.keys?.controlTls?.spkiSha256 ?? null,
      operatorMatchesConfig: st.identity?.operator === config.identity.operator, mode: st.mode,
    };
  } catch (e) { R.evidence = { nonce: nonce.toString("hex"), error: String(e.message).slice(0, 300) }; }
  const collateral = cachedCollateral({ dir: arg("collateral-dir"), upstream: kds ? httpCollateral() : null });
  // A. the published verifier (no registry); retried only while the guest is still coming up
  let final = null;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    final = await verifyMeasuredControl({ url, expect: { config, measurements: [M], minTcb: TCB_FLOORS, crl: "required" }, collateral, registry: null, timeoutMs: 20000 });
    R.attempts.push({ at: new Date().toISOString(), ms: Date.now() - t0, status: final.status, checks: final.checks, reasons: final.reasons });
    if (!(final.status === "unknown" && (final.checks.evidence === null || final.checks.supervisor === null))) break;
    await sleep(5000);
  }
  R.final = final ? { status: final.status, checks: final.checks, reasons: final.reasons, identity: final.identity } : null;
  R.verdict = hardwareVerdict(final, M);
  R.attestedOutcome = final ? AV.attestedOutcome(final) : null;
  // B. offline: the captured document through the published step 5, then single-byte changes and another nonce
  if (ev && peerSpki) {
    const o = { nonce, peerSpki, measurement: M, hostData, collateral };
    R.offline = { control: await offlineReport(ev, o), reportByte: await offlineReport(tamperReport(ev), o),
      statementByte: await offlineReport(tamperStatement(ev), o), otherNonce: await offlineReport(ev, { ...o, nonce: randomBytes(32) }) };
  }
  // C. live rejections, fresh nonces
  const wm = await verifyMeasuredControl({ url, expect: { config, measurements: [flipHex(M)], minTcb: TCB_FLOORS, crl: "required" }, collateral, registry: null, timeoutMs: 20000 });
  const wc = await verifyMeasuredControl({ url, expect: { config: wrongConfig, measurements: [M], minTcb: TCB_FLOORS, crl: "required" }, collateral, registry: null, timeoutMs: 20000 });
  R.liveRejections = { wrongMeasurement: { status: wm.status, checks: { report: wm.checks.report ?? "absent", config: wm.checks.config }, hardwareMeasurement: wm.checks.hardware?.measurement ?? "absent", reasons: wm.reasons.slice(-3) },
    wrongConfig: { status: wc.status, checks: { config: wc.checks.config ?? "absent" }, reasons: wc.reasons.slice(-2) } };
  // D. route fail-closed while the backend is unready, through the production client and pinned POSTs
  const spki = R.final?.identity?.controlTlsSpkiSha256;
  R.route = { client: await clientRun(url, config, M, collateral, config.chainVerifier.unsafeSigner) };
  R.route.readProbes = [];
  for (let i = 0; i < 3 && spki; i++) { R.route.readProbes.push(await probe(url, spki, "eth_blockNumber")); if (i < 2) await sleep(10000); }
  R.route.writeProbe = spki ? await probe(url, spki, "eth_sendRawTransaction") : null;
  R.route.wrongClient = await clientRun(url, config, flipHex(M), collateral, config.chainVerifier.unsafeSigner);
  try { AV.checkAttestedReplicas([{ url, config, measurements: [M], minTcb: TCB_FLOORS }], { unsafeSigner: "0x" + "11".repeat(20) }); R.route.signerMismatchRefused = false; }
  catch (e) { R.route.signerMismatchRefused = /pins sequencer/.test(e.message); R.route.signerMismatchError = String(e.message).slice(0, 200); }
  R.collateral.stats = collateral.stats; R.collateral.events = collateral.events;
  R.acceptance = acceptance(R);
  return finish(R, R.acceptance.pass ? 0 : 1);
}
function finish(R, code) {
  if (!R.acceptance) R.acceptance = acceptance(R);
  if (code === 0 && !R.acceptance.pass) code = 1;
  fs.writeFileSync(arg("out"), JSON.stringify(R, null, 1), { flag: "wx" });
  fs.writeFileSync(arg("out") + ".acceptance.json", JSON.stringify(R.acceptance, null, 1), { flag: "wx" });
  console.log(JSON.stringify({ acceptance: { pass: R.acceptance.pass, failed: R.acceptance.failed }, readiness: R.readiness ?? null, error: R.error ?? null }, null, 1));
  process.exit(code);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
