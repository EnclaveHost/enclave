#!/usr/bin/env node
// verifier/live-domain-check.mjs: a READ-ONLY live check of a per-app SNP guest (the Linux isolation tier's domain format)
// from the public side, with this verifier: one TLS session to the app's origin, the peer certificate's SPKI from THAT
// handshake, GET /.well-known/enclave-attestation?nonce=<fresh> over the same socket, then verifyEvidence with the owner's
// pinned runtime contract (Bind2, RuntimeID) and explicit expectations. Nothing is written anywhere but the report file.
//   node verifier/live-domain-check.mjs --host 4e62e60d.app.enclave.host --expect test/fixtures/verifier/linux-canary-2026-09-24
//        [--measurement hex] [--app-id hex] [--derive] [--out report.json] [--collateral-dir DIR] [--kds]
// --expect DIR reads expected-runtime.json, min-tcb.json, record.json and vcek.der (a VCEK for the chip: KDS may hold none)
// --derive fetches the component by the record's CID from a public IPFS gateway (bounded) and derives the AppID with the
//          owner's pinned derive_reference.py, so the expected AppID is REPRODUCED rather than stated; without it the
//          --app-id (or the fixture's stated one) is the owner's word and the report says so.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyEvidence, memoryCollateral, fileCollateral, httpCollateral, layeredCollateral } from "./index.mjs";
import { AMD_ARK_SHA256 } from "../relay/snp-verify.mjs";

const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? (args[i + 1] ?? true) : d; }, flag = (n) => args.includes("--" + n);
const die = (m) => { console.error(m); process.exit(2); };
const host = opt("host") || die("--host required"), expectDir = opt("expect") || die("--expect DIR required");
// --deployment 0x<64 hex>: expect the report's HOST_DATA to be this deployment id (the F11 fix; a guest launched before it has zero and is refused)
const deployment = opt("deployment") ? (/^0x[0-9a-f]{64}$/.test(opt("deployment")) ? Buffer.from(opt("deployment").slice(2), "hex") : die("--deployment must be 0x + 64 lowercase hex")) : null;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const contractPath = process.env.ENCLAVE_DOMAIN_CONTRACT || die("ENCLAVE_DOMAIN_CONTRACT must point at the pinned isolation/contract/runtime.mjs (verifier/integration/resolve.mjs --pin linux-domain-contract)");
const C = await import(pathToFileURL(contractPath).href);
const asBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === "string" ? Buffer.from(x, "hex") : Buffer.from(x));
const j = (f) => JSON.parse(fs.readFileSync(path.join(expectDir, f), "utf8"));
const identity = j("expected-runtime.json"), minTcb = j("min-tcb.json"), record = j("record.json");
const readme = fs.existsSync(path.join(expectDir, "README.txt")) ? fs.readFileSync(path.join(expectDir, "README.txt"), "utf8") : "";
const stated = (re) => (re.exec(readme) || [])[1] || null;
const measurement = opt("measurement") || stated(/measurement\s+([0-9a-f]{96})/) || die("no --measurement and none stated in README.txt");
let appId = opt("app-id") || stated(/AppID\s+([0-9a-f]{64})/), appIdSource = opt("app-id") ? "command line" : "the owner's README (stated, not reproduced)";
const report = { host, at: new Date().toISOString(), contract: { path: contractPath, sha256: createHash("sha256").update(fs.readFileSync(contractPath)).digest("hex") }, expectations: { measurement, measurementSource: opt("measurement") ? "command line" : "the owner's README (expected-measurement.sh; release bytes not published)", identity, minTcb } };

// the record's derivation names the rule (enclave-catalog-bundle/1: served wasi:http; /2: a wasi:cli command on ONE http port)
report.expectations.derivation = record.derivation;
if (record.http !== undefined) report.expectations.http = record.http;

