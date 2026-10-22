// Local rehearsal of the EXACT control plan with main's activation tool (its exported activate(), the CLI's own code path), on
// a control directory built from the bytes the last activation (app-lease-hardening-20261021) installed - the baseline
// "before" of this plan. The platform is a stub: no agent runs here, so the tool restarts nothing (its "no agent running"
// path, which is also what 20-activate.ps1 uses: the Node task is stopped first).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
import { activate, validatePlan } from "./stage/tool/activate-control-source.mjs";
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const plan = JSON.parse(fs.readFileSync("stage/control-plan.json", "utf8")); validatePlan(plan);
const prev = "../windows-hardening-release/stage/source";        // what the last activation installed
const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-relay-rehearsal-")), control = path.join(root, "control"), state = path.join(root, "state");
const at = (p) => path.join(control, ...p.split("/"));
try {
  for (const e of [...plan.files, ...plan.unchanged]) { fs.mkdirSync(path.dirname(at(e.path)), { recursive: true }); fs.copyFileSync(path.join(prev, e.path), at(e.path)); }
  const states = () => plan.files.map((e) => { const h = sha(at(e.path)); return h === e.after ? "after" : h === e.before ? "before" : "other"; });
  if (states().some((s) => s !== "before")) throw new Error("the rehearsal control is not the plan's before state");
  const platform = { findAgent: async () => null, stopAgent: async () => {}, health: async () => false, vms: async () => [] };
  const a = await activate({ command: "apply", plan, sourceDir: "stage/source", controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const afterStates = states(), unchangedOk = plan.unchanged.every((e) => sha(at(e.path)) === e.sha256);
  const again = await activate({ command: "apply", plan, sourceDir: "stage/source", controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const r = await activate({ command: "rollback", plan, controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const back = plan.files.every((e) => sha(at(e.path)) === sha(path.join(prev, e.path)));
  const out = { plan: plan.id, changed: plan.files.map((e) => e.path), unchanged: plan.unchanged.length, managerShared: plan.managerShared,
    apply: { code: a.code, state: a.status.state, files: afterStates, unchangedOk }, reapply: { code: again.code, state: again.status.state },
    rollback: { code: r.code, state: r.status.state, byteExactPrevious: back } };
  console.log(JSON.stringify(out));
  const ok = a.code === 3 && afterStates.every((s) => s === "after") && unchangedOk && again.code === 3 && r.code === 3 && back
    && plan.files.length === 1 && plan.unchanged.length === 79 && plan.managerShared.length === 0;
  process.exitCode = ok ? 0 : 1;
} finally { fs.rmSync(root, { recursive: true, force: true }); }
