// ROOT-ONLY, NOT RUN BY 9d: after the supported direct upload (direct-upload-r3.mjs) VERIFIED the EnclaveDNS 0.1.5 artifact
// on the platform gateway, record that in the local release handoff so the user's remaining two signatures (publish,
// upgrade) can continue. Local files and the local transient user unit only: no CA, no remote probe, no wallet, no chain.
//   node reconcile-upload.mjs [--check]                       read-only: every gate below; prints a report
//   node reconcile-upload.mjs --execute --result-sha <sha256 of direct-r3-result.json>
//   node reconcile-upload.mjs --rollback --written-sha <sha256 this tool wrote> --backup <backup file>
// --execute:
//   1. stop ONLY enclavedns-release-handoff-v2.service (user, transient);
//   2. CAS: upload.json is still the preflight bytes;
//   3. back it up (0600, handoff-reconcile/backups);
//   4. write upload.json = the server's own "uploaded" shape + an honest provenance (fileJournal semantics);
//   5. recreate the SAME transient unit with the same systemd-run properties and argv.
// The unit is ALWAYS recreated after the stop (finally), on the old journal when nothing was written. A problem after
// the write is reported; root restores with --rollback (CAS on the written bytes).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(HERE, "../..");
export const HANDOFF = path.join(W, "enclavedns-stale-20261021/wallet-handoff");
export const R3 = path.join(W, "enclavedns-upload-502-20261021");
export const PLAN_SHA = "bd074a6bd01cff351d666ad0e80bf378c4cac06e895ec2d8830ffe24577cd46f";
export const LOCK_SHA = "9e81ef52e8dddb993e47cd73f3fa0d9b085d7241ff72ecec28a9c0a688448a14";
export const UNIT = "enclavedns-release-handoff-v2.service";
export const ARGV = ["/usr/sbin/node", "serve.mjs", "--approved-plan", `sha256:${PLAN_SHA}`, "--approved-files", `sha256:${LOCK_SHA}`, "--serve"];
const MEMORY_MAX = "268435456";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/** files.lock.json and every file it names, exactly as serve.mjs checks them; the plan file is the approved plan. */
export function checkPins(handoff = HANDOFF) {
  const lockText = fs.readFileSync(path.join(handoff, "files.lock.json"));
  if (sha(lockText) !== LOCK_SHA) refuse("files.lock.json is not the approved lock");
  for (const [f, h] of Object.entries(JSON.parse(lockText).files)) if (sha(fs.readFileSync(path.resolve(handoff, f))) !== h) refuse(`${f} changed since review`);
  if (sha(fs.readFileSync(path.join(handoff, "handoff-plan.json"))) !== PLAN_SHA) refuse("handoff-plan.json is not the approved plan");
}

/** direct-upload-r3's receipts: verified, exactly this artifact and CID, the full DAG, no human wallet, no transaction. */
export function checkProof({ r3 = R3, DNS, dag, bytes, resultSha = null }) {
  const f = (n) => path.join(r3, n);
  if (fs.existsSync(f("direct-r3-unknown.json"))) refuse("direct-r3-unknown.json exists: the r3 outcome is unknown");
  for (const n of ["direct-r3-attempt.json", "direct-r3-upload-accepted.json", "direct-r3-result.json"]) if (!fs.existsSync(f(n))) refuse(`${n} is missing`);
  const raw = fs.readFileSync(f("direct-r3-result.json"));
  if (resultSha !== null && sha(raw) !== resultSha) refuse("direct-r3-result.json is not the reviewed bytes (--result-sha)");
  const a = readJson(f("direct-r3-attempt.json")), acc = readJson(f("direct-r3-upload-accepted.json")), r = JSON.parse(raw);
  const want = [["status", r.status === "verified"], ["cid", r.cid === DNS.expectedCid], ["artifactSha256", r.artifactSha256 === DNS.wasm.sha256],
    ["bytes", r.bytes === bytes.length && a.bytes === bytes.length], ["carSha256", HEX64.test(String(r.carSha256))],
    ["blocks", r.blocks === dag.blocks.length], ["source", r.source === DNS.upload.carUrl(DNS.expectedCid)],
    ["humanWalletUsed false", r.humanWalletUsed === false], ["chainTransactions 0", r.chainTransactions === 0],
    ["attempt artifact/cid", a.artifact === DNS.wasm.sha256 && a.cid === DNS.expectedCid], ["accepted cid", acc.cid === DNS.expectedCid],
    ["verifiedAt after attempt", Date.parse(r.verifiedAt) >= Date.parse(a.at) && Date.parse(acc.at) >= Date.parse(a.at)]];
  const bad = want.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) refuse(`direct-r3 proof does not hold: ${bad.join(", ")}`);
  return { cid: r.cid, carSha256: r.carSha256, blocks: r.blocks, verifiedAt: r.verifiedAt, resultSha256: sha(raw),
           attemptSha256: sha(fs.readFileSync(f("direct-r3-attempt.json"))), uploadOrigin: r.uploadOrigin };
}

