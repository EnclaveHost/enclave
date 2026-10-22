// verify-canary.mjs: the canary's host-side check of the booted direct-control guest, with the PUBLISHED verifier only
// (tree = git archive of 493ee9ee): metal/measured-control-verify.mjs verifyMeasuredControl, verifier/collateral-cache.mjs
// over verifier/collateral.mjs, verifier/metal-box.mjs TCB_FLOORS, metal/guest/platform-api-verify.mjs quorumRegistry.
// Nothing synthetic: the evidence is the guest's own answer for a FRESH nonce; the collateral is AMD's (an authenticated
// cache COPY, optionally refreshed from AMD KDS); there is no fake registry - without a reader the wrapper honestly stays
// "pending", and with one it reads the original EnclaveRegistry read-only (no key, nothing sent).
//   node canary/verify-canary.mjs --url https://127.0.0.1:P --config owner-config.json --measurement <96 hex>
//        --expect-runtime runtime.json --collateral-dir DIR [--kds on|off] [--registry on|off] [--deadline-sec N] --out result.json
// Exit 0 ONLY when acceptance() passes: every REQUIRED check below (the published verifier's statement, config/HOST_DATA,
// TLS key, AMD report with the expected measurement and running supervisor keys, PLUS the exact-runtime and bare-role
// statement checks of the archived evidence). The registry (expected "pending": the canary URL is not registered) and
// the configured operator address are DIAGNOSTIC: reported, never required, never faked.
// Adapted 2026-10-22 from the root-reviewed direct-hardware-canary/canary/verify-canary.mjs (67979154) for the 493ee9ee image,
// whose statement may carry a `native` member (bound nativeControl): one REQUIRED bare-role check added (no `native` member),
// and the verifier's new identity.chipId (493ee9ee) is reported as a diagnostic. Nothing else changed.
import fs from "node:fs";
import tls from "node:tls";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tree");
const imp = (p) => import(path.join(TREE, p));
const { verifyMeasuredControl, tlsGet } = await imp("metal/measured-control-verify.mjs");
const MC = await imp("metal/guest/measured-control.mjs");
const { cachedCollateral } = await imp("verifier/collateral-cache.mjs");
const { httpCollateral } = await imp("verifier/collateral.mjs");
const { TCB_FLOORS } = await imp("verifier/metal-box.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// verifyMeasuredControl sets checks[name] = true on each pass, in order: statement, config, endpoint key, report, supervisor,
// registry (metal/measured-control-verify.mjs:76-157). The HARDWARE result is the first five; the registry is separate.
export function hardwareVerdict(final, expectedMeasurement) {
  const c = final?.checks || {};
  const parts = { statement: c.statement === true, config: c.config === true, endpointKey: c["endpoint key"] === true,
    report: c.report === true && final?.identity?.measurement === expectedMeasurement, supervisor: c.supervisor === true };
  const registry = c.registry === true ? "verified" : c.registry === false ? "rejected"
    : final?.status === "pending" ? "pending" : final?.status === "unknown" && c.supervisor === true ? "unknown (registry quorum)" : "not reached";
  return { hardwarePass: Object.values(parts).every(Boolean), parts, registry, wrapperStatus: final?.status ?? null };
}

/** acceptance(R) -> { pass, required: {name: bool}, failed: [names], diagnostic: {...} }. Every promised check is either
 *  REQUIRED here (and gates exit 0 and the harness) or explicitly diagnostic; nothing computed is silently ignored. */
export function acceptance(R) {
  const v = R.verdict || hardwareVerdict(null, R.expected?.measurement), s = R.statementChecks || {}, rt = s.runtime || {};
  const expectedRuntime = Object.keys(R.expected?.runtime || {});
  const required = {
    "verifier: statement": v.parts?.statement === true, "verifier: config + HOST_DATA": v.parts?.config === true,
    "verifier: TLS peer = attested control key": v.parts?.endpointKey === true,
    "verifier: AMD report verified with the expected measurement": v.parts?.report === true,
    "verifier: running supervisor holds the minted keys": v.parts?.supervisor === true,
    "evidence: HTTP 200": R.evidence?.status === 200,
    "evidence: statement config digest = owner config": s.configDigest === true, "evidence: statement HOST_DATA = owner config": s.hostData === true,
    "evidence: TLS peer = statement control key": s.peerIsControlTls === true,
    "evidence: same boot as the verifier (control key)": s.controlTlsSpkiSha256 != null && s.controlTlsSpkiSha256 === R.final?.identity?.controlTlsSpkiSha256,
    "evidence: mode snp": s.mode === "snp",
    "evidence: runtime gsup/helper/supervisor = the built image inputs": expectedRuntime.length === 3 && expectedRuntime.every((k) => rt[k] === true),
    "evidence: bare roles (no mcpSha256, no platformApiSha256)": s.noMcpOrPlatformApi === true,
    "evidence: bare roles (no native control names in the statement)": s.noNative === true,
  };
  const failed = Object.entries(required).filter(([, ok]) => !ok).map(([k]) => k);
  return { pass: failed.length === 0, required, failed,
    diagnostic: { registry: v.registry, wrapperStatus: v.wrapperStatus, operatorIsTheConfiguredCanaryAddress: s.operatorMatchesConfig ?? null,
      chipId: R.final?.identity?.chipId ?? null,
      note: "no-key/no-claim authority is proven by the harness from the launcher's own fw_cfg and host config (registryKey empty, no registryKeyFile) and the restricted QEMU network, not by this label" } };
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

async function main() {
  const url = arg("url"), out = arg("out"), M = String(arg("measurement", ""));
  if (!/^https:\/\/127\.0\.0\.1:\d{1,5}$/.test(url || "") || !out || !/^[0-9a-f]{96}$/.test(M)) { console.error("usage: see the header (loopback https url, 96-hex measurement, --out)"); process.exit(2); }
  const deadline = Date.now() + 1000 * Number(arg("deadline-sec", 150));
  const config = MC.canonicalDirectConfig(JSON.parse(fs.readFileSync(arg("config"), "utf8")));
  const digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const runtime = JSON.parse(fs.readFileSync(arg("expect-runtime"), "utf8"));
  const kds = arg("kds", "on") === "on", wantRegistry = arg("registry", "on") === "on";
  const R = { url, expected: { measurement: M, configDigest: digest, hostData, runtime }, collateral: { kds }, registryRead: wantRegistry, attempts: [] };
  // 1. readiness: the attested TLS front accepts a handshake (no request, no report)
  R.readiness = await tlsUp(Number(new URL(url).port), deadline);
  if (!R.readiness.up) { R.error = "the control front never accepted a TLS handshake before the deadline"; return finish(R, 1); }
  // 2. one raw evidence document for root's offline re-verification (public: statement, report, certs) + its own checks
  const nonce = randomBytes(32);
  try {
    const g = await tlsGet(url, `${MC.EVIDENCE_PATH}?nonce=${nonce.toString("hex")}`, { timeoutMs: 20000 });
    const ev = g.status === 200 ? JSON.parse(g.body.toString("utf8")) : null;
    const st = ev ? MC.parseStatement(ev.statement) : null;
    R.evidence = { nonce: nonce.toString("hex"), status: g.status, peerSpkiSha256: g.peerSpki ? sha(g.peerSpki) : null, document: ev };
    if (st) R.statementChecks = {
      configDigest: st.configDigest === digest, hostData: st.hostData === hostData, peerIsControlTls: !!g.peerSpki && sha(g.peerSpki) === st.keys.controlTls.spkiSha256,
      runtime: Object.fromEntries(Object.entries(runtime).map(([k, v]) => [k, st.runtime?.[k] === v])),
      noMcpOrPlatformApi: !("mcpSha256" in (st.runtime || {})) && !("platformApiSha256" in (st.runtime || {})),
      noNative: !("native" in st),
      controlTlsSpkiSha256: st.keys?.controlTls?.spkiSha256 ?? null,
      operatorMatchesConfig: st.identity?.operator === config.identity.operator, mode: st.mode,
    };
  } catch (e) { R.evidence = { nonce: nonce.toString("hex"), error: String(e.message).slice(0, 300) }; }
  // 3. collateral: a COPY of the existing public AMD cache, authenticated per entry; AMD KDS only when allowed
  const collateral = cachedCollateral({ dir: arg("collateral-dir"), upstream: kds ? httpCollateral() : null });
  // 4. the registry: the bound quorum, read-only (no key exists; nothing is signed or sent)
  let registry = null;
  if (wantRegistry) { const { quorumRegistry } = await imp("metal/guest/platform-api-verify.mjs"); registry = quorumRegistry({ rpcs: config.rpcs, quorum: config.quorum, registry: config.contracts.registry }); }
  // 5. the published verifier; retried only while the guest is still coming up (evidence/supervisor UNKNOWN)
  let final = null;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    final = await verifyMeasuredControl({ url, expect: { config, measurements: [M], minTcb: TCB_FLOORS, crl: "required" }, collateral, registry, timeoutMs: 20000 });
    R.attempts.push({ at: new Date().toISOString(), ms: Date.now() - t0, status: final.status, checks: final.checks, reasons: final.reasons });
    const retry = final.status === "unknown" && (final.checks.evidence === null || final.checks.supervisor === null);
    if (!retry) break;
    await sleep(5000);
  }
  R.final = final ? { status: final.status, checks: final.checks, reasons: final.reasons, identity: final.identity } : null;
  R.collateral.stats = collateral.stats; R.collateral.events = collateral.events;
  R.verdict = hardwareVerdict(final, M);
  R.acceptance = acceptance(R);
  return finish(R, R.acceptance.pass ? 0 : 1);
}
function finish(R, code) {
  if (!R.acceptance) R.acceptance = acceptance(R);
  if (code === 0 && !R.acceptance.pass) code = 1;
  fs.writeFileSync(arg("out"), JSON.stringify(R, null, 1), { flag: "wx" });
  fs.writeFileSync(arg("out") + ".acceptance.json", JSON.stringify(R.acceptance, null, 1), { flag: "wx" });
  console.log(JSON.stringify({ acceptance: { pass: R.acceptance.pass, failed: R.acceptance.failed, diagnostic: R.acceptance.diagnostic }, readiness: R.readiness ?? null, error: R.error ?? null }, null, 1));
  process.exit(code);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
