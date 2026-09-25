// Lab validation of the relay's measurement predictor (relay/measurement-predict.mjs) against REAL M4a guests.
// Everything a verdict rests on is re-derived here, never taken from guestd:
//   - each canary report's AMD signature: VCEK from AMD KDS -> ASK -> the pinned ARK (relay/snp-verify.mjs primitives);
//   - the deployment it serves: HOST_DATA in that signed report;
//   - the catalog version it must run: that deployment's appRef, read from the ledger contract on Base;
//   - the expected guest: the predictor, run with the REAL toolchain (a git commit), the chain, a third-party trustless
//     gateway and pinned domain releases.
// Then the refusals: a changed release file, a changed runtime, another app's bundle, and an unavailable prediction.
//   usage: node validate.mjs --repo <git repo holding --commit> --commit <40 hex> --release <id>=<dir> [...]
//                            --admit <id>,<id> --sev-snp-measure <exe> --work <dir> [--gateway <https url>]
import fs from "node:fs";
import path from "node:path";
import { createHash, createVerify, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, fallback } from "viem";
import { base } from "viem/chains";
import { makePredictor, catalogReader, runtimeIdOfJson, KNOWN_ANSWERS } from "../../../relay/measurement-predict.mjs";
import { parseSnpReport, snpProductHint, kdsVcekUrl, certChain, vcekMatchesReport } from "../../../relay/snp-verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const REPO = opt("--repo"), COMMIT = opt("--commit"), SSM = opt("--sev-snp-measure"), WORK = path.resolve(opt("--work"));
const GATEWAY = opt("--gateway") || "https://trustless-gateway.link";
const RELEASES = all("--release").map((s) => { const i = s.indexOf("="); return { id: s.slice(0, i), dir: path.resolve(s.slice(i + 1)) }; });
const ADMIT = String(opt("--admit") || "").split(",").filter(Boolean);
const fails = []; const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const note = (s) => console.log("     " + s);
const hex = (b) => Buffer.from(b).toString("hex");

const pub = createPublicClient({ chain: base, transport: fallback(["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"].map((u) => http(u))) });
const BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const bookKey = (n) => "0x" + Buffer.from(n, "ascii").toString("hex").padEnd(64, "0");
const book = (n) => pub.readContract({ address: BOOK, abi: [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }], functionName: "addr", args: [bookKey(n)] });
const DEP = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"], ["gpuMilli", "uint16"], ["cpuMilli", "uint16"],
  ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"], ["rate", "uint256"], ["balance6", "uint256"], ["spent6", "uint256"],
  ["runner", "bytes32"], ["runnerOperator", "address"], ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));
const catalogAddr = await book("appCatalog"), depAddr = await book("deployments");
const appRefOf = async (id) => (await pub.readContract({ address: depAddr, abi: [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: DEP }] }], functionName: "get", args: [id] })).appRef;
const readCatalog = catalogReader(pub, catalogAddr);
console.log(`chain: appCatalog ${catalogAddr}, deployments ${depAddr} (address book ${BOOK}); gateway ${GATEWAY}; toolchain ${COMMIT}`);

// the AMD chain of one report, from KDS, to the pinned ARK: this is what makes a report "real"
async function amdVerified(report) {
  const p = parseSnpReport(report), product = snpProductHint(p);
  if (!product) return "the report names no product line";
  const vcek = new X509Certificate(Buffer.from(await (await fetch(kdsVcekUrl(product, p))).arrayBuffer()));
  const [ask, ark] = await certChain(product);
  if (!vcek.verify(ask.publicKey) || !ask.verify(ark.publicKey)) return "the VCEK does not chain to the pinned ARK";
  const r = Buffer.from(p.signature.subarray(0, 48)).reverse(), s = Buffer.from(p.signature.subarray(0x48, 0x48 + 48)).reverse();
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const R = int(r), S = int(s), seq = Buffer.concat([Buffer.from([2, R.length]), R, Buffer.from([2, S.length]), S]);
  const v = createVerify("sha384"); v.update(p.signedRegion); v.end();
  if (!v.verify({ key: vcek.publicKey, dsaEncoding: "der" }, Buffer.concat([Buffer.from([0x30, seq.length]), seq]))) return "the VCEK signature does not verify";
  return vcekMatchesReport(vcek.raw, product, p) || null;
}