/** The handoff journals: the upload not done, no transaction step begun, every journal under the approved plan. */
export function checkJournals(jdir) {
  const up = path.join(jdir, "upload.json");
  if (!fs.existsSync(up)) refuse("journals/upload.json is missing");
  const raw = fs.readFileSync(up), u = JSON.parse(raw);
  if (!["ready", "awaiting-signature"].includes(u.status)) refuse(`the upload journal is ${u.status}, not ready/awaiting-signature`);
  if (u.plan !== PLAN_SHA) refuse("the upload journal belongs to another plan");
  for (const k of ["publish", "upgrade"]) if (fs.existsSync(path.join(jdir, `${k}.json`))) refuse(`journals/${k}.json exists: the transaction workflow already started`);
  const s = path.join(jdir, "session.json");
  if (fs.existsSync(s) && readJson(s).plan && readJson(s).plan !== PLAN_SHA) refuse("the session journal belongs to another plan");
  return { uploadSha256: sha(raw), status: u.status };
}

const systemctl = (run, ...a) => run("systemctl", ["--user", ...a]);
export function unitState(run) {
  const out = systemctl(run, "show", UNIT, "-p", "LoadState", "-p", "ActiveState", "-p", "WorkingDirectory", "-p", "MemoryMax", "-p", "MainPID", "-p", "ExecStart");
  const p = Object.fromEntries(out.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const argv = (/argv\[\]=([^;]*)/.exec(p.ExecStart || "") || [, ""])[1].trim().split(/\s+/).filter(Boolean);
  return { load: p.LoadState, active: p.ActiveState, wd: p.WorkingDirectory, mem: p.MemoryMax, pid: p.MainPID, argv };
}
export function checkUnit(run, handoff = HANDOFF) {
  const u = unitState(run);
  if (u.load !== "loaded" || u.active !== "active") refuse(`${UNIT} is not loaded and active (${u.load}/${u.active})`);
  if (u.wd !== handoff || u.mem !== MEMORY_MAX || JSON.stringify(u.argv) !== JSON.stringify(ARGV)) refuse(`${UNIT} is not the reviewed handoff (directory, memory or command differ)`);
  return u;
}

/** fileJournal's write (lease-enrollment-signing/handoff-server.mjs): temp 0600 + fsync + rename + directory fsync. */
export function writeJournal(file, value) {
  const dir = path.dirname(file), tmp = file + "." + randomBytes(8).toString("hex");
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  return sha(fs.readFileSync(file));
}
/** server.mjs writes {status:"uploaded", cid, carSha256, blocks, verifiedAt, expiry, plan} after its own upload; expiry is
 *  the user's authorization expiry, which this upload never had (null). provenance says how it really happened. */
export const uploadedRecord = (p) => ({ status: "uploaded", cid: p.cid, carSha256: p.carSha256, blocks: p.blocks, verifiedAt: p.verifiedAt, expiry: null,
  provenance: { method: "supported EIP-191 direct upload (direct-upload-r3.mjs), temporary unfunded identity; not the handoff's own signature",
                humanWalletUsed: false, chainTransactions: 0, uploadOrigin: p.uploadOrigin, resultSha256: p.resultSha256, attemptSha256: p.attemptSha256,
                reconciledBy: "handoff-reconcile/reconcile-upload.mjs" },
  plan: PLAN_SHA });

const startArgs = (handoff) => ["--user", `--unit=${UNIT.replace(/\.service$/, "")}`, "-p", `MemoryMax=${MEMORY_MAX}`, `--working-directory=${handoff}`, ...ARGV];

export async function main(argv, { handoff = HANDOFF, r3 = R3, jdir = path.join(HANDOFF, "journals"), out = HERE,
                                   run = (c, a) => execFileSync(c, a, { encoding: "utf8", timeout: 30_000 }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
                                   load = async () => ({ ...(await import(pathToFileURL(path.join(handoff, "trust.mjs")).href)),
                                     ...(await import(pathToFileURL(path.resolve(handoff, "../../site-host-live-publish/handoff/site-upload.mjs")).href)) }) } = {}) {
  const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const mode = argv.includes("--execute") ? "execute" : argv.includes("--rollback") ? "rollback" : "check";
  const report = { mode, at: new Date().toISOString() };
  try {
    if (mode === "rollback") {
      const written = arg("--written-sha"), backup = arg("--backup"), up = path.join(jdir, "upload.json");
      if (!HEX64.test(String(written)) || !backup || !fs.existsSync(backup)) refuse("--written-sha <hex> --backup <file> required");
      if (sha(fs.readFileSync(up)) !== written) refuse("CAS: upload.json is not what this tool wrote; nothing restored");
      checkUnit(run, handoff); systemctl(run, "stop", UNIT);
      report.restoredSha256 = writeJournal(up, readJson(backup));
      run("systemd-run", startArgs(handoff)); await sleep(3000); report.unit = checkUnit(run, handoff).active;
      report.result = "rolled back: the upload journal is the backup again; the handoff restarted"; return { exit: 0, report };
    }
    checkPins(handoff); report.pins = "plan and files lock exact";
    const m = await load(); const { bytes, dag } = m.frozenWasm(m.DNS);
    report.artifact = { sha256: m.DNS.wasm.sha256, cid: m.DNS.expectedCid, bytes: bytes.length, blocks: dag.blocks.length };
    const resultSha = mode === "execute" ? arg("--result-sha") : null;
    if (mode === "execute" && !HEX64.test(String(resultSha))) refuse("--result-sha <sha256 of the reviewed direct-r3-result.json> required");
    const proof = checkProof({ r3, DNS: m.DNS, dag, bytes, resultSha });
    report.proof = { carSha256: proof.carSha256, blocks: proof.blocks, verifiedAt: proof.verifiedAt, resultSha256: proof.resultSha256 };
    const j = checkJournals(jdir); report.journal = j;
    const u = checkUnit(run, handoff); report.unit = { active: u.active, pid: u.pid };
    if (mode === "check") { report.result = "check passed: nothing changed"; return { exit: 0, report }; }

    const up = path.join(jdir, "upload.json"), backups = path.join(out, "backups");
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    const attempt = path.join(out, `attempt-${j.uploadSha256.slice(0, 12)}.json`);
    fs.writeFileSync(attempt, JSON.stringify({ at: report.at, uploadSha256: j.uploadSha256, resultSha256: proof.resultSha256 }) + "\n", { flag: "wx", mode: 0o600 });
    systemctl(run, "stop", UNIT);
    for (let i = 0; i < 30 && unitState(run).active === "active"; i++) await sleep(1000);
    if (unitState(run).active === "active") refuse("the handoff did not stop; nothing written");
    let written = null, backup = null;
    try {
      if (sha(fs.readFileSync(up)) !== j.uploadSha256) refuse("CAS: upload.json changed since the preflight; nothing written");
      checkJournals(jdir);
      backup = path.join(backups, `upload.json.before-reconcile-${j.uploadSha256.slice(0, 12)}`);
      fs.writeFileSync(backup, fs.readFileSync(up), { flag: "wx", mode: 0o600 });
      if (sha(fs.readFileSync(backup)) !== j.uploadSha256) refuse("the backup is not the preflight bytes");
      written = writeJournal(up, uploadedRecord(proof));
      report.written = { uploadSha256: written, backup };
    } finally {
      run("systemd-run", startArgs(handoff));            // always: the handoff comes back, on the old or the new journal
      await sleep(3000);
    }
    const after = checkUnit(run, handoff), now = readJson(up);
    if (now.status !== "uploaded" || sha(fs.readFileSync(up)) !== written) refuse("after the restart the journal is not the written record");
    report.unit = { active: after.active, pid: after.pid };
    report.result = "uploaded recorded; the handoff restarted: its next step is publish (the user reloads 127.0.0.1:39681)";
    return { exit: 0, report };
  } catch (e) {
    report.result = e instanceof Refusal ? "refused" : "failed"; report.why = String(e.message).slice(0, 300);
    return { exit: e instanceof Refusal ? 1 : 3, report };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { exit, report } = await main(process.argv.slice(2));
  const f = path.join(HERE, `receipt-${report.mode}-${report.at.replace(/[:.]/g, "")}.json`);
  fs.writeFileSync(f, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n" + "receipt: " + f + "\n"); process.exit(exit);
}
