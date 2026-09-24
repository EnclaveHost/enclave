#!/usr/bin/env node
// verifier/cli.mjs: the offline harness from a shell.
//
//   node verifier/cli.mjs verify   --doc rad.json --spki cert.pem|spki.der [--host h --cert cert.pem] [--nonce hex] [--app-id hex]
//                                  [--binding hex] --measurement hex [--measurement hex ...] [--vcek f] [--chain pem] [--crl der]
//                                  [--collateral-dir DIR] [--kds] [--min-tcb json] [--vmpl n] [--crl-mode required|stale-ok|none] [--now iso] [--json]
//   node verifier/cli.mjs release  --bundle attestation.json --digest hex [--trusted-root f] [--min-release v0.5.0] [--json]
//   node verifier/cli.mjs capture  --host h --out DIR            (fetch RAD + certificate + VCEK/chain/CRL from AMD; network)
//   node verifier/cli.mjs differential --doc rad.json --vcek f [--cert-json f --host h]   (runs @tinfoilsh/verifier on the same bytes, if installed)
import fs from "node:fs";
import path from "node:path";
import { verifyEvidence, verifyReleaseAttestation, spkiOfCert, fileCollateral, memoryCollateral, httpCollateral, layeredCollateral, parseReportStrict } from "./index.mjs";
import { snpProductHint, kdsVcekUrl } from "../relay/snp-verify.mjs";