const mk = (over = {}) => makePredictor({ repo: REPO, commit: COMMIT, releases: RELEASES, admit: ADMIT, readCatalog, gateway: GATEWAY,
  sevSnpMeasure: SSM, components: path.join(WORK, "components"), ...over, work: path.join(WORK, over.work || "main") });
const P = mk();
const guests = JSON.parse(fs.readFileSync(path.join(here, "evidence/guests.json"), "utf8"));
const seen = new Map();   // appRef -> { prediction, guests }
console.log("\n== the canaries: prediction vs chip-signed reports");
for (const [g, meta] of Object.entries(guests)) {
  const doc = JSON.parse(fs.readFileSync(path.join(here, `evidence/${g}.doc.json`), "utf8")).doc;
  const report = Buffer.from(doc.report, "base64"), p = parseSnpReport(report);
  const amd = await amdVerified(report);
  expect(!amd, `${g}: the report is AMD-signed (VCEK from KDS -> ASK -> pinned ARK; chip and TCB match)${amd ? ": " + amd : ""}`);
  const hostData = hex(report.subarray(0xc0, 0xe0));
  expect("0x" + hostData === meta.deployment.toLowerCase(), `${g}: HOST_DATA in the signed report is deployment 0x${hostData.slice(0, 8)}…`);
  const appRef = await appRefOf("0x" + hostData);
  note(`the ledger says deployment 0x${hostData.slice(0, 8)}… runs ${appRef}`);
  const t0 = Date.now(), e = await P.expectedFor(appRef), ms = Date.now() - t0;
  expect(e.ok === true, `${g}: a prediction for ${appRef} (${ms} ms${seen.has(appRef) ? ", cached" : ""})${e.ok ? "" : ": " + e.code + " " + e.reason}`);
  if (!e.ok) continue;
  seen.set(appRef, e);
  const m = hex(p.measurement), img = e.images.find((i) => i.measurement === m);
  expect(!!img, `${g}: the report's measurement ${m.slice(0, 16)}… is the prediction for an admitted release${img ? ` (release ${img.release.slice(0, 12)}…)` : ""}`);
  expect(hex(p.reportData.subarray(32, 64)) === e.appId, `${g}: report_data[32:64] is the predicted AppID ${e.appId.slice(0, 16)}…`);
  const rid = runtimeIdOfJson(JSON.stringify(doc.runtime));
  expect(!!img && img.runtimeId === rid, `${g}: the runtime the guest states (${rid.slice(0, 12)}…) is that release's runtime`);
}
const hot = Date.now(); for (const ref of seen.keys()) await P.expectedFor(ref);
note(`cached re-predictions of ${seen.size} version(s): ${Date.now() - hot} ms; state ${JSON.stringify(P.state())}`);

