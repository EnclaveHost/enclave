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
//
// wiring r2 (SOURCE ONLY, AUTHORED, NOT RUN; supersedes the r1 parts named here):
//   - BOUNDED READS. readBoundedFile refuses an oversized file from lstat BEFORE any allocation or read, then reads at most size+1 bytes on
//     the held descriptor and refuses growth, truncation, replacement or a changed path as a race (never "probably fine"). readPinnedFile,
//     the installer's inspection and every legacy read use it.
//   - SERVICE IDENTITY. The only accepted service identity is one per-service virtual account NT SERVICE\<name>; its SID is DERIVED
//     (S-1-5-80 + SHA-1 of the upper-cased UTF-16LE name, the Windows service-SID rule), so its principal type is fixed by construction:
//     never a group, SYSTEM, a shared LocalService/NetworkService, a user or an unverifiable domain account.
//   - ACL EVALUATION. parseSddl/aclProblem/stateAclProblem read an OBSERVED SDDL structurally: trusted owner, which non-trusted
//     principals hold write/delete/re-permission rights, and whether the service SID (with the groups every service token carries) is
//     granted the read it needs. This is an ACL reading, NOT a native AccessCheck under the service token (root qualification).
//   - CONFIG /2 adds instance { serviceAccount, serviceSid, nodeDir }. At runtime the agent's actual NODE_DIR (NODE_DIR || the agent's
//     own directory, exactly agent.mjs DIR) must equal nodeDir, its legacy r12 obligation files must hold no records and no store may sit
//     at its legacy default; before the storage probe, the probe child (same token as this process) must report the configured service
//     SID. The storage SDDLs must be exactly the installed state ACL for that SID.
//   - The production runner is psrun.mjs's reviewed absolute PowerShell path with finite bounds; TEST injects its own.
//
// wiring r4 (SOURCE ONLY, AUTHORED, NOT RUN; additive, NT SERVICE behaviour unchanged):
//   - EXPLICIT SYSTEM IDENTITY. config /2 instance may instead be { processAccount: "NT AUTHORITY\\SYSTEM", processSid: "S-1-5-18",
//     launcher { kind: "scheduled-task", taskPath, taskName, specifiedBy: "local-machine-owner" }, nodeDir }. The process SID is stated
//     and checked, never derived from the launcher; the launcher is any bounded task path/name the local machine owner chose (\Enclave\Node
//     is one target example) and is not an SCM service. serviceIdentity still refuses SYSTEM.
//   - SYSTEM is a trusted writer: its state ACL is exactly SYSTEM + Administrators full control (two entries, no second SYSTEM entry);
//     its reads count grants to SYSTEM or the groups its token carries. The virtual-service rules are untouched.
//   - CutoverUnqualified. A well-formed SYSTEM binding is recognised and then REFUSED by the construction seam before NODE_DIR, legacy
//     files, exclusion or any probe is consulted: continuous old-writer exclusion, the running process's effective NODE_DIR and
//     task-to-process ancestry are unproven, and nothing in this source observes or asserts them. No argument, environment value or
//     Boolean lifts the refusal; only a later, separately implemented and qualified cutover boundary may replace it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkLocalPath } from "../vbslike/manager/win-durable.mjs";
import { windowsNumericExclusion, validateExlockQualification, NODE_RUNTIME_PIN, UV_FS_O_EXLOCK_NUMERIC, execSha256 } from "../vbslike/manager/win-exclusion.mjs";
import { powershellRunner, unresolvedProcesses } from "../vbslike/manager/psrun.mjs";
import { normalizeDomain } from "./operator-effects.mjs";

