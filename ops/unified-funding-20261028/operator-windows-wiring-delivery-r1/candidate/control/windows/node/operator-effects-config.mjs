// operator-effects-config.mjs - ONE strict, hash-pinned configuration of the Windows operator-effects store, shared by the explicit
// installer (install-operator-effects.mjs) and the real agent -> Host -> chain.setOperatorEffects -> openOperatorEffects path
// (operator Windows wiring r1, SOURCE ONLY, AUTHORED, NOT RUN; nothing here is Windows-qualified).
//
// WHAT IT CLOSES. agent.mjs built Host without cfg.operatorEffects, so on Windows the store opened with no storage check and the default
// WINDOWS_EXCLUSION, which refuses on the pinned Node v24.16.0 (named UV_FS_O_EXLOCK absent): safe, never usable. This module turns ONE
// pinned file into the exact openOperatorEffects options, reusing the reviewed primitives unchanged:
//   - checkLocalPath (win-durable.mjs): local drive path, no reparse/symlink ancestor, regular file with exactly one link;
//   - checkWindowsStorage + storageProbeScript through psrun.mjs powershellRunner (finite timeout and output cap): exact file/parent SDDL,
//     fixed NTFS, no reparse - run by openOperatorEffects BEFORE the journal is opened;
//   - windowsNumericExclusion (win-exclusion.mjs): strict NODE_RUNTIME_PIN, validateExlockQualification, same-process second-open refusal.
//
// TRUST CHAIN (bytes, not Booleans). ENCLAVE_OPERATOR_EFFECTS_CONFIG + ENCLAVE_OPERATOR_EFFECTS_CONFIG_SHA256 (set by the separately
// reviewed deployment step, never by the installer) pin the config bytes. The config pins the qualification record file by sha256 AND
// the evidence file it names by sha256; the record's evidenceSha256 must equal the configured one and the evidence bytes must be
// present. So the record's literal qualifiedBy:"root" counts only because its exact bytes are reachable from the reviewed config pin.
// The config runtime block must EQUAL NODE_RUNTIME_PIN (configuration never widens the pin); the actual process.version/execPath and the
// sha256 of the actual executable must match it too. The reviewed cross-build launcher/probe artifacts are refused as qualification.
//
// IDENTITY. The config domain { account, chainId } is a public check only: before any storage probe or open, the loaded operator
// key's ACTUAL address and the chain client's ACTUAL chain id must equal it (the store separately refuses a log established for another
// domain). A configured account never selects or substitutes the signing identity; no key is read here.
//
// REFUSAL. Absent/malformed/tampered/unsafe/foreign/unqualified configuration never throws out of agent construction and never selects
// another store, an unlocked open, Linux flock or a TEST exclusion: the Host receives REFUSING options (no file access, no PowerShell)
// and a sanitized reason for readiness. chain.mjs then refuses every new operator effect; read-only reconciliation and Stop stay as
// they are. Nothing here creates, initializes, resets, truncates or migrates a store.
//
// TEST. Portable tests pass an explicit TEST object labelled TEST-ONLY-NOT-WINDOWS (runtime/fs/PowerShell injection). It is a function
// argument only - no environment variable selects it - and it is refused on win32. A TEST result reports production:false.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkLocalPath } from "../vbslike/manager/win-durable.mjs";
import { windowsNumericExclusion, validateExlockQualification, NODE_RUNTIME_PIN, UV_FS_O_EXLOCK_NUMERIC, execSha256 } from "../vbslike/manager/win-exclusion.mjs";
import { powershellRunner } from "../vbslike/manager/psrun.mjs";
import { normalizeDomain } from "./operator-effects.mjs";

export const CONFIG_SCHEMA = "enclave-operator-effects-config/1";
export const CONFIG_ENV = "ENCLAVE_OPERATOR_EFFECTS_CONFIG", CONFIG_SHA256_ENV = "ENCLAVE_OPERATOR_EFFECTS_CONFIG_SHA256";
export const STORE_NAME = "operator-effects.journal";
export const TEST_LABEL = "TEST-ONLY-NOT-WINDOWS";
export const MAX_CONFIG_BYTES = 16 * 1024, MAX_QUALIFICATION_BYTES = 16 * 1024, MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const PROBE_TIMEOUT_MS = 60_000, PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** reviewed cross-build artifacts: build evidence, NEVER a qualification record or its evidence */
export const NOT_QUALIFICATION = Object.freeze([
  "94a8483ed8eb40734cf578c7b2ffa5c3e6f83357d8268950acff5c47723e8d7c",   // Job launcher (cross-build)
  "6c8d02e90b5596122095021d9a51f6b77d11487f1610e2f32eca84010a0f660b",   // Job/EXLOCK probe (cross-build; reports its flags false)
]);
const HASH = /^[0-9a-f]{64}$/;
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const fail = (message, code = "OperatorEffectsConfigRefused") => Object.assign(new Error(message), { code });
const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const onlyKeys = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };

// ---- paths ------------------------------------------------------------------------------------------------------------------------------
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$/i;
/** A plain local drive path: no UNC/device/relative form, stream colon, short-name, dot, reserved or trailing-dot/space segment. */
export function windowsPathProblem(p) {
  if (typeof p !== "string" || p.length < 4 || p.length > 240) return "path must be a string of 4..240 characters";
  if (!/^[A-Za-z]:\\/.test(p)) return "path must be a local drive path (no UNC, device or relative form)";
  const rest = p.slice(3);
  if (/[\x00-\x1f<>"|?*:/]/.test(rest)) return "path has a forbidden character (stream, device or separator ambiguity)";
  if (rest.split("\\").some((s) => s === "" || s === "." || s === ".." || /[. ]$/.test(s) || RESERVED.test(s) || /~[0-9]/.test(s)))
    return "path has an empty, dot, reserved, trailing-dot/space or 8.3 short-name segment";
  return null;
}
/** TEST-only POSIX form (portable tests in private temp directories) */
function posixPathProblem(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > 1024 || path.posix.normalize(p) !== p || /[\x00-\x1f]/.test(p) || p.endsWith("/")) return "TEST path must be an absolute normalized POSIX path";
  return null;
}
export const pathProblem = (p, platform) => (platform === "win32" ? windowsPathProblem(p) : posixPathProblem(p));
export const pathApi = (platform) => (platform === "win32" ? path.win32 : path.posix);
/** a === b or a inside b (case-insensitive on Windows) */
export function sameOrInside(a, b, platform) {
  const P = pathApi(platform), k = (x) => (platform === "win32" ? String(x).toLowerCase() : String(x));
  const A = k(a), B = k(b).replace(/[\\/]+$/, "");
  return A === B || A.startsWith(B + P.sep);
}

// ---- bounded pinned reads -----------------------------------------------------------------------------------------------------------------
/** exact bytes of one pinned regular file: link-free local path, one link, unchanged across open, 1..max bytes, sha256 equal to its pin */
export function readPinnedFile(file, expect, { max, fsImpl = fs, platform = process.platform, what = "file" } = {}) {
  const p = pathProblem(file, platform);
  if (p) throw fail(`${what}: ${p}`, "BadPath");
  if (!HASH.test(String(expect))) throw fail(`${what}: its pin must be 64 lowercase hex`, "BadPin");
  let abs, before;
  try { abs = checkLocalPath(file, { fsImpl, platform }); before = fsImpl.lstatSync(abs); }
  catch (e) { throw e.code === "ENOENT" ? fail(`${what}: absent`, "Absent") : fail(`${what}: not a single-link regular file on a link-free local path`, "BadPath"); }
  let fd;
  try { fd = fsImpl.openSync(abs, "r"); } catch { throw fail(`${what}: cannot be opened for reading`, "BadFile"); }
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (before.ino && st.ino !== before.ino) || st.size < 1 || st.size > max) throw fail(`${what}: changed while opened, empty, linked or above ${max} bytes`, "BadFile");
    const buf = Buffer.alloc(st.size); let got = 0;
    while (got < st.size) { const n = fsImpl.readSync(fd, buf, got, st.size - got, got); if (n <= 0) throw fail(`${what}: short read`, "BadFile"); got += n; }
    if (sha(buf) !== expect) throw fail(`${what}: sha256 differs from its pin`, "DigestMismatch");
    return buf;
  } finally { try { fsImpl.closeSync(fd); } catch {} }
}
export function strictJson(buf, what) {
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { throw fail(`${what} is not strict UTF-8`, "Malformed"); }
  try { return JSON.parse(text); } catch { throw fail(`${what} is not valid JSON`, "Malformed"); }   // never echo the parser's excerpt
}

