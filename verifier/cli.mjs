#!/usr/bin/env node
// verifier/cli.mjs: the offline harness from a shell.
//
//   node verifier/cli.mjs verify   --doc doc.json --spki cert.pem|spki.der [--nonce hex] [--app-id hex]
//                                  [--binding hex] --measurement hex [--measurement hex ...] [--vcek f] [--chain pem] [--crl der]
//                                  [--collateral-dir DIR] [--kds] [--cache-dir DIR] [--min-tcb json] [--vmpl n] [--crl-mode required|stale-ok|none] [--now iso] [--json]
//   --cache-dir DIR: an authenticated, freshness-aware disk cache (verifier/collateral-cache.mjs) in front of the sources
//   above; nothing unauthenticated is stored or served, a stale CRL is refreshed or flagged for the CRL policy, and the
//   verdict's claims.collateral says where each piece came from
//                                  [--admit native|browser --peer-spki cert.pem|spki.der]   (consumer gate; exit 5 = held)
// A live attached box is verified with the CLI (`enclave attest <box>`: verifier/consumer.mjs verifyMetalBox), not here.
import fs from "node:fs";
import path from "node:path";
import { verifyEvidence, spkiOfCert, fileCollateral, memoryCollateral, httpCollateral, layeredCollateral, cachedCollateral, parseReportStrict } from "./index.mjs";
import { snpProductHint } from "../relay/snp-verify.mjs";

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
  const context = { transportKeySpki: spki,
    nonce: hexBuf(opt("nonce"), "nonce"), expectedAppId: hexBuf(opt("app-id"), "app-id"), expectedBinding: hexBuf(opt("binding"), "binding"), now: opt("now"),
    auxblob: doc.certs ? Buffer.from(doc.certs, "base64") : undefined };
  const layers = [];
  const mem = { chains: {}, vceks: {}, crls: {} };
  const body = Buffer.from(doc.body ?? doc.report, "base64");
  let product = null; try { product = snpProductHint(parseReportStrict(body)); } catch {}
  if (opt("vcek")) mem.vceks[product || "?"] = fs.readFileSync(opt("vcek"));
  if (opt("chain")) mem.chains[product || "?"] = fs.readFileSync(opt("chain"), "utf8");
  if (opt("crl")) mem.crls[product || "?"] = fs.readFileSync(opt("crl"));
  layers.push(memoryCollateral(mem));
  layers.push(fileCollateral(opt("collateral-dir") || path.join(REPO, "test", "fixtures"), {}));
  if (flag("kds")) layers.push(httpCollateral({}));
  const policy = { snp: { allowedMeasurements: opts("measurement"), expectedVmpl: opt("vmpl") !== undefined ? parseInt(opt("vmpl"), 10) : 0, crl: opt("crl-mode") || "required",
    ...(opt("min-tcb") ? { minTcb: JSON.parse(opt("min-tcb")) } : {}),
    ...(flag("research-unjudged-versions") ? { researchAllowUnjudgedReportVersions: true } : {}) } };
  const sources = layeredCollateral(...layers);
  const collateral = opt("cache-dir") ? cachedCollateral({ dir: opt("cache-dir"), upstream: sources, now: () => (opt("now") ? new Date(opt("now")) : new Date()) }) : sources;
  const v = await verifyEvidence(doc, { policy, context, collateral });
  // --admit native|browser [--peer-spki f] [--app-id hex] [--roots-from-policy]: the consumer gate on this verdict
  if (opt("admit")) {
    const { admit } = await import("./admission.mjs"); const { AMD_ARK_SHA256 } = await import("../relay/snp-verify.mjs");
    const peer = opt("peer-spki") ? (() => { const raw = fs.readFileSync(opt("peer-spki")); return /-----BEGIN CERTIFICATE-----/.test(raw.toString("latin1")) ? spkiOfCert(raw.toString("utf8")).spki : raw; })() : null;
    const expect = { nonce: context.nonce, appId: context.expectedAppId, allowedMeasurements: opts("measurement"), minTcb: policy.snp.minTcb, roots: Object.fromEntries(AMD_ARK_SHA256) };
    const g = admit(v, expect, { clientKind: opt("admit"), observedPeerSpki: peer });
    if (flag("json")) console.log(JSON.stringify({ verdict: v, admission: g }, null, 2)); else { for (const r of v.reasons) console.log(`  ${r.startsWith("REJECT") ? "✗" : /^(OMITTED|UNSUPPORTED)/.test(r) ? "•" : "✓"} ${r}`); for (const r of g.reasons) console.log(`  ${r.startsWith("HOLD") ? "\x1b[31m⛔\x1b[0m" : "\x1b[32m→\x1b[0m"} ${r}`); }
    process.exit(g.decision === "release" ? 0 : 5);   // 5: held by the consumer gate
  }
  if (flag("json")) console.log(JSON.stringify(v, null, 2));
  else { for (const r of v.reasons) console.log(`  ${r.startsWith("REJECT") ? "\x1b[31m✗\x1b[0m" : /^(OMITTED|UNSUPPORTED)/.test(r) ? "\x1b[33m•\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${r}`);
         console.log(`\n${v.status.toUpperCase()}  (${v.technology || "?"})${v.status === "limited" ? `  omissions: ${v.omissions.join(", ")}  [NOT admission-safe]` : v.status === "verified" ? "  [admission-safe]" : ""}`); }
  // exit codes: 0 verified (admission-safe), 1 rejected, 3 unsupported, 4 limited (policy omitted a check)
  process.exit(v.status === "verified" ? 0 : v.status === "unsupported" ? 3 : v.status === "limited" ? 4 : 1);
}

({ verify: cmdVerify }[cmd] || (() => die("usage: verifier/cli.mjs verify ...")))().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
