// An approved desktop release pins the public identity a native V8 desktop may
// be built from. It is shared by the Windows node planner and the relay so both
// refuse the same inputs. Validating a release claims nothing about hardware or
// owner authorization, and nothing here activates a launch policy.
import { appConfigText, sha256Hex } from "./shield-derive.mjs";
import { DESKTOP_DERIVATION, DESKTOP_PROFILE, DESKTOP_PORTS,
  validateDesktopRecord, deriveDesktop } from "./shield-desktop-derive.mjs";

export const DESKTOP_RELEASE_SCHEMA = "enclave-desktop-release/1";
const RELEASE_FIELDS = ["schema", "controllerCid", "controllerSha256", "runtimeId", "igvmSha256",
  "profileSha256", "launchMeasurement", "minimumCpuMilli", "policy"];
const HASH_FIELDS = ["controllerSha256", "runtimeId", "igvmSha256", "profileSha256", "launchMeasurement"];
const HASH = /^[0-9a-f]{64}$/;
// Same expression as shield-desktop-derive.mjs (and derive.go cidRE): a bare CID, never a URL.
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/;
const REQUIRED_PORTS = Object.freeze(["http:8000", ...DESKTOP_PORTS]);
const MAX_PORTS_TEXT = 256;
const MAX_DEPTH = 64;
const nonzero = x => typeof x === "string" && x.length === 64 && HASH.test(x) && x !== "0".repeat(64);
const isCid = x => typeof x === "string" && CID.exec(x)?.[0] === x;
function integer(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label} outside ${low}..${high}`);
}

/** Copy plain JSON-shaped data once: no accessors, symbols, holes, prototypes or class instances. */
function data(value, label, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value !== "object" || depth >= MAX_DEPTH) throw new Error(`${label} must be bounded plain data`);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    throw new Error(`${label} must be plain data objects`);
  const names = Reflect.ownKeys(value);
  if (array && (names.length !== value.length + 1 ||
      names.some(name => name !== "length" &&
        (typeof name !== "string" || !/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length))))
    throw new Error(`${label} arrays must be dense and contain only indexed elements`);
  const out = array ? [] : {};
  for (const name of names) {
    if (array && name === "length") continue;
    const d = typeof name === "string" ? Reflect.getOwnPropertyDescriptor(value, name) : null;
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) throw new Error(`${label} must be data-only`);
    // defineProperty, so a "__proto__" key stays a visible (and refused) field.
    Object.defineProperty(out, name, { value: data(d.value, label, depth + 1),
      enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Read exactly the declared own data fields of a plain object, once. */
function fields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`${label} must be a plain object`);
  const names = Reflect.ownKeys(value);
  if (names.length !== expected.length || !expected.every(k => names.includes(k)))
    throw new Error(`${label} requires exactly its declared fields`);
  const out = {};
  for (const k of expected) {
    const d = Reflect.getOwnPropertyDescriptor(value, k);
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) throw new Error(`${label} must be data-only`);
    out[k] = d.value;
  }
  return out;
}

export function validateDesktopRelease(raw) {
  const r = fields(data(raw, "desktop release"), RELEASE_FIELDS, "desktop release");
  if (r.schema !== DESKTOP_RELEASE_SCHEMA) throw new Error(`desktop release requires ${DESKTOP_RELEASE_SCHEMA}`);
  if (!isCid(r.controllerCid)) throw new Error("invalid desktop controller CID");
  for (const k of HASH_FIELDS)
    if (!nonzero(r[k])) throw new Error(`desktop release ${k} must be nonzero lowercase 64-hex`);
  integer(r.minimumCpuMilli, 1, 1000, "minimum CPU milli");
  const p = fields(r.policy, ["cpuPercent", "vcpus"], "desktop release policy");
  integer(p.cpuPercent, 400, 1600, "CPU percent");
  integer(p.vcpus, 4, 16, "vCPUs");
  if (p.cpuPercent > p.vcpus * 100) throw new Error("CPU percent exceeds the pinned vCPUs");
  return Object.freeze({ schema: r.schema, controllerCid: r.controllerCid,
    controllerSha256: r.controllerSha256, runtimeId: r.runtimeId, igvmSha256: r.igvmSha256,
    profileSha256: r.profileSha256, launchMeasurement: r.launchMeasurement,
    minimumCpuMilli: r.minimumCpuMilli,
    policy: Object.freeze({ cpuPercent: p.cpuPercent, vcpus: p.vcpus }) });
}

function requirePorts(ports) {
  const list = typeof ports === "string" ? (ports.length <= MAX_PORTS_TEXT ? ports.split(",") : null)
    : Array.isArray(ports) && ports.length <= REQUIRED_PORTS.length ? ports : null;
  if (!list) throw new Error("desktop ports must be a bounded comma list or array");
  const seen = new Set();
  for (const p of list) {
    if (typeof p !== "string") throw new Error("desktop ports must be strings");
    const n = p.trim().toLowerCase();
    if (!REQUIRED_PORTS.includes(n) || seen.has(n))
      throw new Error(`desktop port ${JSON.stringify(n)} is unknown or duplicated`);
    seen.add(n);
  }
  if (seen.size !== REQUIRED_PORTS.length) throw new Error("desktop requires exactly HTTP 8000 and the Moonlight ports");
}

/** The exact public configuration text the bundle measures, refused unless egress-only public web. */
function desktopConfigText(config) {
  const text = appConfigText(typeof config === "string" ? config : data(config, "app configuration"));
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("desktop public configuration must be a JSON object");
  if (value.egress !== "public-web") throw new Error("desktop configuration requires egress public-web");
  if (Object.hasOwn(value, "volumes") && !(Array.isArray(value.volumes) && value.volumes.length === 0))
    throw new Error("desktop configuration admits no volumes");
  return text;
}

export function desktopRecordFor(args) {
  const a = fields(args, ["release", "app", "version", "cid", "memMiB", "ports", "deploymentId",
    "cpuMilli", "gpuMilli", "config"], "desktop record request");
  const release = validateDesktopRelease(a.release);
  if (a.cid !== release.controllerCid) throw new Error("desktop CID is not the approved controller");
  // CPU and GPU shares are purchase checks; only gpuMilli is carried by the record.
  integer(a.cpuMilli, release.minimumCpuMilli, 1000, "CPU milli");
  integer(a.gpuMilli, 500, 1000, "GPU milli");
  integer(a.memMiB, 8192, 65536, "memory MiB");
  requirePorts(typeof a.ports === "string" ? a.ports : data(a.ports, "desktop ports"));
  const configBase64 = Buffer.from(desktopConfigText(a.config), "utf8").toString("base64");
  const record = {
    derivation: DESKTOP_DERIVATION,
    catalog: { app: a.app, version: a.version },
    cid: release.controllerCid,
    runtimeId: release.runtimeId,
    policy: { cpuPercent: release.policy.cpuPercent, memMiB: a.memMiB, vcpus: release.policy.vcpus },
    http: 8000,
    ports: [...DESKTOP_PORTS],
    configBase64,
    secretDeployment: a.deploymentId,
    desktop: { profile: DESKTOP_PROFILE, profileSha256: release.profileSha256, gpuMilli: a.gpuMilli },
  };
  validateDesktopRecord(record);
  Object.freeze(record.catalog); Object.freeze(record.policy);
  Object.freeze(record.ports); Object.freeze(record.desktop);
  return Object.freeze(record);
}

export function deriveApprovedDesktop(args) {
  const a = fields(args, ["release", "record", "component"], "approved desktop request");
  const release = validateDesktopRelease(a.release);
  const record = data(a.record, "desktop record");
  validateDesktopRecord(record);
  if (record.cid !== release.controllerCid || record.runtimeId !== release.runtimeId ||
      record.desktop.profileSha256 !== release.profileSha256 ||
      record.policy.cpuPercent !== release.policy.cpuPercent || record.policy.vcpus !== release.policy.vcpus)
    throw new Error("desktop record does not match the approved release pins");
  if (!Buffer.isBuffer(a.component)) throw new Error("desktop controller must be a Buffer");
  // Hash and derive from one private copy of the bytes.
  const component = Buffer.from(a.component);
  if (sha256Hex(component) !== release.controllerSha256)
    throw new Error("desktop controller does not match the approved release hash");
  return deriveDesktop({ record, component });
}