export const CONFIG_SCHEMA = "enclave-operator-effects-config/2";
export const CONFIG_ENV = "ENCLAVE_OPERATOR_EFFECTS_CONFIG", CONFIG_SHA256_ENV = "ENCLAVE_OPERATOR_EFFECTS_CONFIG_SHA256";
export const STORE_NAME = "operator-effects.journal";
export const TEST_LABEL = "TEST-ONLY-NOT-WINDOWS";
export const MAX_CONFIG_BYTES = 16 * 1024, MAX_QUALIFICATION_BYTES = 16 * 1024, MAX_EVIDENCE_BYTES = 4 * 1024 * 1024, MAX_LEGACY_BYTES = 8 * 1024 * 1024;
export const PROBE_TIMEOUT_MS = 60_000, PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** the directory agent.mjs lives in (this module ships beside it): agent.mjs DIR = process.env.NODE_DIR || this directory */
export const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
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
/** the same directory (case-insensitive on Windows, trailing separators ignored) */
export function sameDir(a, b, platform) {
  const k = (x) => { const s = String(x).replace(/[\\/]+$/, ""); return platform === "win32" ? s.toLowerCase() : s; };
  return typeof a === "string" && typeof b === "string" && a.length > 0 && k(a) === k(b);
}

// ---- bounded reads ------------------------------------------------------------------------------------------------------------------------
const sameId = (a, b) => !(a.ino && b.ino) || (a.ino === b.ino && a.dev === b.dev);
/**
 * Exact bytes of one regular file, bounded BEFORE any allocation: link-free local path, one link, lstat size <= max (else refused
 * unread), then on the held descriptor: same file and size as inspected, at most size+1 bytes read (growth refused), short read
 * refused, unchanged size/mtime after the read and the path still naming that file. Codes: Absent, BadPath, TooLarge, BadFile, ReadRace.
 */
export function readBoundedFile(file, { max, min = 1, fsImpl = fs, platform = process.platform, what = "file" } = {}) {
  const p = pathProblem(file, platform);
  if (p) throw fail(`${what}: ${p}`, "BadPath");
  let abs, before;
  try { abs = checkLocalPath(file, { fsImpl, platform }); before = fsImpl.lstatSync(abs); }
  catch (e) { throw e.code === "ENOENT" ? fail(`${what}: absent`, "Absent") : fail(`${what}: not a single-link regular file on a link-free local path`, "BadPath"); }
  if (!(before.size <= max)) throw fail(`${what}: above its ${max}-byte bound (refused before reading)`, "TooLarge");
  let fd;
  try { fd = fsImpl.openSync(abs, "r"); } catch { throw fail(`${what}: cannot be opened for reading`, "BadFile"); }
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || !sameId(st, before) || st.size !== before.size) throw fail(`${what}: replaced, linked or resized between inspection and open`, "ReadRace");
    if (st.size > max) throw fail(`${what}: above its ${max}-byte bound`, "TooLarge");
    if (st.size < min) throw fail(`${what}: empty or below ${min} bytes`, "BadFile");
    const buf = Buffer.alloc(st.size + 1); let got = 0;
    while (got < buf.length) { const n = fsImpl.readSync(fd, buf, got, buf.length - got, got); if (!(n > 0)) break; got += n; }
    if (got !== st.size) throw fail(`${what}: ${got > st.size ? "grew" : "shrank"} while being read`, "ReadRace");
    const after = fsImpl.fstatSync(fd);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw fail(`${what}: changed while being read`, "ReadRace");
    let now; try { now = fsImpl.lstatSync(abs); } catch { throw fail(`${what}: path vanished while being read`, "ReadRace"); }
    if (!sameId(now, st) || now.size !== st.size || now.isSymbolicLink()) throw fail(`${what}: path names another file after the read`, "ReadRace");
    return buf.subarray(0, st.size);
  } finally { try { fsImpl.closeSync(fd); } catch {} }
}
/** exact bytes of one pinned regular file: readBoundedFile, then sha256 equal to its pin */
export function readPinnedFile(file, expect, { max, fsImpl = fs, platform = process.platform, what = "file" } = {}) {
  const p = pathProblem(file, platform);
  if (p) throw fail(`${what}: ${p}`, "BadPath");
  if (!HASH.test(String(expect))) throw fail(`${what}: its pin must be 64 lowercase hex`, "BadPin");
  const buf = readBoundedFile(file, { max, fsImpl, platform, what });
  if (sha(buf) !== expect) throw fail(`${what}: sha256 differs from its pin`, "DigestMismatch");
  return buf;
}
export function strictJson(buf, what) {
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { throw fail(`${what} is not strict UTF-8`, "Malformed"); }
  try { return JSON.parse(text); } catch { throw fail(`${what} is not valid JSON`, "Malformed"); }   // never echo the parser's excerpt
}