// ---- SDDL --------------------------------------------------------------------------------------------------------------------------------
const BROAD = new Set(["WD", "AU", "BU", "IU", "AN", "BG", "NU", "WR", "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-32-546", "S-1-5-4", "S-1-5-7", "S-1-5-2", "S-1-5-33"]);
/** structural policy check of an SDDL string the probe will compare EXACTLY; refuses allow ACEs for broad principals */
export function sddlProblem(s, { protectedDacl = false } = {}) {
  if (typeof s !== "string" || s.length < 8 || s.length > 4096 || !/^[A-Za-z0-9:;()-]+$/.test(s)) return "SDDL missing or malformed";
  const m = /D:([A-Z]*)((?:\([^()]*\))+)/.exec(s);
  if (!m) return "SDDL has no DACL";
  if (protectedDacl && !m[1].includes("P")) return "directory DACL must be protected (inheritance disabled)";
  for (const ace of m[2].slice(1, -1).split(")(")) {
    const f = ace.split(";");
    if (f.length !== 6) return "SDDL ACE malformed";
    if ((f[0] === "A" || f[0] === "OA") && BROAD.has(f[5].toUpperCase())) return "SDDL grants a broad principal";
  }
  return null;
}

// ---- the configuration ---------------------------------------------------------------------------------------------------------------------
const CONFIG_KEYS = ["schema", "store", "domain", "storage", "runtime", "exclusion"];
const EXCLUSION_KEYS = ["kind", "flag", "qualificationFile", "qualificationSha256", "evidenceFile", "evidenceSha256"];
/** strict parse + validation of the config bytes. pathPlatform "win32" in production; a POSIX form only for labelled TEST callers. */
export function parseOperatorEffectsConfig(bytes, { pathPlatform = "win32" } = {}) {
  const j = strictJson(bytes, "operator-effects config");
  if (!onlyKeys(j, CONFIG_KEYS) || j.schema !== CONFIG_SCHEMA) throw fail("config has unknown or missing fields, or another schema", "Malformed");
  const P = pathApi(pathPlatform), sp = pathProblem(j.store, pathPlatform);
  if (sp) throw fail(`config store: ${sp}`, "BadPath");
  if (P.basename(j.store) !== STORE_NAME) throw fail(`config store must be named ${STORE_NAME}`, "BadPath");
  const stateDir = P.dirname(j.store);
  if (P.relative(P.parse(stateDir).root, stateDir).split(P.sep).filter(Boolean).length < 2) throw fail("config store must live in a dedicated directory at least two levels below the volume root", "BadPath");
  if (!onlyKeys(j.domain, ["account", "chainId"]) || !/^0x[0-9a-f]{40}$/.test(String(j.domain.account))) throw fail("config domain must be { account: lowercase 0x + 40 hex, chainId }", "BadDomain");
  let domain; try { domain = normalizeDomain(j.domain); } catch { throw fail("config domain is not a public operator account and positive chain id", "BadDomain"); }
  if (!onlyKeys(j.storage, ["sddl", "parentSddl"])) throw fail("config storage must be exactly { sddl, parentSddl }", "Malformed");
  const fileSddl = sddlProblem(j.storage.sddl), dirSddl = sddlProblem(j.storage.parentSddl, { protectedDacl: true });
  if (fileSddl || dirSddl) throw fail(`config storage ACL refused: ${fileSddl || dirSddl}`, "StorageUnqualified");
  if (!onlyKeys(j.runtime, ["version", "execPath", "execSha256"]) || j.runtime.version !== NODE_RUNTIME_PIN.version
      || j.runtime.execPath !== NODE_RUNTIME_PIN.execPath || j.runtime.execSha256 !== NODE_RUNTIME_PIN.execSha256)
    throw fail("config runtime differs from the reviewed NODE_RUNTIME_PIN (configuration never widens the pin)", "RuntimeDrift");
  const x = j.exclusion;
  if (!onlyKeys(x, EXCLUSION_KEYS)) throw fail("config exclusion has unknown or missing fields", "Malformed");
  if (x.kind !== "numeric-qualified")
    throw fail("config exclusion must be numeric-qualified: the pinned runtime has no named UV_FS_O_EXLOCK, and a named-constant runtime needs its own reviewed pin and qualification", "ExclusionRefused");
  if (x.flag !== UV_FS_O_EXLOCK_NUMERIC) throw fail("config exclusion flag differs from the qualified numeric flag", "ExclusionRefused");
  for (const k of ["qualificationFile", "evidenceFile"]) {
    const p = pathProblem(x[k], pathPlatform);
    if (p) throw fail(`config ${k}: ${p}`, "BadPath");
    if (sameOrInside(x[k], stateDir, pathPlatform)) throw fail(`config ${k} must not live in the store's writable state directory`, "BadPath");
  }
  if (sameOrInside(x.qualificationFile, x.evidenceFile, pathPlatform)) throw fail("qualification record and its evidence must be distinct files", "BadPath");
  for (const k of ["qualificationSha256", "evidenceSha256"]) {
    if (!HASH.test(String(x[k]))) throw fail(`config ${k} must be 64 lowercase hex`, "BadPin");
    if (NOT_QUALIFICATION.includes(x[k])) throw fail(`config ${k} names a reviewed cross-build artifact: build evidence is not Windows qualification`, "QualificationRefused");
  }
  return deepFreeze({ schema: CONFIG_SCHEMA, store: j.store, stateDir, domain: { ...domain }, storage: { sddl: j.storage.sddl, parentSddl: j.storage.parentSddl },
    runtime: { ...j.runtime }, exclusion: { ...x } });
}
/** the exact canonical bytes the installer writes (fixed key order, 2-space JSON, final newline) */
export function configBytes({ store, domain, storage, exclusion }) {
  return Buffer.from(JSON.stringify({ schema: CONFIG_SCHEMA, store, domain: { account: domain.account, chainId: domain.chainId },
    storage: { sddl: storage.sddl, parentSddl: storage.parentSddl },
    runtime: { version: NODE_RUNTIME_PIN.version, execPath: NODE_RUNTIME_PIN.execPath, execSha256: NODE_RUNTIME_PIN.execSha256 },
    exclusion: { kind: "numeric-qualified", flag: UV_FS_O_EXLOCK_NUMERIC, qualificationFile: exclusion.qualificationFile,
      qualificationSha256: exclusion.qualificationSha256, evidenceFile: exclusion.evidenceFile, evidenceSha256: exclusion.evidenceSha256 } }, null, 2) + "\n");
}
/** pinned config file -> { config, sha256 }; the config file itself must not live in the store's state directory */
export function loadOperatorEffectsConfig({ file, sha256, fsImpl = fs, pathPlatform = "win32" }) {
  const bytes = readPinnedFile(file, sha256, { max: MAX_CONFIG_BYTES, fsImpl, platform: pathPlatform, what: "operator-effects config" });
  const config = parseOperatorEffectsConfig(bytes, { pathPlatform });
  if (sameOrInside(file, config.stateDir, pathPlatform)) throw fail("operator-effects config must not live in the store's writable state directory", "BadPath");
  return { config, sha256: sha(bytes) };
}
/** the pinned qualification record, validated by the reviewed schema, naming exactly the pinned evidence bytes (which must be present) */
export function loadQualification(config, { fsImpl = fs, pathPlatform = "win32" } = {}) {
  const x = config.exclusion;
  const q = strictJson(readPinnedFile(x.qualificationFile, x.qualificationSha256, { max: MAX_QUALIFICATION_BYTES, fsImpl, platform: pathPlatform, what: "EXLOCK qualification record" }), "EXLOCK qualification record");
  let v; try { v = validateExlockQualification(q); } catch (e) { throw fail(`EXLOCK qualification refused: ${e.message}`, "QualificationRefused"); }
  if (v.evidenceSha256 !== x.evidenceSha256) throw fail("EXLOCK qualification names other evidence than the configuration pins", "QualificationRefused");
  readPinnedFile(x.evidenceFile, x.evidenceSha256, { max: MAX_EVIDENCE_BYTES, fsImpl, platform: pathPlatform, what: "EXLOCK qualification evidence" });
  return v;
}
/** THE exclusion, for installer and runtime alike: windowsNumericExclusion over the pinned qualification and the ACTUAL runtime */
export function qualifiedExclusion({ config, runtime, fsImpl = fs, pathPlatform = "win32" }) {
  const qualification = loadQualification(config, { fsImpl, pathPlatform });
  try { return windowsNumericExclusion({ qualification, runtime, fsImpl }); }
  catch (e) { throw fail(`EXLOCK exclusion refused: ${e.message}`, /pinned|differs/.test(e.message) ? "RuntimeDrift" : "ExclusionRefused"); }
}