console.log("\n== refusals");
const cp = (src, name) => { const d = path.join(WORK, name); fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(src, d, { recursive: true }); return d; };
const [refA] = seen.keys(), refs = [...seen.keys()];
const relOf = (id) => RELEASES.find((r) => r.id === id).dir;
const kat1 = KNOWN_ANSWERS.filter((k) => k.release === ADMIT[1]);   // the tamper cases keep a known answer on the OTHER release
// (a) a changed release file, pinned by the reviewed id
{
  const d = cp(relOf(ADMIT[0]), "tampered-front"), f = path.join(d, "template/front"), b = fs.readFileSync(f); b[b.length >> 1] ^= 1; fs.writeFileSync(f, b);
  const q = mk({ work: "t-front", releases: [{ id: ADMIT[0], dir: d }, { id: ADMIT[1], dir: relOf(ADMIT[1]) }], admit: [ADMIT[0]], knownAnswers: kat1 });
  const r = await q.expectedFor(refA);
  expect(!r.ok && r.code === "prediction_failed", `one flipped byte in template/front under release ${ADMIT[0].slice(0, 12)}…: refused (${r.code}: ${String(r.reason).slice(0, 110)})`);
}
// (b) a changed runtime: pinned by the old id it is refused; re-manifested it is ANOTHER release, whose images no real guest runs
{
  const d = cp(relOf(ADMIT[0]), "tampered-runtime"), f = path.join(d, "template/rt/runtime.json");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"48.0.1"', '"48.0.2"'));
  const q = mk({ work: "t-rt", releases: [{ id: ADMIT[0], dir: d }, { id: ADMIT[1], dir: relOf(ADMIT[1]) }], admit: [ADMIT[0]], knownAnswers: kat1 });
  const r = await q.expectedFor(refA);
  expect(!r.ok && r.code === "prediction_failed", `runtime.json changed under release ${ADMIT[0].slice(0, 12)}…: refused (${r.code}: ${String(r.reason).slice(0, 110)})`);
  const { execFileSync } = await import("node:child_process");
  const tc = P.state().toolchain, cmdline = JSON.parse(fs.readFileSync(path.join(d, "release.json"), "utf8")).cmdline;
  fs.rmSync(path.join(d, "release.json"));   // a release is written once: this is a NEW release of the changed tree
  const newId = execFileSync("python3", [path.join(tc, "isolation/m4/release-manifest.py"), "write", d, "--cmdline", cmdline], { encoding: "utf8" }).trim().split(" ")[1];
  const q2 = mk({ work: "t-rt2", releases: [{ id: newId, dir: d }, { id: ADMIT[1], dir: relOf(ADMIT[1]) }], admit: [newId], knownAnswers: kat1 });
  const r2 = await q2.expectedFor(refA);
  const real = [...seen.values()].flatMap((e) => e.images.map((i) => i.measurement));
  expect(r2.ok && r2.images.every((i) => !real.includes(i.measurement) && i.runtimeId !== seen.get(refA).images[0].runtimeId),
    `the same change re-manifested is release ${String(newId).slice(0, 12)}…: its prediction (${r2.ok ? r2.images[0].measurement.slice(0, 12) + "…" : r2.code}) is no real guest's measurement and names another runtime, so it must be ADMITTED to count`);
}
// (c) another bundle: each canary against the OTHER version's prediction; and guestd's stale /1 record is never predicted
if (refs.length >= 2) {
  const [x, y] = refs.map((r) => seen.get(r));
  expect(x.appId !== y.appId && !x.images.some((i) => y.images.some((j) => j.measurement === i.measurement)), "two catalog versions: disjoint AppIDs and measurements (a guest of one never passes for the other)");
}
expect(![...seen.values()].some((e) => e.appId === "9add8960b2cf2a2480df3b93eb2733cda1dbe493e06092594b1437b9951dcb5c"),
  "guestd's stale enclave-catalog-bundle/1 record for the http:8000 version (AppID 9add8960…) is never what the chain derives");
// (d) an unavailable prediction
for (const [label, over, code] of [
  ["sev-snp-measure missing", { work: "u-ssm", sevSnpMeasure: path.join(WORK, "no-such-sev-snp-measure") }, "prediction_unavailable"],
  ["the gateway unreachable (the first known-answer test is inconclusive, never a pass)", { work: "u-gw", gateway: "https://127.0.0.1:9", components: path.join(WORK, "u-gw-none") }, "prediction_unavailable"],
  ["a toolchain commit the repository does not hold", { work: "u-commit", commit: "0".repeat(40) }, "prediction_unavailable"],
  ["no admitted release", { work: "u-admit", admit: [] }, "predictor_unconfigured"],
]) {
  const r = await mk(over).expectedFor(refA);
  expect(!r.ok && r.code === code, `${label}: refused (${r.code}: ${String(r.reason).slice(0, 110)})`);
}
// (e) bounds: one reconstruction at a time; a full queue is "busy", never a guess
{
  const q = mk({ work: "b-busy", maxQueue: 0 });
  await q.selfTest();
  const first = q.expectedFor(refs[0]); await new Promise((r) => setTimeout(r, 300));
  const second = await q.expectedFor(refs[1] || refs[0].replace(/\/(\d+)$/, (_, n) => "/" + (Number(n) + 1)));
  expect(second.ok === false && second.code === "busy", `a second version while one reconstructs (concurrency 1, queue 0): ${second.code}`);
  expect((await first).ok === true, "the first completes");
}
console.log(fails.length ? `\nFAIL ${fails.length}` : "\nPASS measurement prediction lab validation");
process.exit(fails.length ? 1 : 0);