// ---- legacy r12 obligations of one agent directory (read-only, bounded) ----------------------------------------------------------------------
export const LEGACY_FILES = Object.freeze(["operator-writes.json", "sponsored-obligations.json"]);
export const LEGACY_STORE_SUFFIXES = Object.freeze(["", ".established", ".intent", ".commit", ".history", ".lock"]);
/** -> { files: { <name>: { state: "absent" } | { state: "empty", sha256 } }, problem: null | why new effects must not start } */
export function legacyState(dir, { fsImpl = fs, pathPlatform = "win32" } = {}) {
  const P = pathApi(pathPlatform), files = {};
  for (const name of LEGACY_FILES) {
    let buf;
    try { buf = readBoundedFile(P.join(dir, name), { max: MAX_LEGACY_BYTES, fsImpl, platform: pathPlatform, what: `legacy ${name}` }); }
    catch (e) {
      if (e.code === "Absent") { files[name] = { state: "absent" }; continue; }
      return { files, problem: `legacy ${name} cannot be read within its bounds (${e.code}): settle it explicitly first` };
    }
    let j; try { j = strictJson(buf, `legacy ${name}`); } catch { return { files, problem: `legacy ${name} is malformed: settle it explicitly first` }; }
    if (!plain(j) || !plain(j.records) || Object.keys(j.records).length) return { files, problem: `legacy ${name} holds unresolved records: settle them explicitly first` };
    files[name] = { state: "empty", sha256: sha(buf) };
  }
  for (const sfx of LEGACY_STORE_SUFFIXES) {
    try { fsImpl.lstatSync(P.join(dir, STORE_NAME + sfx)); return { files, problem: `an operator-effects store or its evidence (${STORE_NAME}${sfx}) exists at the legacy default: reconcile it explicitly first` }; }
    catch (e) { if (e.code !== "ENOENT") return { files, problem: `legacy default ${STORE_NAME}${sfx} cannot be inspected` }; }
  }
  return { files, problem: null };
}

// ---- service identity -------------------------------------------------------------------------------------------------------------------------
export const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** principals that may own or write trust inputs: SYSTEM, Administrators, TrustedInstaller */
export const TRUSTED_PRINCIPALS = Object.freeze(["S-1-5-18", "S-1-5-32-544", TRUSTED_INSTALLER_SID]);
/** the SID Windows gives NT SERVICE\<name>: S-1-5-80 + SHA-1(UTF-16LE upper-cased name) as five little-endian 32-bit values */
export function virtualServiceSid(name) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(String(name))) throw fail("service name must be 1..80 ASCII letters, digits, _ . - starting with a letter", "BadServiceIdentity");
  const d = createHash("sha1").update(Buffer.from(String(name).toUpperCase(), "utf16le")).digest();
  return `S-1-5-80-${[0, 4, 8, 12, 16].map((o) => d.readUInt32LE(o)).join("-")}`;
}
/** "NT SERVICE\<name>" -> { account, name, sid, principalType: "virtual-service-account" }; anything else is refused */
export function serviceIdentity(account) {
  const m = /^NT SERVICE\\([A-Za-z][A-Za-z0-9_.-]{0,79})$/i.exec(String(account ?? ""));
  if (!m) throw fail("the service identity must be exactly one per-service virtual account NT SERVICE\\<service name> (never SYSTEM, LocalService/NetworkService, a user, a group, a domain account or a raw SID: their principal type cannot be bound here)", "BadServiceIdentity");
  const sid = virtualServiceSid(m[1]);
  if (TRUSTED_PRINCIPALS.includes(sid)) throw fail("the service identity must not be a trusted writer", "BadServiceIdentity");
  return Object.freeze({ account: `NT SERVICE\\${m[1]}`, name: m[1], sid, principalType: "virtual-service-account" });
}