// ---- process boundaries (production) or an explicit, labelled TEST object -------------------------------------------------------------
/** -> { production, platform, pathPlatform, openPlatform, fsImpl, runtime(), run() } */
export function ioOf(TEST) {
  if (TEST === undefined) {
    const platform = process.platform;
    return { production: true, platform, pathPlatform: platform, openPlatform: platform, fsImpl: fs,
      runtime: () => ({ platform, version: process.version, execPath: process.execPath, execSha256: execSha256(process.execPath) }),
      run: () => powershellRunner({ timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES }) };
  }
  if (!plain(TEST) || TEST.label !== TEST_LABEL || process.platform === "win32") throw fail(`TEST injection must be labelled ${TEST_LABEL} and is refused on Windows`, "TestRefused");
  return { production: false, platform: TEST.runtime?.platform, pathPlatform: TEST.pathPlatform ?? "linux", openPlatform: TEST.openPlatform ?? TEST.runtime?.platform,
    fsImpl: TEST.fsImpl ?? fs, runtime: () => TEST.runtime, run: () => TEST.run };
}
/** before any storage probe or open: the loaded key's actual account and the client's actual chain must be the configured domain */
export function domainGate(configured, actualDomain) {
  const want = normalizeDomain(configured);
  return () => {
    let got; try { got = normalizeDomain(actualDomain()); } catch { throw fail("the operator key is not loaded or its chain is unknown: no operator effect", "OperatorIdentityUnavailable"); }
    if (got.account !== want.account || got.chainId !== want.chainId)
      throw fail("the loaded operator account/chain is not the configured operator-effects domain: refused (configuration never selects the signing identity)", "ForeignDomain");
  };
}
const sanitize = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
/** REFUSING Host options: platform win32 so openOperatorEffects asks storage first, and that answer is the refusal (no fs, no PowerShell) */
export function refusedOperatorEffects(e) {
  const reason = `operator-effects configuration refused (${sanitize(e?.code || "Error")}): ${sanitize(e?.message)}`;
  const refuse = () => fail(reason);
  return Object.freeze({ state: "refused", reason, configSha256: null, production: false, store: null,
    option: Object.freeze({ refused: reason, backend: "windows-owned-log", platform: "win32",
      exclusion: Object.freeze({ name: "refused-configuration", open() { throw refuse(); } }),
      storage: Object.freeze({ run: async () => { throw refuse(); }, sddl: "refused", parentSddl: "refused" }) }) });
}