const args = process.argv.slice(2); const cmd = args.shift();
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? (args[i + 1] ?? true) : d; };
const opts = (n) => args.flatMap((a, i) => a === "--" + n ? [args[i + 1]] : []);
const flag = (n) => args.includes("--" + n);
const die = (m) => { console.error(m); process.exit(2); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const HERE = path.dirname(new URL(import.meta.url).pathname), REPO = path.resolve(HERE, "..");
const hexBuf = (s, what) => { if (s === undefined) return undefined; if (!/^[0-9a-f]+$/i.test(s)) die(`--${what} must be hex`); return Buffer.from(s, "hex"); };

async function cmdVerify() {
  const docFile = opt("doc") || die("--doc required");
  let doc = readJson(docFile); if (doc.doc && typeof doc.doc === "object") doc = doc.doc;   // the isolation clients save { doc, spki, nonce }
  const spkiFile = opt("spki") || die("--spki required (the key YOUR connection saw; offline: the served certificate)");
  const spkiRaw = fs.readFileSync(spkiFile);
  const spki = /-----BEGIN CERTIFICATE-----/.test(spkiRaw.toString("latin1")) ? spkiOfCert(spkiRaw.toString("utf8")).spki : spkiRaw;
  const context = { transportKeySpki: spki, host: opt("host"), certPem: opt("cert") ? fs.readFileSync(opt("cert"), "utf8") : undefined,
    nonce: hexBuf(opt("nonce"), "nonce"), expectedAppId: hexBuf(opt("app-id"), "app-id"), expectedBinding: hexBuf(opt("binding"), "binding"), now: opt("now"),
    auxblob: doc.certs ? Buffer.from(doc.certs, "base64") : undefined };
  const layers = [];
  const mem = { chains: {}, vceks: {}, crls: {} };
  const body = Buffer.from(doc.body ?? doc.report, "base64");
  let product = null; try { const raw = body[0] === 0x1f && body[1] === 0x8b ? (await import("node:zlib")).gunzipSync(body) : body; product = snpProductHint(parseReportStrict(raw)); } catch {}
  if (opt("vcek")) mem.vceks[product || "?"] = fs.readFileSync(opt("vcek"));
  if (opt("chain")) mem.chains[product || "?"] = fs.readFileSync(opt("chain"), "utf8");
  if (opt("crl")) mem.crls[product || "?"] = fs.readFileSync(opt("crl"));
  layers.push(memoryCollateral(mem));
  layers.push(fileCollateral(opt("collateral-dir") || path.join(REPO, "test", "fixtures"), {}));
  if (flag("kds")) layers.push(httpCollateral({}));
  const policy = { snp: { allowedMeasurements: opts("measurement"), expectedVmpl: opt("vmpl") !== undefined ? parseInt(opt("vmpl"), 10) : 0, crl: opt("crl-mode") || "required",
    ...(opt("min-tcb") ? { minTcb: JSON.parse(opt("min-tcb")) } : {}), ...(flag("no-cert-binding") ? { requireCertificateBinding: false } : {}) } };
  const v = await verifyEvidence(doc, { policy, context, collateral: layeredCollateral(...layers) });
  if (flag("json")) console.log(JSON.stringify(v, null, 2));
  else { for (const r of v.reasons) console.log(`  ${r.startsWith("REJECT") ? "\x1b[31m✗\x1b[0m" : r.startsWith("WARN") || r.startsWith("UNSUPPORTED") ? "\x1b[33m•\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${r}`); console.log(`\n${v.status.toUpperCase()}  (${v.technology || "?"})`); }
  process.exit(v.status === "verified" ? 0 : v.status === "unsupported" ? 3 : 1);
}

async function cmdRelease() {
  const bundleFile = opt("bundle") || die("--bundle required"), digest = opt("digest") || die("--digest required");
  let bundle = readJson(bundleFile); if (bundle.attestations) bundle = bundle.attestations[0]?.bundle;
  const trustedRoot = readJson(opt("trusted-root") || path.join(REPO, "test", "fixtures", "verifier", "sigstore", "trusted_root.json"));
  const policy = {}; if (opt("min-release")) { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(opt("min-release")) || die("--min-release vX.Y.Z"); policy.minimumRelease = [+m[1], +m[2], +m[3]]; }
  const r = await verifyReleaseAttestation({ bundle, digestHex: digest, trustedRoot, policy });
  if (flag("json")) console.log(JSON.stringify(r, null, 2)); else { for (const x of r.reasons) console.log(`  ${x.startsWith("REJECT") ? "✗" : "✓"} ${x}`); if (r.ok) console.log(`\nRELEASE OK  ${r.claims.tag} (${r.claims.flavor})  snp_measurement ${r.claims.snpMeasurement}`); else console.log("\nRELEASE NOT VERIFIED"); }
  process.exit(r.ok ? 0 : 1);
}

async function cmdCapture() {
  const host = opt("host") || die("--host required"), out = opt("out") || die("--out required");
  fs.mkdirSync(out, { recursive: true });
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const at = new Date().toISOString(), src = {};
  const rad = await get(`https://${host}/.well-known/tinfoil-attestation`); fs.writeFileSync(path.join(out, "rad.json"), rad); src["rad.json"] = { url: `https://${host}/.well-known/tinfoil-attestation`, fetchedAt: at };
  try { const c = await get(`https://${host}/.well-known/tinfoil-certificate`); fs.writeFileSync(path.join(out, "tinfoil-certificate.json"), c); fs.writeFileSync(path.join(out, "tls-cert.pem"), JSON.parse(c.toString()).certificate); src["tinfoil-certificate.json"] = { url: `https://${host}/.well-known/tinfoil-certificate`, fetchedAt: at }; } catch (e) { console.error(`(no certificate endpoint: ${e.message})`); }
  const j = JSON.parse(rad.toString()); let body = Buffer.from(j.body, "base64"); if (body[0] === 0x1f) body = (await import("node:zlib")).gunzipSync(body);
  const p = parseReportStrict(body), product = snpProductHint(p) || die("no product line from the report");
  const kds = httpCollateral({});
  const vurl = kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, "");
  const v = await kds.vcek(product, null, null, vurl); fs.writeFileSync(path.join(out, "vcek-kds-amd.der"), v.der); src["vcek-kds-amd.der"] = { url: v.source, fetchedAt: v.fetchedAt };
  const ch = await kds.chain(product); fs.writeFileSync(path.join(out, `${product}-cert_chain.pem`), ch.pem); src[`${product}-cert_chain.pem`] = { url: ch.source, fetchedAt: ch.fetchedAt };
  const crl = await kds.crl(product); fs.writeFileSync(path.join(out, `${product}-crl.der`), crl.der); src[`${product}-crl.der`] = { url: crl.source, fetchedAt: crl.fetchedAt };
  fs.writeFileSync(path.join(out, "SOURCES.json"), JSON.stringify(src, null, 1));
  console.log(`captured ${host} (${product}, report v${p.version}, measurement ${Buffer.from(p.measurement).toString("hex").slice(0, 16)}...) into ${out}`);
}

async function cmdDifferential() {
  const doc = readJson(opt("doc") || die("--doc required")); const vcek = fs.readFileSync(opt("vcek") || die("--vcek required"));
  let mod; try { mod = await import("@tinfoilsh/verifier"); } catch { die("@tinfoilsh/verifier is not installed"); }
  const out = { library: "@tinfoilsh/verifier" };
  try { out.attestation = await mod.verifyAttestation({ format: doc.format, body: doc.body }, vcek.toString("base64")); out.attestationOk = true; } catch (e) { out.attestationOk = false; out.attestationError = e.message; }
  if (opt("cert-json") && out.attestationOk) { try { const c = readJson(opt("cert-json")).certificate; out.certificate = await mod.verifyCertificate(c, opt("host"), { format: doc.format, body: doc.body }, out.attestation.hpkePublicKey); out.certificateOk = true; } catch (e) { out.certificateOk = false; out.certificateError = e.message; } }
  console.log(JSON.stringify(out, null, 2));
}

({ verify: cmdVerify, release: cmdRelease, capture: cmdCapture, differential: cmdDifferential }[cmd] || (() => die("usage: verifier/cli.mjs verify|release|capture|differential ...")))().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