// 1. (optional) reproduce the AppID from the component by CID with the owner's pinned reference derivation
if (flag("derive")) {
  const ref = path.join(path.dirname(contractPath), "catalog", "derive_reference.py");
  if (!fs.existsSync(ref)) die(`derive_reference.py is not beside the pinned contract (${ref})`);
  const gateways = ["https://ipfs.enclave.host/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];   // the platform's own gateway first: catalog content is pinned there
  let component = null, from = null;
  for (const g of gateways) {
    try { const r = await fetch(g + record.cid, { signal: AbortSignal.timeout(30000), redirect: "follow" }); if (!r.ok) continue; const b = Buffer.from(await r.arrayBuffer()); if (b.length > 64 << 20) continue; component = b; from = g + record.cid; break; } catch {}
  }
  if (!component) { report.derive = { ok: false, why: "the component could not be fetched from a public gateway" }; }
  else {
    const tmp = fs.mkdtempSync(path.join(REPO, ".verifier-integration", "derive-")); const rec = path.join(tmp, "record.json"), comp = path.join(tmp, "component.wasm"), out = path.join(tmp, "out.bundle");
    fs.writeFileSync(rec, JSON.stringify(record)); fs.writeFileSync(comp, component);
    try {
      const mapping = JSON.parse(execFileSync("python3", [ref, "bundle", rec, comp, out], { encoding: "utf8" }));
      const bundleSha = createHash("sha256").update(fs.readFileSync(out)).digest("hex");
      report.derive = { ok: true, from, componentBytes: component.length, componentSha256: createHash("sha256").update(component).digest("hex"), appId: mapping.appId, bundleSha256: bundleSha, matchesStated: appId ? mapping.appId === appId : null };
      if (mapping.appId !== bundleSha) report.derive.ok = false, report.derive.why = "the reference's appId is not sha256(bundle)";
      appId = mapping.appId; appIdSource = `derived: derive_reference.py on the component fetched by CID from ${from}`;
    } catch (e) { report.derive = { ok: false, why: `derive_reference.py: ${String(e.stderr || e.message).slice(0, 300)}` }; }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}
if (!appId) die("no expected AppID: give --app-id, or --derive, or a README stating it");
report.expectations.appId = appId; report.expectations.appIdSource = appIdSource;

// 2. one TLS session: the peer certificate from THIS handshake, then the document over the same socket
const nonce = randomBytes(32);
const session = await new Promise((resolve, reject) => {
  const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => {
    const cert = sock.getPeerCertificate(true);
    const der = cert && cert.raw ? Buffer.from(cert.raw) : null;   // the peer certificate of THIS handshake, as DER
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); });
    sock.on("end", () => resolve({ der, protocol: sock.getProtocol(), cipher: sock.getCipher(), alpn: sock.alpnProtocol, raw: buf }));
    sock.on("error", reject);
    sock.write(`GET /.well-known/enclave-attestation?nonce=${nonce.toString("hex")} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
  });
  sock.setTimeout(20000, () => { sock.destroy(); reject(new Error("TLS session timed out")); }); sock.on("error", reject);
});
const { spkiOfCert } = await import("./tls-binding.mjs");
const { spki, cert } = spkiOfCert(session.der);
const head = session.raw.indexOf("\r\n\r\n"), status = /^HTTP\/1\.[01] (\d{3})/.exec(session.raw.subarray(0, head).toString())?.[1];
let body = session.raw.subarray(head + 4).toString("utf8");
if (/transfer-encoding:\s*chunked/i.test(session.raw.subarray(0, head).toString())) { let out = "", s = body; for (;;) { const m = /^([0-9a-f]+)\r\n/i.exec(s); if (!m) break; const n = parseInt(m[1], 16); if (!n) break; out += s.substr(m[0].length, n); s = s.slice(m[0].length + n + 2); } body = out; }
// the served LEAF is recorded by serial, issuer and fingerprint as well as by window: a re-issued certificate for the same key
// and name has the same window at day granularity (the owner's 8ed6231f finding), and only the serial or fingerprint shows it
report.session = { protocol: session.protocol, alpn: session.alpn, servedCertSubject: cert.subject, servedCertIssuer: cert.issuer, servedCertSerial: String(cert.serialNumber || "").toLowerCase(), servedCertSha256: Buffer.isBuffer(cert.raw) ? createHash("sha256").update(cert.raw).digest("hex") : null,
  servedCertValid: [cert.validFrom, cert.validTo], servedSpkiSha256: createHash("sha256").update(spki).digest("hex"), httpStatus: status, bodyBytes: Buffer.byteLength(body) };
if (status !== "200") { report.verdict = { status: "rejected", reasons: [`REJECT: the endpoint answered HTTP ${status}`] }; done(); }
let doc; try { doc = JSON.parse(body); } catch (e) { report.verdict = { status: "rejected", reasons: [`REJECT: the document is not JSON: ${e.message}`] }; done(); }
// --save DIR: keep THIS session's raw capture (the document as served, the nonce, the peer certificate of the handshake as PEM)
// so the exchange can be re-judged offline as a fixture; nothing else is written there
if (opt("save")) {
  const dir = opt("save"); fs.mkdirSync(dir, { recursive: true });
  const pem = "-----BEGIN CERTIFICATE-----\n" + session.der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n?$/, "\n") + "-----END CERTIFICATE-----\n";
  fs.writeFileSync(path.join(dir, "prod-doc.json"), JSON.stringify({ host, at: report.at, nonce: nonce.toString("hex"), doc, servedCertSha256: report.session.servedCertSha256 }, null, 1) + "\n");
  fs.writeFileSync(path.join(dir, "served-cert.pem"), pem);
  report.saved = dir;
}
report.document = { keys: Object.keys(doc).sort(), format: doc.format, abi: doc.abi, tier: doc.tier, nonceEchoed: doc.nonce === nonce.toString("hex"), transportKeyIsServedSpki: Buffer.from(String(doc.transportKey || ""), "base64").equals(spki), runtime: doc.runtime, runtimeSelfTest: doc.runtimeSelfTest, hasCerts: "certs" in doc };

// 3. the verdict: the served SPKI (this handshake), the fresh nonce, Bind2 from the pinned contract, the explicit expectations
const rid = asBuf(C.runtimeId(identity)), bind = asBuf(C.bind2(spki, nonce, rid));
const layers = [memoryCollateral({ chains: { Turin: fs.readFileSync(path.join(REPO, "test/fixtures/amd/Turin-cert_chain.pem"), "utf8"), Genoa: fs.readFileSync(path.join(REPO, "test/fixtures/amd/Genoa-cert_chain.pem"), "utf8"), Milan: fs.readFileSync(path.join(REPO, "test/fixtures/amd/Milan-cert_chain.pem"), "utf8") } })];
if (flag("kds")) layers.push(httpCollateral({}));
if (fs.existsSync(path.join(expectDir, "vcek.der"))) layers.push(memoryCollateral({ vceks: { Turin: fs.readFileSync(path.join(expectDir, "vcek.der")) } }));
if (opt("collateral-dir")) layers.push(fileCollateral(opt("collateral-dir")));
layers.push(fileCollateral(path.join(REPO, "test/fixtures")));   // the CRL fixtures under verifier/amd are not at this layout; --kds fetches a fresh one
const crlDir = path.join(REPO, "test/fixtures/verifier/amd"); if (fs.existsSync(crlDir)) layers.push(memoryCollateral({ crls: { Turin: fs.readFileSync(path.join(crlDir, "Turin-crl.der")) } }));
const v = await verifyEvidence(doc, { policy: { snp: { allowedMeasurements: [measurement], minTcb } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind, expectedAppId: Buffer.from(appId, "hex"), ...(deployment ? { expectedHostData: deployment } : {}), auxblob: doc.certs ? Buffer.from(doc.certs, "base64") : undefined, now: new Date().toISOString() }, collateral: layeredCollateral(...layers) });
if (v.claims) report.hostData = { reported: v.claims.hostData, expected: deployment ? deployment.toString("hex") : null };
report.verdict = v; report.roots = "pinned: relay/snp-verify.mjs AMD_ARK_SHA256"; report.binding = { runtimeId: rid.toString("hex"), bind2: bind.toString("hex") };
done();
function done() {
  const out = opt("out"); if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
  console.log(`live domain check: ${host} at ${report.at}`);
  if (report.session) console.log(`  session: ${report.session.protocol} ${report.session.alpn || "-"}; served cert ${JSON.stringify(report.session.servedCertSubject)} serial ${report.session.servedCertSerial} by ${JSON.stringify((report.session.servedCertIssuer || {}).CN || report.session.servedCertIssuer)} ${report.session.servedCertValid.join(" .. ")} (leaf sha256 ${String(report.session.servedCertSha256).slice(0, 16)}…); SPKI sha256 ${report.session.servedSpkiSha256}`);
  if (report.document) console.log(`  document: keys ${report.document.keys.join(",")}; nonce echoed ${report.document.nonceEchoed}; transportKey == served SPKI ${report.document.transportKeyIsServedSpki}; certs ${report.document.hasCerts}`);
  if (report.derive) console.log(`  derive: ${JSON.stringify(report.derive)}`);
  console.log(`  expectations: measurement ${measurement.slice(0, 16)}… (${report.expectations.measurementSource}); AppID ${String(appId).slice(0, 16)}… (${appIdSource})`);
  for (const r of report.verdict.reasons || []) console.log(`  ${r.startsWith("REJECT") ? "✗" : /^(OMITTED|UNSUPPORTED)/.test(r) ? "•" : "✓"} ${r}`);
  console.log(`  VERDICT ${String(report.verdict.status).toUpperCase()}${report.verdict.omissions?.length ? ` omissions: ${report.verdict.omissions.join(", ")}` : ""}`);
  process.exit(report.verdict.status === "verified" ? 0 : report.verdict.status === "limited" ? 4 : 1);
}
