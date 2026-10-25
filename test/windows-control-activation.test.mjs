// windows/installer/activate-control-source.mjs on a real file tree: a synthetic installed Program Files\Enclave\control
// (old files), the reviewed source, a ProgramData sibling holding a key, env and state that must stay byte-identical,
// and a REAL fake node-agent process whose "run loop" (this test) restarts it after it is ended; it answers /v1/health
// with the sha256 of the agent.mjs it loaded, so the test sees which code runs. The Shield manager is only its VM list:
// the tool has no operation on it at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { activate, makePlan, validatePlan } from "../windows/installer/activate-control-source.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const tree = (d) => { const out = {}; const walk = (p, rel) => { if (!fs.existsSync(p)) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) {
  const r = rel + e.name, q = path.join(p, e.name); if (e.isDirectory()) walk(q, r + "/"); else out[r] = sha(fs.readFileSync(q)); } }; walk(d, ""); return out; };
const AGENT = `import http from "node:http"; import fs from "node:fs"; import { createHash } from "node:crypto";
const code = createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex");
http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ ok: true, code })); }).listen(Number(process.argv[3]), "127.0.0.1");`;

function rig(t, { restart = true, changed = 6, newFiles = 2, manager = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-activation-"));
  const control = path.join(root, "Program Files/Enclave/control"), data = path.join(root, "ProgramData/Enclave"), source = path.join(root, "source"), state = path.join(data, "control-activation");
  const put = (base, rel, s) => { const f = path.join(base, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  // the closure: unchanged files, changed files (old in control, new in source), files new in this release
  const closure = [];
  for (let i = 0; i < 10; i++) { const rel = `network/same-${i}.mjs`; put(control, rel, `same ${i}\n`); put(source, rel, `same ${i}\n`); closure.push(rel); }
  for (let i = 0; i < changed; i++) { const rel = i === 0 ? "windows/node/agent.mjs" : `windows/node/changed-${i}.mjs`; put(control, rel, `old ${i}\n`); put(source, rel, `new ${i}\n`); closure.push(rel); }
  for (let i = 0; i < newFiles; i++) { const rel = `sdk/added/new-${i}.mjs`; put(source, rel, `added ${i}\n`); closure.push(rel); }
  if (manager) { put(control, "windows/vbslike/datapath/node-bridge.mjs", "old bridge\n"); put(source, "windows/vbslike/datapath/node-bridge.mjs", "new bridge\n"); closure.push("windows/vbslike/datapath/node-bridge.mjs"); }
  put(control, "windows/node/package-lock.json", "{}\n"); put(source, "windows/node/package-lock.json", "{}\n"); closure.push("windows/node/package-lock.json");
  put(control, "windows/vbslike/manager/main.mjs", "manager code, not in this closure\n");             // not in the plan: never touched
  for (const [rel, s] of [["node/operator.key", "0xKEY-NEVER-READ\n"], ["node-config.local.cmd", "set SECRET=1\n"], ["node/host.json", "{\"name\":\"h\"}\n"], ["logs/node.log", "log\n"]]) put(data, rel, s);
  const snapshot = { files: closure.map((rel) => ({ path: rel, sha256: fs.existsSync(path.join(control, ...rel.split("/"))) ? sha(fs.readFileSync(path.join(control, ...rel.split("/")))) : null })) };
  // the agent and its run loop
  let child = null, starts = 0, port = 0, stopped = 0;
  const startAgent = async () => {
    port = port || await new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
    fs.writeFileSync(path.join(root, "agent-runner.mjs"), AGENT);
    child = spawn(process.execPath, [path.join(root, "agent-runner.mjs"), path.join(control, "windows/node/agent.mjs"), String(port)], { stdio: "ignore" });
    starts++;
    child.once("exit", () => { child = null; if (restart) setTimeout(() => startAgent().catch(() => {}), 300); });
  };
  const vms = [{ id: "hv1", name: "shield-readiness-v1", status: "running" }];
  const platform = {
    async findAgent() { return child && child.exitCode === null ? { pid: child.pid, commandLine: `node.exe "${path.join(control, "windows/node/agent.mjs")}"` } : null; },
    async stopAgent(pid) { assert.equal(pid, child.pid, "only the agent process is ended"); stopped++; child.kill("SIGTERM"); },
    async health() { try { const j = await (await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) })).json(); return j.ok === true; } catch { return false; } },
    async vms() { return structuredClone(vms); },
  };
  const running = async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()).code; } catch { return null; } };
  t.after(() => { restart = false; child?.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (command, plan, extra = {}) => activate({ command, plan, sourceDir: source, controlDir: control, stateDir: state, platform, observeMs: 8000, pollMs: 100, log: () => {}, ...extra });
  return { root, control, data, source, state, snapshot, startAgent, platform, vms, run, running, counts: () => ({ starts, stopped }), stopRestarts: () => { restart = false; }, put };
}

test("plan: before/after for every changed closure path, the rest recorded unchanged; malformed plans refused", (t) => {
  const r = rig(t);
  const plan = makePlan({ id: "lease-2026-10-20", closure: r.snapshot, sourceDir: r.source });
  assert.equal(plan.files.length, 8); assert.equal(plan.unchanged.length, 11);
  assert.deepEqual(plan.files.filter((f) => f.before === null).map((f) => f.path), ["sdk/added/new-0.mjs", "sdk/added/new-1.mjs"]);
  for (const bad of ["../escape.mjs", "/abs.mjs", "windows\\node\\x.mjs", "ProgramData/Enclave/node/operator.key", "windows/node/../../x.mjs", "windows/node/./x.mjs", "relay/"])
    assert.throws(() => validatePlan({ ...plan, files: [{ path: bad, before: null, after: "a".repeat(64) }] }), /plan path refused/, bad);
  assert.throws(() => validatePlan({ ...plan, files: [...plan.files, plan.files[0]] }), /plan path refused/);
});

test("apply: exactly the planned files change, the agent alone restarts on the new code, VMs and all other state untouched", async (t) => {
  const r = rig(t); await r.startAgent();
  const plan = makePlan({ id: "apply-ok", closure: r.snapshot, sourceDir: r.source });
  const before = { control: tree(r.control), data: tree(r.data) }, oldCode = await r.running();
  const res = await r.run("apply", plan);
  assert.equal(res.code, 0, JSON.stringify(res.status)); assert.equal(res.status.state, "applied-observed");
  assert.equal(res.status.observation.vms, "as before");
  const after = tree(r.control);
  const changed = Object.keys({ ...before.control, ...after }).filter((k) => before.control[k] !== after[k]).sort();
  assert.deepEqual(changed, plan.files.map((f) => f.path).sort(), "only the planned paths");
  for (const f of plan.files) assert.equal(after[f.path], f.after);
  const dataAfter = tree(r.data); for (const [k, v] of Object.entries(before.data)) assert.equal(dataAfter[k], v, `ProgramData ${k} untouched`);
  assert.deepEqual(Object.keys(dataAfter).filter((k) => !k.startsWith("control-activation/")).sort(), Object.keys(before.data).sort(), "nothing new in ProgramData except the tool's journal");
  assert.equal(await r.running(), sha(fs.readFileSync(path.join(r.control, "windows/node/agent.mjs"))), "the restarted agent runs the new agent.mjs");
  assert.notEqual(await r.running(), oldCode);
  assert.deepEqual(r.counts(), { starts: 2, stopped: 1 });
  // backups of exactly the replaced files, verified; the journal says what happened
  for (const f of plan.files.filter((x) => x.before)) assert.equal(sha(fs.readFileSync(path.join(r.state, "apply-ok/backup", ...f.path.split("/")))), f.before);
  const events = fs.readFileSync(path.join(r.state, "apply-ok/journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
  assert.deepEqual([events[0], events.at(-3), events.at(-2), events.at(-1)], ["begin", "files-applied", "agent-stop", "applied"]);
  const st = await r.run("status", plan);
  assert.ok(st.status.files.every((f) => f.state === "after")); assert.equal(st.status.agent.healthy, true); assert.equal(st.status.recorded.state, "applied-observed");
});

test("refusals change nothing: drift in an unchanged file, a changed file, a wrong source, a manager-shared file not accepted", async (t) => {
  for (const [why, arrange, want] of [
    ["unchanged file drifted", (r) => r.put(r.control, "network/same-3.mjs", "edited on the host\n"), /network\/same-3\.mjs is [0-9a-f]{64}, not the recorded/],
    ["changed file is neither version", (r) => r.put(r.control, "windows/node/changed-2.mjs", "hotfix\n"), /changed-2\.mjs is [0-9a-f]{64}, neither the recorded/],
    ["source is not the reviewed one", (r) => r.put(r.source, "windows/node/changed-1.mjs", "tampered\n"), /source windows\/node\/changed-1\.mjs is [0-9a-f]{64}, not the reviewed/]]) {
    const r = rig(t); await r.startAgent();
    const plan = makePlan({ id: "refuse-case", closure: r.snapshot, sourceDir: r.source }); arrange(r);
    const before = tree(r.root);
    await assert.rejects(r.run("apply", plan), (e) => e.refusal && want.test(e.message), why);
    assert.deepEqual(tree(r.root), before, `${why}: nothing written`); assert.deepEqual(r.counts(), { starts: 1, stopped: 0 }, `${why}: agent untouched`);
  }
  const r = rig(t, { manager: true }); await r.startAgent();
  const plan = makePlan({ id: "manager-shared", closure: r.snapshot, sourceDir: r.source });
  assert.deepEqual(validatePlan(plan).managerShared, ["windows/vbslike/datapath/node-bridge.mjs"]);
  await assert.rejects(r.run("apply", plan), /running Shield manager also loads windows\/vbslike\/datapath\/node-bridge\.mjs: apply only with --accept-manager-shared/);
  assert.equal(fs.readFileSync(path.join(r.control, "windows/vbslike/datapath/node-bridge.mjs"), "utf8"), "old bridge\n");
  const ok = await r.run("apply", plan, { acceptManagerShared: true });
  assert.equal(ok.status.state, "applied-observed"); assert.equal(fs.readFileSync(path.join(r.control, "windows/vbslike/manager/main.mjs"), "utf8"), "manager code, not in this closure\n");
});

test("nothing is written through a link inside the control directory", { skip: process.platform === "win32" && "symlinks" }, async (t) => {
  const r = rig(t); await r.startAgent();
  const plan = makePlan({ id: "link-case", closure: r.snapshot, sourceDir: r.source });
  const outside = path.join(r.root, "elsewhere"); fs.mkdirSync(outside);
  fs.rmSync(path.join(r.control, "sdk"), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(r.control, "sdk"));
  await assert.rejects(r.run("apply", plan), /is a link; nothing is written through links/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("an interrupted apply resumes from its journal; rollback restores exactly the old files and restarts the agent", async (t) => {
  const r = rig(t); await r.startAgent();
  const plan = makePlan({ id: "interrupted", closure: r.snapshot, sourceDir: r.source });
  const before = tree(r.control); let n = 0;
  await assert.rejects(r.run("apply", plan, { onEvent: (e) => { if (e.event === "written" && ++n === 3) throw new Error("power lost"); } }), /power lost/);
  const mid = tree(r.control);
  assert.equal(plan.files.filter((f) => mid[f.path] === f.after).length, 3, "three files new, the rest old");
  assert.deepEqual(r.counts(), { starts: 1, stopped: 0 }, "the agent was not touched mid-way");
  const resumed = await r.run("apply", plan);
  assert.equal(resumed.status.state, "applied-observed");
  for (const f of plan.files) assert.equal(tree(r.control)[f.path], f.after);
  const back = await r.run("rollback", plan);
  assert.equal(back.code, 0); assert.equal(back.status.state, "rolled-back-observed");
  assert.deepEqual(tree(r.control), before, "byte-identical to the original install, new files removed");
  assert.equal(await r.running(), sha(fs.readFileSync(path.join(r.control, "windows/node/agent.mjs"))), "the agent runs the old code again");
  assert.deepEqual(r.counts(), { starts: 3, stopped: 2 });
});

test("rollback never overwrites a file someone changed after the apply", async (t) => {
  const r = rig(t); await r.startAgent();
  const plan = makePlan({ id: "conflict", closure: r.snapshot, sourceDir: r.source });
  await r.run("apply", plan);
  r.put(r.control, "windows/node/changed-3.mjs", "a later hotfix\n");
  const res = await r.run("rollback", plan);
  assert.equal(res.code, 1); assert.equal(res.status.state, "rollback-conflict"); assert.deepEqual(res.status.conflicts, ["windows/node/changed-3.mjs"]);
  assert.equal(fs.readFileSync(path.join(r.control, "windows/node/changed-3.mjs"), "utf8"), "a later hotfix\n");
});

test("an agent that does not come back in time is UNOBSERVED - reported, not failed, not rolled back; status observes later", async (t) => {
  const r = rig(t); await r.startAgent(); r.stopRestarts();
  const plan = makePlan({ id: "unobserved", closure: r.snapshot, sourceDir: r.source });
  const res = await r.run("apply", plan, { observeMs: 1500 });
  assert.equal(res.code, 3); assert.equal(res.status.state, "applied-unobserved");
  assert.match(res.status.observation.reason, /unobserved within 2 s: no agent process yet/);
  for (const f of plan.files) assert.equal(tree(r.control)[f.path], f.after, "files stay applied");
  await r.startAgent();   // the run loop brings it back later
  for (let i = 0; i < 100 && !(await r.running()); i++) await new Promise((ok) => setTimeout(ok, 50));
  const st = await r.run("status", plan);
  assert.equal(st.status.agent.healthy, true); assert.equal(st.status.recorded.state, "applied-unobserved");
  // no agent running at all: files are applied, nothing is started by the tool
  const q = rig(t);
  const p2 = makePlan({ id: "no-agent", closure: q.snapshot, sourceDir: q.source });
  const r2 = await q.run("apply", p2);
  assert.equal(r2.code, 3); assert.match(r2.status.observation.reason, /no node agent was running/); assert.deepEqual(q.counts(), { starts: 0, stopped: 0 });
});
