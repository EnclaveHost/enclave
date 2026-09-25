#!/usr/bin/env node
// verifier/provenance-parity.mjs: the DAILY consistency check of the release-provenance paths the consumers use, read-only.
//   node verifier/provenance-parity.mjs --out DIR [--mirror URL] [--site URL] [--api-base URL] [--download-base URL] [--browser CHROME] [--now ISO]
// Legs, each verifying for itself (nothing is taken from another leg or from a server's verdict):
//   github   the Node consumer (verifier/consumer.mjs releaseExpectations) against GitHub: the signed index, the pinned root
//   mirror   the browser module from source (verifier/web/provenance.mjs) against the relay's mirror (api.enclave.host)
//   bundle   the SAME call through this commit's browser bundle (site/vendor/enclave-verifier.js)
//   deployed the same call through the bundle the SITE SERVES (enclave.host/vendor/enclave-verifier.js), whose sha256 must
//            be an artifact this repository built (a MANIFEST.json in its history), and --browser: that deployed bundle
//            run by a real Chrome on the live page
// Exit 0 when every leg verified the index and they agree (the same publication and digest, the same allowed releases and
// measurements, the same floor); "mirror-behind" (the relay still serves an older publication than GitHub's) is recorded
// and fails only when GitHub's index is over an hour old, since the relay re-verifies every 15 minutes. Exit 1 on a
// disagreement, a served bundle this repository never built, or a stale mirror; 2 when a leg could not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseExpectations } from "./consumer.mjs";
import { releaseExpectationsFromMirror } from "./web/provenance.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), opt = (n, d = null) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const out = opt("out") || (console.error("provenance-parity: --out DIR required"), process.exit(2));
fs.mkdirSync(out, { recursive: true });
const MIRROR = opt("mirror", "https://api.enclave.host/v1/release-index"), SITE = opt("site", "https://enclave.host").replace(/\/$/, "");
const VENDOR_PATH = "/vendor/enclave-verifier.js", MANIFEST_PATH = "verifier/web/dist/MANIFEST.json";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const report = { at: new Date().toISOString(), mirror: MIRROR, site: SITE, legs: {}, deployed: {}, comparison: {}, verdict: null, reasons: [] };
const finish = (verdict, code) => { report.verdict = verdict; fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify({ verdict, legs: Object.fromEntries(Object.entries(report.legs).map(([k, v]) => [k, v.index?.status ?? v.error ?? null])), deployed: report.deployed.known ?? null })); process.exit(code); };
const summary = (r) => ({ ok: r.ok, index: { status: r.index?.status, authenticity: r.index?.authenticity, freshness: r.index?.freshness, publication: r.index?.publication ? { runId: r.index.publication.runId, attempt: r.index.publication.attempt } : null,
  digest: r.index?.indexSha256 ?? null, generatedAt: r.index?.generatedAt ?? null, floorApplied: r.index?.floorApplied, floorSource: r.index?.floorSource, builtinFloor: r.index?.builtinFloor },
  allowed: (r.allowed || []).map((a) => ({ tag: a.tag, measurement: a.measurement, digest: a.digest })), reasons: (r.reasons || []).slice(-1) });

// the artifacts this repository built: every MANIFEST.json in its history, and the working tree's
function knownArtifacts() {
  const shas = new Map();
  try { shas.set(JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST_PATH), "utf8")).artifact.sha256, "working tree"); } catch {}
  try {
    const commits = execFileSync("git", ["log", "--format=%H", "--", MANIFEST_PATH], { cwd: REPO, encoding: "utf8", maxBuffer: 16 << 20 }).split("\n").filter(Boolean);
    for (const c of commits) { try { const m = JSON.parse(execFileSync("git", ["show", `${c}:${MANIFEST_PATH}`], { cwd: REPO, encoding: "utf8" })); if (!shas.has(m.artifact.sha256)) shas.set(m.artifact.sha256, c); } catch {} }
  } catch (e) { report.reasons.push(`manifest history unreadable: ${e.message}`); }
  return shas;
}