// ---- explicit SYSTEM identity and its separately specified launcher (r4) ---------------------------------------------------------------------
export const SYSTEM_ACCOUNT = "NT AUTHORITY\\SYSTEM", SYSTEM_SID = "S-1-5-18";
/** groups a LocalSystem token carries; a grant to any of them is a read grant to SYSTEM (SYSTEM is already a trusted writer) */
const SYSTEM_TOKEN_GROUPS = Object.freeze(["S-1-5-32-544", "S-1-1-0", "S-1-5-11"]);
export const LAUNCHER_KEYS = Object.freeze(["kind", "taskPath", "taskName", "specifiedBy"]);
const taskSegmentOk = (s) => typeof s === "string" && /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,63}$/.test(s) && !/[. ]$/.test(s) && !RESERVED.test(s);
/**
 * The scheduled task that LAUNCHES the SYSTEM process, exactly as the local machine owner specified it: { kind: "scheduled-task",
 * taskPath: "\" or "\<folder>\...\" (1..4 folders, <= 200 characters), taskName: one folder-like name, specifiedBy: "local-machine-owner" }.
 * Any bounded owner-chosen task is accepted (\Enclave\Node is one target example, not a required name); no central service approves it.
 * It names the launcher only: the process SID is never derived from it and nothing here observes the task, its process or ancestry.
 */
export function launcherIdentity(l) {
  const bad = (why) => fail(`launcher: ${why}`, "BadLauncherIdentity");
  if (!onlyKeys(l, LAUNCHER_KEYS)) throw bad(`must be exactly { ${LAUNCHER_KEYS.join(", ")} }`);
  if (l.kind !== "scheduled-task") throw bad("kind must be scheduled-task (a Task Scheduler launch, not an SCM service)");
  if (l.specifiedBy !== "local-machine-owner") throw bad("specifiedBy must be local-machine-owner (no central authorization is consulted or required)");
  const p = l.taskPath;
  if (typeof p !== "string" || p.length > 200 || !p.startsWith("\\") || !p.endsWith("\\")) throw bad("taskPath must be \\ or \\<folder>\\...\\ (at most 200 characters)");
  const folders = p === "\\" ? [] : p.slice(1, -1).split("\\");
  if (folders.length > 4 || !folders.every(taskSegmentOk)) throw bad("taskPath has an empty, dot, reserved, over-long or forbidden-character folder, or more than 4 folders");
  if (!taskSegmentOk(l.taskName)) throw bad("taskName must be one 1..64 character name of letters, digits, space, _ . - (no separator, trailing dot/space or reserved name)");
  return Object.freeze({ kind: "scheduled-task", taskPath: p, taskName: l.taskName, specifiedBy: "local-machine-owner" });
}
/**
 * Explicit SYSTEM binding: account exactly NT AUTHORITY\SYSTEM (case-insensitive, rendered canonical), sid exactly S-1-5-18, plus a
 * separately specified launcher. Never a bare "SYSTEM"/"LocalSystem", LocalService/NetworkService, a user, a group or a domain account.
 * Recognising it enables nothing: install, cutover and effects answer systemCutoverUnqualified.
 */
