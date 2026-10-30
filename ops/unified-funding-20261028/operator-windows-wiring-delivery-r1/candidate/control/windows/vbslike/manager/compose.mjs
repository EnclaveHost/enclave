/* ============================================================
   Shared, import-safe manager composition (permit r4, SOURCE ONLY, NOT RUN). main.mjs (the REAL packaged entry)
   calls exactly these functions; the r4 tests call the same ones with explicitly TEST-labelled inputs.

   ROLE IS EXPLICIT. "general" (127.0.0.1:8091 class, the general baseline 53a85497...: NO native pin wrapper) or
   "native" (8095/8096, the native desktop entry: the native deployment/image/config/resource pin wrapper ALWAYS
   applies, protected or not). ENCLAVE_MANAGER_ROLE selects it; when it is absent the r3 file's own semantics are kept
   (no permit config -> native, exactly as before); a protected configuration REQUIRES the explicit role.
   r3 defects fixed: main refused a permit config on 8095/8096/desktop, and applied the native wrapper only when
   !permitConfig - so a protected native manager would have dropped its pins. Here the wrapper also guards
   spawnProtectedInternal (the protected stage's raw spawn), with the pp namespace in place of nd.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DESKTOP_DERIVATION } from "./desktop-derive.mjs";

export const ROLES = Object.freeze({ general: Object.freeze({ native: false }), native: Object.freeze({ native: true, port: 8095, dataPort: 8096 }) });
const NATIVE_LEGACY_ID = /^nd[0-9a-f]{32}$/, PROTECTED_ID = /^pp[0-9a-f]{32}$/;
const PERMIT_KEYS = ["enforcement", "journal", "storage", "controlKeyFile", "guard", "port", "dataPort"];

export function selectRole({ explicit = "", permitConfigured = false } = {}) {
  if (explicit) { if (!Object.hasOwn(ROLES, explicit)) throw Error(`unknown ENCLAVE_MANAGER_ROLE ${JSON.stringify(explicit)}`); return explicit; }
  if (permitConfigured) throw Error("a protected manager needs an explicit ENCLAVE_MANAGER_ROLE (general or native)");
  return "native";                                         // the r3 file's unchanged no-permit behaviour
}

export function readPinnedJson(file, sha, what) {
  if (!path.isAbsolute(String(file)) || !/^[0-9a-f]{64}$/.test(String(sha))) throw Error(`pinned ${what} required`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536 || createHash("sha256").update(bytes).digest("hex") !== sha) throw Error(`${what} hash differs`);
  return JSON.parse(bytes);
}

/** permit config: exact keys; general role must avoid the native ports, native role must use exactly them. */
export function validatePermitConfig(c, { role, port, dataPort }) {
  if (!c || typeof c !== "object" || Object.keys(c).some(k => !PERMIT_KEYS.includes(k) && k !== "routerAttestKeyFile") || PERMIT_KEYS.some((k) => !(k in c))) throw Error("permit configuration has unknown or missing fields");
  if ("routerAttestKeyFile" in c && (typeof c.routerAttestKeyFile !== "string" || !path.isAbsolute(c.routerAttestKeyFile))) throw Error("router attestation key requires an absolute path");
  if (c.port !== port || Number(c.dataPort) !== Number(dataPort)) throw Error("permit configuration ports differ from the entry's");
  if (role === "general" && (port === 8095 || Number(dataPort) === 8096)) throw Error("the general-role protected manager never uses the native 8095/8096");
  if (role === "native" && (port !== 8095 || Number(dataPort) !== 8096)) throw Error("the native-role protected manager uses exactly 8095/8096");
  return c;
}

export function nativePinsOf(routerConfig) {
  const p = routerConfig?.nativePins;
  if (!p || !/^0x[0-9a-f]{64}$/.test(p.deployment)) throw Error("native deployment pin absent");
  return Object.freeze({ ...p });
}
/** The r3 native wrapper's exact predicate (unchanged), with the id namespace as a parameter. */
export function nativeRefusal(body, p, idPattern = NATIVE_LEGACY_ID) {
  const d = body?.derive;
  return body?.name !== p.deployment || !idPattern.test(body?.id || "") || d?.derivation !== DESKTOP_DERIVATION || d?.catalog?.app !== p.catalogApp
    || d?.catalog?.version !== p.catalogVersion || d?.cid !== p.cid || d?.runtimeId !== p.runtimeId || d?.desktop?.profileSha256 !== p.profileSha256
    || d?.secretDeployment !== p.deployment || body?.cpuShare !== .25 || body?.gpuShare !== .5 || d?.desktop?.gpuMilli !== 500;
}
/** Native role: scope marker + pinned spawn, for the legacy spawn AND the protected stage's raw spawn. */
export function applyNativeRole(manager, pins, { port, dataPort }) {
  if (port !== ROLES.native.port || Number(dataPort) !== ROLES.native.dataPort) throw Error("native manager requires dedicated loopback ports");
  const nativeHealth = manager.health.bind(manager);
  manager.health = () => ({ ...nativeHealth(), vmScope: { prefix: "enclave-native-", marker: "enclave-native-vbslike-domain" } });
  const nativeSpawn = manager.spawn.bind(manager);
  manager.spawn = (body) => {
    if (nativeRefusal(body, pins)) throw Object.assign(Error("request differs from pinned native deployment"), { status: 400 });
    return nativeSpawn(body);
  };
  if (typeof manager.spawnProtectedInternal === "function") {
    const raw = manager.spawnProtectedInternal.bind(manager);
    manager.spawnProtectedInternal = (body) => {
      if (nativeRefusal(body, pins, PROTECTED_ID)) throw Object.assign(Error("protected stage differs from pinned native deployment"), { status: 400 });
      return raw(body);
    };
  }
  manager.nativePinned = true;
  return manager;
}

/** The data-plane lookup: legacy ids are manager.get; a pp id only under a current asserted grant. */
export function dataLookup(manager, enforcementOf) {
  return { get: (id) => (/^pp/.test(String(id)) ? (enforcementOf() ? enforcementOf().dataView(id, manager.get(id)) : null) : manager.get(id)) };
}

/**
 * The protected composition the entry uses: enforcement (journal, guard, authority, data plane, independent compute
 * remover, workload adapters), startup recovery, the guestd-control/1 server and the protected HTTP server.
 */
export async function composeProtected({ manager, enforcementConfig, journal, guard, authority, dataPlane, computeRemover, adapters = {}, controlKey, routerKey = null, onError = () => {}, now, monotonic }) {
  const [{ PermitEnforcement }, { ControlServer }, { protectedRoutes, createProtectedServer }] = await Promise.all([
    import("./permit-enforcement.mjs"), import("./control.mjs"), import("./protected-manager.mjs")]);
  if (typeof manager.spawnProtectedInternal !== "function") throw Error("protected composition needs a ProtectedManager");
  const enforcement = new PermitEnforcement({ config: enforcementConfig, manager, journal, guard, authority, dataPlane, computeRemover, adapters, onError,
    ...(now ? { now } : {}), ...(monotonic ? { monotonic } : {}) });
  manager.enforcement = enforcement;
  await enforcement.verifyGuard();
  await enforcement.recoverAtStartup();
  const control = new ControlServer({ key: controlKey, handle: protectedRoutes(manager, enforcement) });
  // permit r6: routerKey (owner-selected K_r, router/attest.mjs) enables the composite router's verify-before-latch admission
  const server = createProtectedServer(manager, { control, routerKey, enforcement });
  return { enforcement, control, server };
}