const indexOpts = { ...(opt("api-base") ? { apiBase: opt("api-base") } : {}), ...(opt("download-base") ? { downloadBase: opt("download-base") } : {}) };
try { report.legs.github = summary(await releaseExpectations({ ...indexOpts, timeoutMs: 20000 })); } catch (e) { report.legs.github = { error: e.message }; }
try { report.legs.mirror = summary(await releaseExpectationsFromMirror({ mirrorUrl: MIRROR, timeoutMs: 15000 })); } catch (e) { report.legs.mirror = { error: e.message }; }
try { const B = await import(pathToFileURL(path.join(REPO, "site", "vendor", "enclave-verifier.js")).href); report.legs.bundle = summary(await B.releaseExpectationsFromMirror({ mirrorUrl: MIRROR, timeoutMs: 15000 })); } catch (e) { report.legs.bundle = { error: e.message }; }
// the deployed bundle: its bytes, whether this repository built them, and its own verdict on the mirror
let tmp = null;
try {
  const r = await fetch(SITE + VENDOR_PATH, { signal: AbortSignal.timeout(20000), redirect: "error", cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer()); const known = knownArtifacts(); const s = sha(bytes);
  report.deployed = { url: SITE + VENDOR_PATH, bytes: bytes.length, sha256: s, known: known.has(s) ? (known.get(s) === "working tree" ? "this commit" : `built at ${known.get(s).slice(0, 12)}`) : "UNKNOWN", knownArtifacts: known.size };
  if (known.has(s)) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-")); const f = path.join(tmp, "deployed.mjs"); fs.writeFileSync(f, bytes);
    const D = await import(pathToFileURL(f).href);
    report.legs.deployed = summary(await D.releaseExpectationsFromMirror({ mirrorUrl: MIRROR, timeoutMs: 15000 }));
  } else report.legs.deployed = { error: "the served bundle is not an artifact this repository built: not executed" };
} catch (e) { report.deployed = { url: SITE + VENDOR_PATH, error: e.message }; report.legs.deployed = { error: e.message }; }
finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
// a real browser on the live page, running the deployed bundle (optional: --browser names the executable)
if (opt("browser")) {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: opt("browser"), headless: true });
    try {
      const page = await browser.newPage(); await page.goto(SITE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
      const r = await page.evaluate(async ({ vendor, mirror }) => { const m = await import(vendor); const x = await m.releaseExpectationsFromMirror({ mirrorUrl: mirror, timeoutMs: 15000 }); return JSON.parse(JSON.stringify(x)); }, { vendor: VENDOR_PATH, mirror: MIRROR });
      report.legs.browser = { ...summary(r), userAgent: await page.evaluate(() => navigator.userAgent) };
    } finally { await browser.close(); }
  } catch (e) { report.legs.browser = { error: e.message.split("\n")[0] }; }
}

// the comparison
const legs = Object.entries(report.legs);
const failedLegs = legs.filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
if (report.deployed.known === "UNKNOWN") { report.reasons.push(`the site serves ${VENDOR_PATH} with sha256 ${report.deployed.sha256}, which no MANIFEST.json in this repository's history names`); finish("unknown-artifact", 1); }
if (failedLegs.length) { report.reasons.push(...failedLegs); finish("leg-failed", 2); }
const notVerified = legs.filter(([, v]) => v.index.status !== "verified" || !v.ok).map(([k, v]) => `${k}: index ${v.index.status}, ok ${v.ok}`);
if (notVerified.length) { report.reasons.push(...notVerified); finish("not-verified", 1); }
const pubKey = (v) => `${v.index.publication.runId}/${v.index.publication.attempt}`;
const gh = report.legs.github, mirrorLegs = legs.filter(([k]) => k !== "github");
const samePub = mirrorLegs.every(([, v]) => pubKey(v) === pubKey(gh));
const canon = (v) => JSON.stringify({ digest: v.index.digest, allowed: v.allowed, floor: [v.index.floorApplied, v.index.floorSource, v.index.builtinFloor] });   // every leg reports the index digest it computed
// the mirror legs must agree among themselves on everything; with GitHub's on everything when the publication is the same
const mirrorAgree = mirrorLegs.every(([, v]) => canon(v) === canon(mirrorLegs[0][1]));
report.comparison = { samePublication: samePub, mirrorLegsAgree: mirrorAgree, github: pubKey(gh), mirror: mirrorLegs.map(([k, v]) => [k, pubKey(v)]) };
if (!mirrorAgree) { report.reasons.push("the mirror legs (source, this commit's bundle, the deployed bundle, the browser) disagree on the same bytes"); finish("disagree", 1); }
if (samePub) {
  const githubAgree = canon(gh) === canon(mirrorLegs[0][1]);
  report.comparison.githubAgrees = githubAgree;
  if (!githubAgree) { report.reasons.push("the same publication, verified from GitHub and from the mirror, gives different releases, measurements or floors"); finish("disagree", 1); }
  finish("agree", 0);
}
const nowMs = opt("now") ? Date.parse(opt("now")) : Date.now();   // --now: the clock for the staleness rule (tests)
const ghAgeMin = gh.index.generatedAt ? (nowMs - Date.parse(gh.index.generatedAt)) / 60000 : Infinity;
report.comparison.mirrorBehindMinutes = Math.round(ghAgeMin);
report.reasons.push(`the mirror serves publication ${pubKey(mirrorLegs[0][1])}, GitHub's latest is ${pubKey(gh)} (generated ${Math.round(ghAgeMin)} min ago)`);
finish(ghAgeMin > 60 ? "mirror-stale" : "mirror-behind", ghAgeMin > 60 ? 1 : 0);