export function systemIdentity({ account, sid, launcher } = {}) {
  if (!/^NT AUTHORITY\\SYSTEM$/i.test(String(account ?? ""))) throw fail("the process identity must be exactly NT AUTHORITY\\SYSTEM (never a bare name, LocalService/NetworkService, a user, a group or a domain account)", "BadProcessIdentity");
  if (sid !== SYSTEM_SID) throw fail(`the process SID of NT AUTHORITY\\SYSTEM must be exactly ${SYSTEM_SID}`, "BadProcessIdentity");
  return Object.freeze({ account: SYSTEM_ACCOUNT, name: null, sid: SYSTEM_SID, principalType: "local-system", launcher: launcherIdentity(launcher) });
}
/** what a SYSTEM cutover must prove and this source does not: none of it is observed, asserted or defaulted here */
export const SYSTEM_CUTOVER_UNPROVEN = Object.freeze(["continuous old-writer exclusion", "effective NODE_DIR of the running process", "scheduled-task-to-process ancestry"]);
/** the ONLY answer for SYSTEM install/cutover/effects in this source; no argument, environment value or Boolean turns it off */
export function systemCutoverUnqualified(where) {
  return Object.assign(fail(`${where}: the SYSTEM binding is recognised but stays refused until a qualified cutover proves ${SYSTEM_CUTOVER_UNPROVEN.join(", ")}`, "CutoverUnqualified"),
    { unproven: [...SYSTEM_CUTOVER_UNPROVEN] });
}
/** read-only probe of the identity of the process that runs it (a PowerShell child inherits this process's token) */
export function currentIdentityProbeScript() {
  return "$ErrorActionPreference='Stop'; @{ sid=[string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress";
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
const SID_ALIAS = Object.freeze({ SY: "S-1-5-18", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547", AO: "S-1-5-32-548",
  SO: "S-1-5-32-549", PO: "S-1-5-32-550", BO: "S-1-5-32-551", RE: "S-1-5-32-552", RU: "S-1-5-32-554", RD: "S-1-5-32-555", NO: "S-1-5-32-556",
  WD: "S-1-1-0", AU: "S-1-5-11", AN: "S-1-5-7", IU: "S-1-5-4", NU: "S-1-5-2", SU: "S-1-5-6", LS: "S-1-5-19", NS: "S-1-5-20", PS: "S-1-5-10",
  RC: "S-1-5-12", WR: "S-1-5-33", ED: "S-1-5-9", CO: "S-1-3-0", CG: "S-1-3-1", OW: "S-1-3-4", AC: "S-1-15-2-1" });
const RIGHT = Object.freeze({ GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100, FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0 });
const GENERIC = [[0x80000000, 0x120089], [0x40000000, 0x120116], [0x20000000, 0x1200a0], [0x10000000, 0x1f01ff]];
/** file rights: FILE_GENERIC_READ; directory read = list + traverse + read attributes/EA/permissions; the installed service state rights */
export const FILE_READ = 0x120089, DIR_READ = 0x1200a9, FULL_CONTROL = 0x1f01ff, STATE_SERVICE_RIGHTS = 0x12019f;
const READ_SAFE = 0x1200a9;                                       // read data/list, read EA, execute/traverse, read attributes, READ_CONTROL, SYNCHRONIZE
const writeBits = (m) => (m & ~READ_SAFE) >>> 0;                  // anything else - including rights this parser does not name - is a write
const replaceBits = (m) => (m & ~(READ_SAFE | 0x2 | 0x4 | 0x10 | 0x100)) >>> 0;   // DELETE_CHILD, DELETE, WRITE_DAC, WRITE_OWNER, unknown
/** groups a virtual service account's token carries; a grant to any of them is a grant to the service */
const SERVICE_TOKEN_GROUPS = Object.freeze(["S-1-1-0", "S-1-5-32-545", "S-1-5-6", "S-1-5-11", "S-1-5-15", "S-1-2-0", "S-1-5-80-0"]);
function rightsMask(t) {
  let m = 0;
  if (/^0x[0-9a-fA-F]{1,8}$/.test(t)) m = parseInt(t, 16) >>> 0;
  else if (/^(?:[A-Z]{2})+$/.test(t)) { for (const k of t.match(/../g)) { if (!Object.hasOwn(RIGHT, k)) return null; m = (m | RIGHT[k]) >>> 0; } }
  else return null;
  for (const [g, f] of GENERIC) if ((m & g) >>> 0) m = (((m & ~g) >>> 0) | f) >>> 0;
  return m >>> 0;
}
/** O:G:D: SDDL (no SACL, no object/conditional ACEs) -> { owner, group, protectedDacl, aces: [{ type, flags:Set, mask, sid }] } or null */
export function parseSddl(s) {
  if (typeof s !== "string" || s.length > 4096) return null;
  const m = /^O:(S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})G:(S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})D:(P?(?:AR)?(?:AI)?)((?:\([^()]*\))+)$/.exec(s);
  if (!m) return null;
  const sidOf = (x) => (/^S-1-[0-9]+(?:-[0-9]+)+$/.test(x) ? x : SID_ALIAS[x] ?? null);
  const owner = sidOf(m[1]), group = sidOf(m[2]);
  if (!owner || !group) return null;
  const aces = [];
  for (const body of m[4].slice(1, -1).split(")(")) {
    const f = body.split(";");
    if (f.length !== 6 || (f[0] !== "A" && f[0] !== "D") || f[3] !== "" || f[4] !== "" || !/^(?:OI|CI|NP|IO|ID)*$/.test(f[1])) return null;
    const mask = rightsMask(f[2]), sid = sidOf(f[5]);
    if (mask === null || !sid) return null;
    aces.push(Object.freeze({ type: f[0], flags: new Set(f[1].match(/../g) ?? []), mask, sid }));
  }
  return { owner, group, protectedDacl: m[3].startsWith("P"), aces };
}
/**
 * One OBSERVED SDDL read for the bound service SID -> null or the problem. Always: owner SYSTEM/Administrators/TrustedInstaller.
 *   deny "write": no other principal holds any right beyond read (write data, append, EA/attributes, delete, delete child, re-permission);
 *   deny "replace": no other principal may delete, delete children (rename/replace below), re-permission or take ownership;
 *   read: the rights the service SID (or a group every service token carries) must be granted, with no deny of them;
 *   protectedDacl / noBroad: as sddlProblem.
 * An ACL reading, not a native AccessCheck under the service token.
 */
