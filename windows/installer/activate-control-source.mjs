// activate-control-source.mjs - a SCOPED update of an installed Windows host's node-agent source (Program Files\Enclave\
// control) to a reviewed closure, without the full installer: the Shield/VM manager and its VMs keep running, and no
// key, credential, configuration or state file is read or written. Run it with the host's own runtime\node\node.exe.
//
//   plan     --closure SNAPSHOT.json --source DIR --id ID [--out PLAN.json]
//            SNAPSHOT: the host's read-only inventory ({files:[{path, sha256|null}]}, e.g. inspect-public-closure.ps1);
//            DIR: the reviewed source tree. Every closure path gets its before (installed) and after (reviewed) sha256.
//   apply    --plan PLAN.json --source DIR [--control DIR] [--state DIR] [--accept-manager-shared] [--observe-sec N]
//   status   --plan PLAN.json [--control DIR] [--state DIR]
//   rollback --plan PLAN.json [--control DIR] [--state DIR] [--observe-sec N]
//
// apply: (1) a read-only preflight - every unchanged path still has its recorded hash, every changed path is either its
// "before" (or, after an interrupted run, its "after" with a verified backup), every source file is its "after", every
// path resolves inside the control directory through no link, and files the running manager also loads are applied
// only with --accept-manager-shared; (2) a write-ahead journal in STATE\<id> and a verified backup of every file it will
// replace; (3) each file written beside its target and renamed over it, then every hash verified; (4) only the node
// agent (the process running control\windows\node\agent.mjs) is ended - its run-node.cmd loop starts the new code ~10 s
// later; (5) observation: a NEW agent process answering its /v1/health, and the manager's VMs as they were. An observation
// that times out is reported as UNOBSERVED (exit 3), never as a failure and never rolled back automatically: `status`
// observes again. A rerun after an interruption resumes; `rollback` restores exactly the journaled files.
// Exit: 0 applied/rolled back and observed, 3 done but unobserved, 2 refused before any change, 1 error (see status).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FORMAT = "enclave-windows-control-activation/v1";
const SOURCE_PATH = /^(availability|isolation|network|relay|sdk|windows\/node|windows\/vbslike)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const MANAGER_SHARED = /^windows\/vbslike\/(manager|datapath)\//;
const HEX = /^[0-9a-f]{64}$/;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const shaOf = (f) => { try { return sha(fs.readFileSync(f)); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
class Refusal extends Error { constructor(m) { super(m); this.refusal = true; } }

export function validatePlan(p) {
  if (!p || p.format !== FORMAT || !/^[a-z0-9][a-z0-9-]{3,63}$/.test(p.id || "")) throw new Refusal("not an activation plan (format, id)");
  if (!Array.isArray(p.files) || !p.files.length || !Array.isArray(p.unchanged)) throw new Refusal("a plan names files to change and the unchanged rest of the closure");
  const seen = new Set();
  for (const e of [...p.files, ...p.unchanged]) {
    const rel = e && e.path;
    if (typeof rel !== "string" || !SOURCE_PATH.test(rel) || rel.split("/").some((s) => s === "." || s === "..") || seen.has(rel)) throw new Refusal(`plan path refused: ${String(rel).slice(0, 120)}`);
    seen.add(rel);
  }
  for (const e of p.files) if (!(e.before === null || HEX.test(e.before)) || !HEX.test(e.after) || e.before === e.after) throw new Refusal(`plan entry ${e.path}: before/after`);
  for (const e of p.unchanged) if (!(e.sha256 === null || HEX.test(e.sha256))) throw new Refusal(`plan entry ${e.path}: sha256`);
  return { ...p, managerShared: p.files.filter((e) => MANAGER_SHARED.test(e.path)).map((e) => e.path) };
}

export function makePlan({ id, closure, sourceDir }) {
  const files = [], unchanged = [];
  for (const row of closure.files) {
    const after = shaOf(path.join(sourceDir, ...row.path.split("/")));
    if (!after) throw new Refusal(`the reviewed source has no ${row.path}`);
    const before = row.sha256 ? String(row.sha256).toLowerCase() : null;
    if (before === after) unchanged.push({ path: row.path, sha256: after }); else files.push({ path: row.path, before, after });
  }
  return validatePlan({ format: FORMAT, id, files, unchanged });
}

// The target of a plan path inside `root`, refusing any existing link (symlink/junction) on the way.
function inside(root, rel) {
  const target = path.resolve(root, ...rel.split("/"));
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Refusal(`${rel} leaves the control directory`);
  let p = path.resolve(root);
  for (const seg of rel.split("/")) {
    p = path.join(p, seg);
    let st; try { st = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") break; throw e; }
    if (st.isSymbolicLink()) throw new Refusal(`${rel}: ${p} is a link; nothing is written through links`);
  }
  return target;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function writeAtomic(dst, bytes, suffix) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + suffix; fs.writeFileSync(tmp, bytes);
  if (sha(fs.readFileSync(tmp)) !== sha(bytes)) { fs.rmSync(tmp, { force: true }); throw new Error(`${tmp}: written bytes do not verify`); }
  fs.renameSync(tmp, dst);
}

export async function activate({ command, plan: rawPlan, sourceDir = null, controlDir, stateDir, platform, acceptManagerShared = false,
  observeMs = 120_000, pollMs = 1000, log = (m) => console.log(m), onEvent = () => {} }) {
  const plan = validatePlan(rawPlan), dir = path.join(stateDir, plan.id), journalFile = path.join(dir, "journal.jsonl");
  const journal = () => (fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const record = (event) => { const e = { at: new Date().toISOString(), ...event }; fs.appendFileSync(journalFile, JSON.stringify(e) + "\n"); onEvent(e); return e; };
  const backupOf = (rel) => path.join(dir, "backup", ...rel.split("/"));
  const status = (s) => { fs.writeFileSync(path.join(dir, "status.json.tmp"), JSON.stringify(s, null, 1) + "\n"); fs.renameSync(path.join(dir, "status.json.tmp"), path.join(dir, "status.json")); return s; };
  const fileStates = () => plan.files.map((e) => { const cur = shaOf(inside(controlDir, e.path)); return { path: e.path, state: cur === e.after ? "after" : cur === e.before ? "before" : "other" }; });

  async function observe(oldPid, vmsBefore, what) {
    const deadline = Date.now() + observeMs; let agent = null, healthy = false, reason = "";
    while (Date.now() < deadline) {
      // the reason always describes the LATEST poll
      let read = true;
      try { agent = await platform.findAgent(); } catch (e) { reason = `agent process not readable: ${e.message}`; agent = null; read = false; }
      if (!read) healthy = false;
      else if (agent && agent.pid !== oldPid) { try { healthy = await platform.health(); } catch { healthy = false; } if (healthy) break; reason = "the new agent has not answered /v1/health yet"; }
      else { healthy = false; reason = agent ? "the old agent process is still the one running" : "no agent process yet (its run loop restarts it about 10 s after it ends)"; }
      await sleep(pollMs);
    }
    let vmsAfter = null; try { vmsAfter = await platform.vms(); } catch {}
    const lost = vmsBefore && vmsAfter ? vmsBefore.filter((v) => v.status === "running" && !vmsAfter.some((w) => w.id === v.id && w.status === "running")).map((v) => v.id) : null;
    const observed = healthy && !!agent && agent.pid !== oldPid;
    return { what, observed, agentPid: agent ? agent.pid : null, reason: observed ? null : `unobserved within ${Math.round(observeMs / 1000)} s: ${reason}`,
      vms: vmsAfter === null ? "unreadable" : lost && lost.length ? { notRunningAnyMore: lost } : "as before" };
  }
  async function restartAgent(what) {
    let agent = null; try { agent = await platform.findAgent(); } catch (e) { return { what, observed: false, reason: `agent process not readable: ${e.message}; not restarted` }; }
    let vmsBefore = null; try { vmsBefore = await platform.vms(); } catch {}
    if (!agent) { record({ event: "agent-not-running" }); return { what, observed: false, reason: "no node agent was running: files are in place; this tool starts nothing (its scheduled task does)" }; }
    record({ event: "agent-stop", pid: agent.pid });
    await platform.stopAgent(agent.pid);
    return observe(agent.pid, vmsBefore, what);
  }

  if (command === "status") {
    const st = fs.existsSync(path.join(dir, "status.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) : null;
    let agent = null, healthy = false; try { agent = await platform.findAgent(); healthy = agent ? await platform.health() : false; } catch {}
    let vms = null; try { vms = await platform.vms(); } catch {}
    return { code: 0, status: { plan: plan.id, recorded: st, files: fileStates(), agent: agent ? { pid: agent.pid, healthy } : null, vms: vms ? vms.map((v) => ({ id: v.id, status: v.status })) : "unreadable" } };
  }

  if (command === "rollback") {
    const events = journal();
    if (!events.length) throw new Refusal(`no journal for ${plan.id} in ${dir}: nothing was applied by this tool`);
    const touched = [...new Set(events.filter((e) => e.event === "write").map((e) => e.path))];
    const conflicts = [];
    for (const rel of touched) {
      const e = plan.files.find((x) => x.path === rel), dst = inside(controlDir, rel), cur = shaOf(dst);
      fs.rmSync(dst + ".activate-tmp", { force: true });
      if (cur === e.before) continue;
      if (cur !== e.after) { conflicts.push(rel); continue; }   // changed by someone else since: never overwritten
      if (e.before === null) fs.rmSync(dst);
      else { const b = fs.readFileSync(backupOf(rel)); if (sha(b) !== e.before) throw new Error(`backup of ${rel} does not verify`); writeAtomic(dst, b, ".rollback-tmp"); }
      record({ event: "restored", path: rel });
    }
    if (conflicts.length) { record({ event: "rollback-conflict", paths: conflicts }); return { code: 1, status: status({ plan: plan.id, state: "rollback-conflict", conflicts, files: fileStates() }) }; }
    const obs = await restartAgent("rollback");
    record({ event: "rolled-back", observed: obs.observed });
    return { code: obs.observed ? 0 : 3, status: status({ plan: plan.id, state: obs.observed ? "rolled-back-observed" : "rolled-back-unobserved", observation: obs, files: fileStates() }) };
  }

  if (command !== "apply") throw new Refusal(`unknown command ${command}`);
  // ---- (1) preflight: read-only
  const problems = [], events = journal(), backedUp = new Set(events.filter((e) => e.event === "backup").map((e) => e.path));
  for (const e of plan.unchanged) { const cur = shaOf(inside(controlDir, e.path)); if (cur !== e.sha256) problems.push(`${e.path} is ${cur || "absent"}, not the recorded ${e.sha256 || "absent"}`); }
  for (const e of plan.files) {
    const src = shaOf(path.join(sourceDir, ...e.path.split("/")));
    if (src !== e.after) problems.push(`source ${e.path} is ${src || "absent"}, not the reviewed ${e.after}`);
    const cur = shaOf(inside(controlDir, e.path));
    if (cur === e.after && e.before !== null && !backedUp.has(e.path)) problems.push(`${e.path} is already the new version but this tool holds no backup of the old one`);
    else if (cur !== e.before && cur !== e.after) problems.push(`${e.path} is ${cur || "absent"}, neither the recorded ${e.before || "absent"} nor the reviewed version`);
  }
  if (plan.managerShared.length && !acceptManagerShared)
    problems.push(`the running Shield manager also loads ${plan.managerShared.join(", ")}: apply only with --accept-manager-shared after reviewing those changes (the manager is not restarted)`);
  if (problems.length) { const err = new Refusal(`refused, nothing changed:\n  ${problems.join("\n  ")}`); err.problems = problems; throw err; }
  // ---- (2) journal + verified backups
  fs.mkdirSync(path.join(dir, "backup"), { recursive: true });
  const planFile = path.join(dir, "plan.json"), planText = JSON.stringify(rawPlan, null, 1) + "\n";
  if (fs.existsSync(planFile) && fs.readFileSync(planFile, "utf8") !== planText) throw new Refusal(`${dir} holds a different plan with the same id`);
  fs.writeFileSync(planFile, planText);
  record({ event: events.length ? "resume" : "begin", files: plan.files.length, managerShared: plan.managerShared });
  for (const e of plan.files) {
    if (e.before === null || backedUp.has(e.path)) continue;
    const bytes = fs.readFileSync(inside(controlDir, e.path));
    if (sha(bytes) !== e.before) throw new Error(`${e.path} changed during the backup`);
    writeAtomic(backupOf(e.path), bytes, ".tmp");
    record({ event: "backup", path: e.path });
  }
  // ---- (3) write-ahead, write beside, rename over, verify
  for (const e of plan.files) {
    const dst = inside(controlDir, e.path);
    if (shaOf(dst) === e.after) continue;
    record({ event: "write", path: e.path });
    writeAtomic(dst, fs.readFileSync(path.join(sourceDir, ...e.path.split("/"))), ".activate-tmp");
    record({ event: "written", path: e.path });
  }
  const off = fileStates().filter((f) => f.state !== "after");
  if (off.length) throw new Error(`after writing, ${off.map((f) => f.path).join(", ")} do not verify`);
  record({ event: "files-applied" });
  // ---- (4)+(5) the agent only, then observe
  const obs = await restartAgent("apply");
  record({ event: "applied", observed: obs.observed });
  return { code: obs.observed ? 0 : 3, status: status({ plan: plan.id, state: obs.observed ? "applied-observed" : "applied-unobserved", observation: obs, files: fileStates() }) };
}

/** The installed host's process and local endpoints (Windows; PowerShell's CIM for the command line, never a key or env). */
export function windowsPlatform({ controlDir, agentPort = 9600, managerUrl = "http://127.0.0.1:8091" }) {
  const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 30_000 });
  const agentPath = path.win32.join(controlDir, "windows", "node", "agent.mjs").toLowerCase();
  const json = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
  return {
    findAgent() {
      const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress").trim();
      const rows = out ? [].concat(JSON.parse(out)) : [], m = rows.filter((r) => String(r.CommandLine || "").toLowerCase().includes(agentPath));
      if (m.length > 1) throw new Error(`${m.length} processes run ${agentPath}`);
      return m.length ? { pid: Number(m[0].ProcessId), commandLine: m[0].CommandLine } : null;
    },
    stopAgent(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("bad pid"); ps(`Stop-Process -Id ${pid} -Force`); },
    async health() { try { return (await json(`http://127.0.0.1:${agentPort}/v1/health`)).ok === true; } catch { return false; } },
    async vms() { return (await json(`${managerUrl}/vms`)).vms || []; },
  };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...rest] = process.argv.slice(2), opt = {};
  for (let i = 0; i < rest.length; i++) { const k = rest[i]; if (!k.startsWith("--")) { opt.bad = k; break; } if (k === "--accept-manager-shared") opt.accept = true; else opt[k.slice(2)] = rest[++i]; }
  const PF = process.env.ProgramFiles || "C:\\Program Files", PD = process.env.ProgramData || "C:\\ProgramData";
  const controlDir = opt.control || path.join(PF, "Enclave", "control"), stateDir = opt.state || path.join(PD, "Enclave", "control-activation");
  const done = (code, out) => { console.log(JSON.stringify(out, null, 1)); process.exitCode = code; };
  try {
    if (opt.bad) throw new Refusal(`unexpected argument ${opt.bad}`);
    if (command === "plan") {
      const p = makePlan({ id: opt.id, closure: JSON.parse(fs.readFileSync(opt.closure, "utf8")), sourceDir: opt.source });
      if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(p, null, 1) + "\n");
      done(0, { plan: p.id, change: p.files.length, unchanged: p.unchanged.length, managerShared: p.managerShared });
    } else {
      const r = await activate({ command, plan: JSON.parse(fs.readFileSync(opt.plan, "utf8")), sourceDir: opt.source, controlDir, stateDir,
        platform: windowsPlatform({ controlDir }), acceptManagerShared: !!opt.accept, observeMs: 1000 * Number(opt["observe-sec"] || 120) });
      done(r.code, r.status);
    }
  } catch (e) { console.error(e.refusal ? e.message : `error: ${e.message} (see the journal; \`status\` reports the files)`); process.exitCode = e.refusal ? 2 : 1; }
}