/**
 * THE construction seam agent.mjs calls before `new Host`. Never throws. -> { state, reason, configSha256, production, store, option }
 *   state "configured": option = { file, backend, platform, fsImpl, exclusion, storage } for Host -> chain.setOperatorEffects
 *   state "refused": option refuses every open with `reason` (sanitized; never config bytes, keys or raw PowerShell output)
 *   state "platform-default": not Windows and no pinned config named -> option undefined (the Host's existing default, unchanged)
 * actualDomain: () => ({ account: <loaded operator key address>, chainId: <chain client id> }), evaluated at open time.
 */
export function operatorEffectsForHost({ env = {}, actualDomain, TEST } = {}) {
  let io;
  try { io = ioOf(TEST); } catch (e) { return refusedOperatorEffects(e); }
  const file = env[CONFIG_ENV], pin = env[CONFIG_SHA256_ENV];
  if (io.platform !== "win32" && file === undefined && pin === undefined)
    return Object.freeze({ state: "platform-default", reason: null, configSha256: null, production: io.production, store: null, option: undefined });
  try {
    if (io.platform !== "win32") throw fail(`a pinned Windows operator-effects configuration on platform ${io.platform}: unsupported`, "UnsupportedPlatform");
    if (!file || !pin) throw fail(`no pinned operator-effects configuration (${CONFIG_ENV} + ${CONFIG_SHA256_ENV}); install it explicitly`, "NotConfigured");
    if (typeof actualDomain !== "function") throw fail("the actual operator identity source is required");
    const { config, sha256 } = loadOperatorEffectsConfig({ file, sha256: pin, fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
    const exclusion = qualifiedExclusion({ config, runtime: io.runtime(), fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
    const gate = domainGate(config.domain, actualDomain), run = io.run();
    if (typeof run !== "function") throw fail("the bounded storage probe runner is unavailable", "StorageUnqualified");
    const option = Object.freeze({ file: config.store, backend: "windows-owned-log", platform: io.openPlatform, fsImpl: io.fsImpl,
      exclusion: Object.freeze({ name: exclusion.name, basis: exclusion.basis, open(f) { gate(); return exclusion.open(f); } }),
      storage: Object.freeze({ run: async (script) => { gate(); return run(script); }, sddl: config.storage.sddl, parentSddl: config.storage.parentSddl }) });
    return Object.freeze({ state: "configured", reason: null, configSha256: sha256, production: io.production, store: config.store, option });
  } catch (e) { return refusedOperatorEffects(e); }
}
