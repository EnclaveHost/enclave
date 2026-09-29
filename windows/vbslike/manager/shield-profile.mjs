// Fixed single-Radeon profile; distinct from Linux's two-card V100 release.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { runtimeId } from "../../../isolation/contract/runtime.mjs";
import { shieldedCard } from "../../node/shieldedcard.mjs";
export const MODEL = "qwen2.5-0.5b-q8-gguf";
export const CARD_BYTES = 4 * 2 ** 30;
export function profile(runtime) {
  return { model: MODEL, models: [MODEL], minimumGpuMilli: 500, cardBudgetBytes: CARD_BYTES,
    cards: 1, minimumCpuMilli: 250, guestFloorMiB: 8192, runtime, runtimeId: Buffer.from(runtimeId(runtime)).toString("hex") };
}
export function inferenceRefusal(derive, body, p) {
  const i = derive.inference;
  const share = body.gpuShare ?? (Number(body.gpuMilli || 0) / 1000);
  if (!i) return Number(share) === 0 ? null : "GPU allocation requires measured inference";
  if (!p || !p.ready) return "Shield worker/profile is unavailable";
  if (i.model !== MODEL || !Number.isInteger(i.gpuMilli) || i.gpuMilli < 500 || i.gpuMilli > 1000)
    return "NucBox Shield requires the pinned 0.5B model and 500..1000 GPU milli";
  if (!Number.isFinite(share) || Math.abs(share * 1000 - i.gpuMilli) > 1e-7
      || (body.gpuMilli != null && Number(body.gpuMilli) !== i.gpuMilli)) return "GPU allocation differs from measured bundle";
  if (derive.runtimeId !== p.runtimeId) return "wrong Shield runtime identity";
  if (!Number.isFinite(body.cpuShare) || body.cpuShare < 0.25) return "Shield inference needs at least 25% of this node CPU";
  if (derive.policy?.memMiB < 8192 || derive.policy?.vcpus < 4 || derive.policy?.cpuPercent < 400)
    return "Shield inference requires 8192 MiB and four vCPUs";
  if (derive.http) return "initial Shield profile serves wasi:http components";
  if ((derive.ports || []).length) return "Shield tunnel ports are not offered";
  return null;
}
// VM lifecycle owns the bridge; stdin close kills all links, including idle ones.
export async function startBridge({ exe, sha256, vmId, port = 19595 }) {
  if (createHash("sha256").update(fs.readFileSync(exe)).digest("hex") !== sha256)
    throw new Error("Shield bridge executable differs from its pin");
  const child = spawn(exe, [vmId, "19595", String(port), "0"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let resolveExit;
  const exited = new Promise(r => resolveExit = r);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
  child.once("error", e => resolveExit({ error:e.message }));
  const stop = async () => {
    child.stdin.destroy();
    const timer = setTimeout(() => child.kill(), 2000); timer.unref?.();
    await exited; clearTimeout(timer);
  };
  try {
    await new Promise((resolve, reject) => {
      let out = "", err = "";
      const timer = setTimeout(() => reject(new Error("Shield bridge readiness timed out")), 10000);
      const finish = (e) => { clearTimeout(timer); e ? reject(e) : resolve(); };
      child.once("error", finish);
      child.stderr.on("data", b => { err = (err + b).slice(-1000); });
      child.stdout.on("data", b => { out = (out + b).slice(-1000); if (out.includes("shielded bridge ready")) finish(); });
      exited.then(() => finish(new Error("Shield bridge exited: " + err)));
    });
    return { exited, stop };
  } catch (e) { await stop(); throw e; }
}
export async function probeWorker(port = 19595) {
  const c = await shieldedCard({ port, budgetGb: 4 });
  if (c.vramBudgetGb !== 4) throw new Error("worker must enforce the profile's 4-GiB budget");
  return c;
}
// Both images use the same ownership/inventory. Selection is per request, never
// a mutation of the launcher's image pin during concurrent starts.
export class ProfileLauncher {
  constructor(cpu, gpu) { this.cpu=cpu; this.gpu=gpu; }
  get boundary() { return this.cpu.boundary; }
  preflight() { return this.cpu.preflight(); }
  survey() { return this.cpu.survey(); }
  teardown() { return this.cpu.teardown(); }
  start(mapping, opts) { return (mapping.record.inference ? this.gpu : this.cpu).start(mapping, opts); }
  stop(handle) { return this.cpu.stop(handle); }
}
