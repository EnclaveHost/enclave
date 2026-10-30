/* ============================================================
   NATIVE DESKTOP ADMISSION: the pinned platform plus the runtime it runs, and a spawn-body check
   against a V8 desktop record.

   Pure: no files, no commands, no awaits. Every check runs synchronously on an owned snapshot.

   validateDesktopAdmission binds an operator runtime identity to a validateDesktopPlatform result:
   its runtimeId must be the platform's pin, and it must be the native profile (x86_64 Linux JIT).
   desktopSpawnRefusal says why a spawn body does not fit a desktop record, or null.

   WHAT IT DOES NOT CLAIM. Passing here does not authorize a launch, a wallet or secret release, or
   physical capacity, and does not mean the desktop is ready. Generic spawn guards (plaintext
   secrets, env, WAF, volumes, egress) stay with the caller.
   ============================================================ */
import { runtimeId, ISA_X86_64, EXEC_JIT } from "../../../isolation/contract/runtime.mjs";
import { validateDesktopRecord } from "./desktop-derive.mjs";
import { validateDesktopPlatform } from "./desktop-platform.mjs";

export const ADMISSION_KEYS = Object.freeze(["platform", "runtime"]);
// Configuration is the record's measured configBase64 only; a body may not name another source.
export const ALTERNATE_CONFIG_FIELDS = Object.freeze(["config", "configCid", "appConfigCid"]);
// Secret bootstrap and custody belong to the sealed-secret deployment, never to a spawn body.
const BOOTSTRAP_OR_CUSTODY = ["bootstrap", "custody"];

function bad(msg) { throw new Error(`desktop admission: ${msg}`); }

function plain(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own data properties only, exactly `keys`, read once each (no getters run, no inherited fields). */
function exactData(v, keys, what) {
  if (!plain(v)) bad(`${what} must be a plain object`);
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k)))
    bad(`${what} must have exactly the keys ${keys.join(", ")}`);
  const out = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) bad(`${what}.${k} must be a data property`);
    out[k] = d.value;
  }
  return out;
}

/**
 * -> Object.freeze({ platform, runtime }): the frozen validateDesktopPlatform result for the raw
 * platform config, and a frozen owned copy of the runtime identity whose runtimeId is the platform's.
 * Throws on anything outside the contract. This is not a readiness or secret-release decision.
 */
export function validateDesktopAdmission(config) {
  const c = exactData(config, ADMISSION_KEYS, "config");
  const platform = validateDesktopPlatform(c.platform);

  if (!plain(c.runtime)) bad("runtime must be a plain object");
  let runtime;
  try { runtime = structuredClone(c.runtime); } catch { bad("runtime must be plain data"); }
  let id;
  try { id = runtimeId(runtime).toString("hex"); } catch (e) { bad(`runtime: ${e.message}`); }
  if (id !== platform.runtimeId) bad("runtime identity does not hash to the platform runtimeId");
  // The native desktop profile is an x86_64 Linux guest running its components under a JIT.
  if (runtime.hostIsa !== ISA_X86_64 || runtime.execution !== EXEC_JIT)
    bad(`native desktop requires hostIsa ${ISA_X86_64} and execution ${EXEC_JIT}`);
  return Object.freeze({ platform, runtime: Object.freeze(runtime) });
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * -> null when `body` may spawn `record` (a V8 desktop record), else the reason it may not.
 * Never throws for bad input and never mutates either argument.
 */
export function desktopSpawnRefusal(record, body) {
  let r;
  try {
    r = structuredClone(record);
    validateDesktopRecord(r);
  } catch (e) { return e instanceof Error ? e.message : "desktop record is malformed"; }

  if (!plain(body)) return "desktop spawn body must be a plain object";
  let b;
  try { b = structuredClone(body); } catch { return "desktop spawn body must be plain data"; }

  if (b.name !== r.secretDeployment) return "desktop spawn name must be the record's secretDeployment";
  if (b.hasSecrets !== true) return "desktop spawn requires hasSecrets true";
  if (b.isPublic !== true) return "desktop spawn requires isPublic true";

  for (const k of BOOTSTRAP_OR_CUSTODY)
    if (b[k] !== undefined)
      return `desktop spawn may not carry ${JSON.stringify(k)}; secrets come from the sealed deployment`;
  for (const k of ALTERNATE_CONFIG_FIELDS)
    if (b[k] !== undefined) return `desktop spawn may not carry ${k}; configuration is the measured configBase64`;
  if (b.ports !== undefined && (!Array.isArray(b.ports) || b.ports.length !== 0))
    return "desktop ports must come from the measured record, never host port mappings";

  const milli = r.desktop.gpuMilli;
  if (b.gpuMilli === undefined && b.gpuShare === undefined) return "desktop spawn requires gpuMilli or gpuShare";
  if (b.gpuMilli !== undefined) {
    if (!finite(b.gpuMilli)) return "desktop spawn gpuMilli must be a finite number";
    if (b.gpuMilli !== milli) return `desktop spawn gpuMilli must be the record's ${milli}`;
  }
  if (b.gpuShare !== undefined) {
    if (!finite(b.gpuShare)) return "desktop spawn gpuShare must be a finite number";
    if (!(b.gpuShare > 0 && b.gpuShare <= 1)) return "desktop spawn gpuShare must be in (0, 1]";
    if (Math.abs(b.gpuShare * 1000 - milli) > 1e-7) return `desktop spawn gpuShare must be the record's ${milli / 1000}`;
  }
  if (!finite(b.cpuShare) || !(b.cpuShare > 0 && b.cpuShare <= 1))
    return "desktop spawn cpuShare must be a finite number in (0, 1]";

  if (b.firewall !== undefined) {
    const fw = b.firewall;
    if (!Array.isArray(fw) || fw.length !== r.ports.length) return "desktop spawn firewall must be exactly the record's ports, in order";
    // Index every slot: a sparse array has holes that .some/.every would skip.
    for (let i = 0; i < fw.length; i++)
      if (fw[i] !== r.ports[i]) return "desktop spawn firewall must be exactly the record's ports, in order";
  }
  return null;
}
