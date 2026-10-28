#!/usr/bin/env node
// Root-only COLD wiring for the metal0 C9 maintenance. Profile "cold" only. NEVER reads a key in this revision:
//   check  PLAN APPROVAL APPROVAL_SHA256 PRIVATE_JOURNAL --stop-receipt-sha256 HEX --guestd-root DIR   read-only gates, exit 0 if all pass
//   run    PLAN APPROVAL APPROVAL_SHA256 PRIVATE_JOURNAL --stop-receipt-sha256 HEX --guestd-root DIR   the same gates, then REFUSES:
//          no sponsor quiescence guard exists (the sponsor's key is used by the live enclave-custodian-v2.service), so no signer is built
//   resume PLAN PRIVATE_JOURNAL [--rebroadcast] --stop-receipt-sha256 HEX --guestd-root DIR           never signs; host gate first;
//          observation only (--rebroadcast also needs the sponsor guard, so it refuses in this revision)
// The approval file is root's existing, human-approved file: this tool never writes or completes one.
// Never stops, freezes or suspends any unit, cgroup or VM.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PRODUCTION, sha256, Refusal } from "../lib/maintenance.mjs";
import { createSender, checkExecutablePlan, checkApproval, journalStore } from "../lib/sender.mjs";
import { COLD_HOST, SHOW_PROPERTIES, evaluateColdHost, authorizeKeyAccess } from "../lib/cold-host-gate.mjs";

const PROFILE = "cold";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: cold-send.mjs check|run PLAN APPROVAL APPROVAL_SHA256 PRIVATE_JOURNAL --stop-receipt-sha256 HEX --guestd-root DIR\n"
  + "       cold-send.mjs resume PLAN PRIVATE_JOURNAL [--rebroadcast] --stop-receipt-sha256 HEX --guestd-root DIR";
const usage = () => { const e = Error("usage"); e.code = "usage"; throw e; };

function parseArgs(argv) {
  const [mode, ...rest] = argv, pos = [], flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--rebroadcast") { if (flags.rebroadcast) usage(); flags.rebroadcast = true; }
    else if (a === "--stop-receipt-sha256" || a === "--guestd-root") { if (flags[a] !== undefined || i + 1 >= rest.length) usage(); flags[a] = rest[++i]; }
    else if (a.startsWith("--")) usage();
    else pos.push(a);
  }
  if (!flags["--stop-receipt-sha256"] || !flags["--guestd-root"]) usage();
  if (["check", "run"].includes(mode) ? pos.length !== 4 || flags.rebroadcast : mode !== "resume" || pos.length !== 2) usage();
  return { mode, pos, rebroadcast: !!flags.rebroadcast, stopReceiptSha256: flags["--stop-receipt-sha256"], guestdRoot: flags["--guestd-root"] };
}

// ---- the runtime's read-only host io (systemctl show / list-units, file reads, directory listing) ----
const systemctl = (scope, args) => execFileSync("systemctl", [...(scope === "user" ? ["--user"] : []), "--no-pager", ...args], { encoding: "utf8", timeout: 10_000 });
function guestRecords(root) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error("--guestd-root is not a real directory");
  const found = [];
  for (const entry of fs.readdirSync(root)) {
    let s;
    try { s = fs.lstatSync(path.join(root, entry, COLD_HOST.guestRecord), { throwIfNoEntry: false }); }
    catch (e) { if (e.code === "ENOTDIR") continue; throw e; }                     // a plain file entry holds no record
    if (s) found.push(path.join(entry, COLD_HOST.guestRecord));
  }
  return found;
}
const hostIo = (guestdRoot) => ({
  readStopReceipt: () => fs.readFileSync(path.resolve(ROOT, COLD_HOST.stopReceipt)),
  readPreservationReceipt: () => fs.readFileSync(COLD_HOST.preservationReceipt),
  showUnit: (scope, unit) => systemctl(scope, ["show", unit, `--property=${SHOW_PROPERTIES.join(",")}`]),
  listGuestUnits: (scope) => systemctl(scope, ["list-units", "--all", "--plain", "--no-legend", "--full", COLD_HOST.guestUnitGlob]),
  guestRecords: () => guestRecords(guestdRoot),
  monotonicUsec: () => process.hrtime.bigint() / 1000n,                             // CLOCK_MONOTONIC, as systemd's *Monotonic stamps
  nowSec: () => Date.now() / 1000,
});

const print = (o) => console.log(JSON.stringify(o, null, 1));
try {
  const a = parseArgs(process.argv.slice(2));
  const planText = fs.readFileSync(a.pos[0], "utf8"), plan = JSON.parse(planText), planHash = "0x" + sha256(planText);
  checkExecutablePlan(PRODUCTION, plan, PROFILE);
  const host = await evaluateColdHost({ plan, stopReceiptSha256: a.stopReceiptSha256, io: hostIo(a.guestdRoot) });
  const report = { profile: PROFILE, planHash, host: { ok: host.ok, findings: host.findings, facts: host.facts } };

  if (a.mode === "resume") {
    if (!host.ok) { print({ ...report, status: "refused", code: "cold_host" }); process.exitCode = 3; }
    else {
      if (a.rebroadcast) await authorizeKeyAccess({ host, sponsorQuiescence: null, plan, planHash });   // refuses: no sponsor guard is wired
      const out = await createSender({ journalDir: a.pos[1], profile: PROFILE }).resume({ planText, rebroadcast: false });   // no signers: never signs
      print({ ...report, ...out }); process.exitCode = out.status === "verified" ? 0 : 3;
    }
  } else {
    const [, approvalFile, approvalSha256, journalDir] = a.pos;
    const findings = [];
    try { checkApproval(PRODUCTION, plan, planHash, fs.readFileSync(approvalFile, "utf8"), approvalSha256, Math.floor(Date.now() / 1000), PROFILE); }
    catch (e) { findings.push({ code: e.code ?? "approval", message: String(e.message).slice(0, 200) }); }
    const J = journalStore(journalDir);                                               // names only; no journal content is read here
    if (J.exists(planHash)) findings.push({ code: "journal", message: "this plan already has a journal: use resume, never run again" });
    if (J.others(planHash).length) findings.push({ code: "journal", message: "another maintenance journal exists in this directory" });
    const gatesOk = host.ok && findings.length === 0;
    if (a.mode === "check") {
      print({ ...report, findings, gatesOk, liveRun: "blocked: no sponsor quiescence guard is wired (see ROOT-WIRING.md)" });
      process.exitCode = gatesOk ? 0 : 3;
    } else {
      if (!gatesOk) { print({ ...report, findings, status: "refused" }); process.exitCode = 3; }
      else {
        await authorizeKeyAccess({ host, sponsorQuiescence: null, plan, planHash });   // always refuses in this revision: nothing below it exists
        throw Object.assign(Error("unreachable"), { code: "not_wired" });
      }
    }
  }
} catch (e) {
  if (e.code === "usage") { console.error(USAGE); process.exitCode = 2; }
  else { console.error(JSON.stringify({ status: "refused-or-recovery-required", code: typeof e.code === "string" ? e.code : "error",
    message: e instanceof Refusal ? e.message : undefined,
    instruction: "No key was read. Inspect the private journal and public chain; never start another signing attempt for an unresolved plan." })); process.exitCode = 3; }
}