export function aclProblem(sddl, { serviceSid, read = 0, deny = "write", protectedDacl = false, noBroad = false } = {}) {
  const a = parseSddl(sddl);
  if (!a) return "ACL unreadable or in an unrecognised form";
  if (!TRUSTED_PRINCIPALS.includes(a.owner)) return "owner is not SYSTEM, Administrators or TrustedInstaller (an owner can always rewrite the ACL)";
  if (protectedDacl && !a.protectedDacl) return "DACL must be protected (inheritance disabled)";
  if (noBroad) { const p = sddlProblem(sddl); if (p) return p; }
  const bits = deny === "replace" ? replaceBits : writeBits;
  for (const e of a.aces) {
    if (e.type !== "A" || e.flags.has("IO") || TRUSTED_PRINCIPALS.includes(e.sid)) continue;
    if (bits(e.mask)) return `${e.sid === serviceSid ? "the service identity" : `principal ${e.sid}`} may ${deny === "replace" ? "delete, rename or re-permission" : "write, delete or re-permission"} it`;
  }
  if (read) {
    const token = new Set([serviceSid, ...(serviceSid === SYSTEM_SID ? SYSTEM_TOKEN_GROUPS : SERVICE_TOKEN_GROUPS)]);
    let allow = 0, denied = 0;
    for (const e of a.aces) {
      if (e.flags.has("IO") || !token.has(e.sid)) continue;
      if (e.type === "A") allow = (allow | e.mask) >>> 0; else denied = (denied | e.mask) >>> 0;
    }
    if (((allow & read) >>> 0) !== read || ((denied & read) >>> 0) !== 0) return "the service identity is not granted the read it needs";
  }
  return null;
}
/** the installed state ACL, exactly: owner BA/SY; SYSTEM + Administrators full control, the service SID Read+Write (0x12019f, no Delete).
 *  r4: for the SYSTEM binding SYSTEM is itself the trusted full-control entry, so the ACL is exactly those TWO entries (no second SYSTEM). */
export function stateAclProblem(sddl, serviceSid, { directory }) {
  const a = parseSddl(sddl);
  if (!a) return "state ACL unreadable or in an unrecognised form";
  if (a.owner !== "S-1-5-32-544" && a.owner !== "S-1-5-18") return "state owner must be Administrators or SYSTEM";
  if (directory && !a.protectedDacl) return "state directory DACL must be protected (inheritance disabled)";
  const flags = directory ? "CI,OI" : "ID", system = serviceSid === SYSTEM_SID;
  const want = [["S-1-5-18", FULL_CONTROL], ["S-1-5-32-544", FULL_CONTROL], ...(system ? [] : [[serviceSid, STATE_SERVICE_RIGHTS]])];
  if (a.aces.length !== want.length) return system ? "SYSTEM state ACL must hold exactly the SYSTEM and Administrators entries" : "state ACL must hold exactly the SYSTEM, Administrators and service-identity entries";
  for (const [sid, mask] of want) {
    const e = a.aces.filter((x) => x.sid === sid);
    if (e.length !== 1 || e[0].type !== "A" || e[0].mask !== mask || [...e[0].flags].sort().join(",") !== flags)
      return system ? `SYSTEM state ACL must grant exactly SYSTEM and Administrators full control (${sid} entry differs)`
        : `state ACL must grant SYSTEM and Administrators full control and exactly the bound service identity Read+Write without Delete (${sid === serviceSid ? "service" : sid} entry differs)`;
  }
  return null;
}

