// Local rehearsal of the EXACT plan with main's activation tool (its exported activate(), the CLI's own code path), on a
// control directory built from the bytes the previous activation installed (= the live "before" hashes of this plan).
// The platform is a stub: no agent runs here, so the tool restarts nothing (its tested "no agent running" path).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
import { activate, validatePlan } from "./stage/tool/activate-control-source.mjs";
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const plan = JSON.parse(fs.readFileSync("stage/control-plan.json", "utf8")); validatePlan(plan);
const prev = "../windows-lease-activation-final/stage/source";        // what the previous activation installed
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hardening-rehearsal-")), control = path.join(root, "control"), state = path.join(root, "state");
try {
  for (const e of [...plan.files, ...plan.unchanged]) { const d = path.join(control, ...e.path.split("/")); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(prev, e.path), d); }
  const states = () => plan.files.map((e) => { const h = sha(path.join(control, ...e.path.split("/"))); return h === e.after ? "after" : h === e.before ? "before" : "other"; });
  if (states().some((s) => s !== "before")) throw new Error("the rehearsal control is not the plan's before state");
  const platform = { findAgent: async () => null, stopAgent: async () => {}, health: async () => false, vms: async () => [] };
  const a = await activate({ command: "apply", plan, sourceDir: "stage/source", controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const afterStates = states(), unchangedOk = plan.unchanged.every((e) => sha(path.join(control, ...e.path.split("/"))) === e.sha256);
  const again = await activate({ command: "apply", plan, sourceDir: "stage/source", controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const r = await activate({ command: "rollback", plan, controlDir: control, stateDir: state, platform, observeMs: 100, log: () => {} });
  const back = plan.files.every((e) => sha(path.join(control, ...e.path.split("/"))) === sha(path.join(prev, e.path)));
  const out = { apply: { code: a.code, state: a.status.state, files: afterStates, unchangedOk }, reapply: { code: again.code, state: again.status.state },
    rollback: { code: r.code, state: r.status.state, files: states(), byteExactPrevious: back } };
  console.log(JSON.stringify(out));
  if (a.code !== 3 || afterStates.some((s) => s !== "after") || !unchangedOk || r.code !== 3 || !back) process.exit(1);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
