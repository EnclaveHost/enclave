// V8 has an explicit, opt-in native manager path. It remains absent from the
// ordinary DERIVATIONS: constructing this identity alone authorizes no launch.
import { TextDecoder } from "node:util";
import { ABI, BUNDLE_MAGIC, KIND, COMPONENT_PREAMBLE, MAX_MANIFEST_BYTES,
  MAX_CONFIG_BYTES, canonical, sha256Hex } from "./derive.mjs";

export const DESKTOP_DERIVATION = "enclave-catalog-bundle/8";
export const DESKTOP_PROFILE = "kvm-box-masked-v1";
export const DESKTOP_PORTS = Object.freeze([
  "tcp:47984", "tcp:47989", "tcp:48010", "udp:47998", "udp:47999", "udp:48000",
]);
const HASH = /^[0-9a-f]{64}$/;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$/;
const nonzero = x => typeof x === "string" && x.length === 64 && HASH.test(x) && x !== "0".repeat(64);
function keys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    throw new Error(`${label} requires exactly its declared fields`);
}
function integer(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label} outside ${low}..${high}`);
}

export function validateDesktopRecord(r) {
  keys(r, ["derivation", "catalog", "cid", "runtimeId", "policy", "http", "ports",
    "configBase64", "secretDeployment", "desktop"], "desktop record");
  if (r.derivation !== DESKTOP_DERIVATION) throw new Error("desktop requires V8");
  keys(r.catalog, ["app", "version"], "catalog");
  if (typeof r.catalog.app !== "string" || r.catalog.app.length !== 66 || !/^0x[0-9a-f]{64}$/.test(r.catalog.app))
    throw new Error("invalid catalog app");
  integer(r.catalog.version, 0, 0xffffffff, "catalog version");
  if (typeof r.cid !== "string" || CID.exec(r.cid)?.[0] !== r.cid || !nonzero(r.runtimeId))
    throw new Error("invalid desktop CID or runtime identity");
  keys(r.policy, ["cpuPercent", "memMiB", "vcpus"], "policy");
  integer(r.policy.cpuPercent, 400, 1600, "CPU percent");
  integer(r.policy.memMiB, 8192, 65536, "memory MiB");
  integer(r.policy.vcpus, 4, 16, "vCPUs");
  if (r.http !== 8000 || !Array.isArray(r.ports) ||
      r.ports.length !== DESKTOP_PORTS.length || r.ports.some((p, i) => p !== DESKTOP_PORTS[i]))
    throw new Error("desktop requires fixed HTTP and Moonlight ports");
  if (typeof r.secretDeployment !== "string" || !r.secretDeployment.startsWith("0x") || !nonzero(r.secretDeployment.slice(2)))
    throw new Error("desktop requires a nonzero sealed-secret deployment identity");
  keys(r.desktop, ["profile", "profileSha256", "gpuMilli"], "desktop profile");
  if (r.desktop.profile !== DESKTOP_PROFILE || !nonzero(r.desktop.profileSha256))
    throw new Error("invalid measured desktop profile");
  integer(r.desktop.gpuMilli, 500, 1000, "GPU milli");
  if (typeof r.configBase64 !== "string" || !r.configBase64.length || r.configBase64.length > Math.ceil(MAX_CONFIG_BYTES / 3) * 4)
    throw new Error("invalid desktop public configuration length");
  const bytes = Buffer.from(r.configBase64, "base64");
  if (!bytes.length || bytes.length > MAX_CONFIG_BYTES || bytes.toString("base64") !== r.configBase64 || bytes.includes(0))
    throw new Error("invalid desktop public configuration encoding");
  // Preserve exactly the measured bytes; base64 is an encoding, not encryption.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("desktop public configuration must be a JSON object");
  // Match the Go JSON decoder's maximum container depth. Count source
  // delimiters so duplicate keys cannot hide a deeply nested discarded value.
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") {
      if (++depth > 10000) throw new Error("desktop configuration exceeds nesting depth 10000");
    } else if (c === "}" || c === "]") depth--;
  }
}

export function deriveDesktop({ record, component }) {
  validateDesktopRecord(record);
  if (!Buffer.isBuffer(component) || !component.subarray(0, 8).equals(COMPONENT_PREAMBLE))
    throw new Error("desktop controller must be a portable Wasm component");
  // Own the result, so a caller changing its input cannot mutate the mapping.
  const r = structuredClone(record);
  const manifest = { abi: ABI, artifact: { kind: KIND, sha256: sha256Hex(component) },
    world: "wasi:cli", policy: r.policy, http: r.http, ports: r.ports,
    desktop: r.desktop, configBase64: r.configBase64, secretDeployment: r.secretDeployment };
  const mb = canonical(manifest);
  if (mb.length > MAX_MANIFEST_BYTES) throw new Error("desktop manifest exceeds limit");
  const ml = Buffer.alloc(4), al = Buffer.alloc(4);
  ml.writeUInt32LE(mb.length); al.writeUInt32LE(component.length);
  const bundle = Buffer.concat([Buffer.from(BUNDLE_MAGIC), ml, mb, al, component]);
  return { record: r, recordSha256: sha256Hex(canonical(r)),
    componentSha256: sha256Hex(component), componentBytes: component.length,
    appId: sha256Hex(bundle), bundleBytes: bundle.length, bundle };
}