// ---- the configuration ---------------------------------------------------------------------------------------------------------------------
const CONFIG_KEYS = ["schema", "store", "domain", "instance", "storage", "runtime", "exclusion"];
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
  const system = onlyKeys(j.instance, ["processAccount", "processSid", "launcher", "nodeDir"]);   // r4 explicit SYSTEM form
  if (!system && !onlyKeys(j.instance, ["serviceAccount", "serviceSid", "nodeDir"]))
    throw fail("config instance must be exactly { serviceAccount, serviceSid, nodeDir } or the SYSTEM form { processAccount, processSid, launcher, nodeDir }", "Malformed");
  let id;
  if (system) {
    try { id = systemIdentity({ account: j.instance.processAccount, sid: j.instance.processSid, launcher: j.instance.launcher }); } catch (e) { throw fail(`config instance: ${e.message}`, e.code); }
    if (j.instance.processAccount !== id.account) throw fail("config instance processAccount must be the canonical NT AUTHORITY\\SYSTEM", "BadProcessIdentity");
  } else {
    try { id = serviceIdentity(j.instance.serviceAccount); } catch (e) { throw fail(`config instance: ${e.message}`, "BadServiceIdentity"); }
    if (j.instance.serviceAccount !== id.account || j.instance.serviceSid !== id.sid) throw fail("config instance serviceSid is not the SID of its NT SERVICE account", "BadServiceIdentity");
  }
  const np = pathProblem(j.instance.nodeDir, pathPlatform);
  if (np) throw fail(`config instance nodeDir: ${np}`, "BadPath");
  if (sameOrInside(j.instance.nodeDir, stateDir, pathPlatform) || sameOrInside(stateDir, j.instance.nodeDir, pathPlatform)) throw fail("config store and the agent's NODE_DIR must be separate directories", "BadPath");
  if (!onlyKeys(j.storage, ["sddl", "parentSddl"])) throw fail("config storage must be exactly { sddl, parentSddl }", "Malformed");
  const fileSddl = sddlProblem(j.storage.sddl) || stateAclProblem(j.storage.sddl, id.sid, { directory: false });
  const dirSddl = sddlProblem(j.storage.parentSddl, { protectedDacl: true }) || stateAclProblem(j.storage.parentSddl, id.sid, { directory: true });
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
  return deepFreeze({ schema: CONFIG_SCHEMA, store: j.store, stateDir, domain: { ...domain },
    instance: system ? { processAccount: id.account, processSid: id.sid, principalType: id.principalType, launcher: { ...id.launcher }, nodeDir: j.instance.nodeDir }
      : { serviceAccount: id.account, serviceSid: id.sid, nodeDir: j.instance.nodeDir }, storage: { sddl: j.storage.sddl, parentSddl: j.storage.parentSddl },
    runtime: { ...j.runtime }, exclusion: { ...x } });
}
/** the exact canonical bytes the installer writes (fixed key order, 2-space JSON, final newline). It renders what it is given: an
 *  absent instance renders as null, which parseOperatorEffectsConfig refuses. r4: an instance with processAccount renders the SYSTEM form. */
export function configBytes({ store, domain, instance, storage, exclusion }) {
  const l = instance?.launcher;
  return Buffer.from(JSON.stringify({ schema: CONFIG_SCHEMA, store, domain: { account: domain.account, chainId: domain.chainId },
    instance: !instance ? null : Object.hasOwn(instance, "processAccount")
      ? { processAccount: instance.processAccount, processSid: instance.processSid,
          launcher: l ? { kind: l.kind, taskPath: l.taskPath, taskName: l.taskName, specifiedBy: l.specifiedBy } : null, nodeDir: instance.nodeDir }
      : { serviceAccount: instance.serviceAccount, serviceSid: instance.serviceSid, nodeDir: instance.nodeDir },
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
/** -> { production, platform, pathPlatform, openPlatform, fsImpl, agentDir, runtime(), run(), now(), unresolved() } */
export function ioOf(TEST) {
  if (TEST === undefined) {
    const platform = process.platform;
    return { production: true, platform, pathPlatform: platform, openPlatform: platform, fsImpl: fs, agentDir: AGENT_DIR,
      runtime: () => ({ platform, version: process.version, execPath: process.execPath, execSha256: execSha256(process.execPath) }),
      // the reviewed absolute PowerShell path (psrun.mjs default); never selected by PATH or the environment
      run: () => powershellRunner({ timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES }),
      now: () => Date.now(), unresolved: () => unresolvedProcesses() };
  }
  if (!plain(TEST) || TEST.label !== TEST_LABEL || process.platform === "win32") throw fail(`TEST injection must be labelled ${TEST_LABEL} and is refused on Windows`, "TestRefused");
  return { production: false, platform: TEST.runtime?.platform, pathPlatform: TEST.pathPlatform ?? "linux", openPlatform: TEST.openPlatform ?? TEST.runtime?.platform,
    fsImpl: TEST.fsImpl ?? fs, agentDir: TEST.agentDir ?? AGENT_DIR, runtime: () => TEST.runtime, run: () => TEST.run,
    now: () => (typeof TEST.now === "function" ? TEST.now() : Date.now()), unresolved: () => (typeof TEST.unresolved === "function" ? TEST.unresolved() : { count: 0, tracked: [] }) };
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
/** the agent's actual NODE_DIR, exactly as agent.mjs computes DIR */
export const actualNodeDir = (env, agentDir) => env?.NODE_DIR || agentDir;
/** the probe child (same token as this process) must report the configured service SID */
async function assertRunningAs(run, serviceSid) {
  let r, j = null;
  try { r = await run(currentIdentityProbeScript()); j = JSON.parse(String(r?.stdout || "").trim()); } catch { j = null; }
  if (r?.code !== 0 || !plain(j) || j.sid !== serviceSid)
    throw fail("this process does not run as the configured service identity, or its identity could not be observed: no operator effect", "ServiceIdentityMismatch");
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
 * r2: the actual NODE_DIR must be the installed instance's, its legacy obligations must be clear, and storage.run proves the running
 * service SID before the storage probe.
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
    // r4: a well-formed SYSTEM binding is recognised and refused HERE, before NODE_DIR, legacy files, exclusion or any probe is consulted
    if (config.instance.principalType === "local-system") throw systemCutoverUnqualified("operator effects as NT AUTHORITY\\SYSTEM");
    if (!sameDir(config.instance.nodeDir, actualNodeDir(env, io.agentDir), io.pathPlatform))
      throw fail("this agent's NODE_DIR is not the directory the store was installed for: refused (a new store never bypasses another directory's obligations)", "InstanceMismatch");
    const legacy = legacyState(config.instance.nodeDir, { fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
    if (legacy.problem) throw fail(legacy.problem, "LegacyObligations");
    const exclusion = qualifiedExclusion({ config, runtime: io.runtime(), fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
    const gate = domainGate(config.domain, actualDomain), run = io.run(), serviceSid = config.instance.serviceSid;
    if (typeof run !== "function") throw fail("the bounded storage probe runner is unavailable", "StorageUnqualified");
    const option = Object.freeze({ file: config.store, backend: "windows-owned-log", platform: io.openPlatform, fsImpl: io.fsImpl,
      exclusion: Object.freeze({ name: exclusion.name, basis: exclusion.basis, open(f) { gate(); return exclusion.open(f); } }),
      storage: Object.freeze({ run: async (script) => { gate(); await assertRunningAs(run, serviceSid); return run(script); }, sddl: config.storage.sddl, parentSddl: config.storage.parentSddl }) });
    return Object.freeze({ state: "configured", reason: null, configSha256: sha256, production: io.production, store: config.store, option });
  } catch (e) { return refusedOperatorEffects(e); }
}
