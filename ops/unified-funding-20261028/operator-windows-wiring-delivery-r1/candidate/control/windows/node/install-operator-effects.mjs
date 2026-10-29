// install-operator-effects.mjs - the EXPLICIT Windows installer/preflight of the owned operator-effects store (operator Windows wiring r1,
// SOURCE ONLY, AUTHORED, NOT RUN: no plan, apply, PowerShell or Windows step has executed). Separate from normal startup: the agent never
// imports this file and never creates, resets or migrates a store.
//
//   node install-operator-effects.mjs --plan  <inputs>                                  (default; read-only, writes NOTHING)
//   node install-operator-effects.mjs --apply --confirm install-operator-effects-store <inputs>
//   inputs: --state-dir C:\ProgramData\Enclave\operator-effects --account 0x<public operator address> --chain-id 8453
//           --service-account "NT SERVICE\<agent service>" --config-out C:\ProgramData\Enclave\config\operator-effects.json
//           --legacy-dir <the agent's NODE_DIR, where r12 operator-writes.json / sponsored-obligations.json lived>
//           --qualification-file <root EXLOCK record> --qualification-sha256 <hex> --evidence-file <its evidence> --evidence-sha256 <hex>
//           --release-manifest <release pin file> --release-manifest-sha256 <hex>
// Only a PUBLIC account is accepted; no operator key is read, derived or exported.
//
// PREFLIGHT (plan and the first stage of apply; read-only): strict inputs; Windows only; the state directory, store, config and receipt
// must ALL be absent (an existing one is reported as already-established or incomplete, never touched); release manifest pins every
// file of the install/runtime chain; the ACTUAL runtime equals NODE_RUNTIME_PIN and the pinned qualification + evidence build THE SAME
// windowsNumericExclusion the agent builds (operator-effects-config.mjs qualifiedExclusion); legacy r12 obligation files hold no records
// and no store/evidence sits at the legacy default; the state parent and config directories are link-free directories on fixed NTFS.
//
// APPLY (only with the confirmation string), in order, stopping at the first failure with everything created PRESERVED:
//   1 create the NEW state directory with a protected DACL (inheritance off; SYSTEM + Administrators full; the service account
//     Read+Write, no Delete; owner Administrators) in one CreateDirectory(path, DirectorySecurity) call; it must not exist before;
//   2 verify it: empty, protected DACL without broad principals, no reparse in any ancestor, fixed NTFS;
//   3 initializeOwnedLog (purpose enclave-operator-effects/1; wx refuses an existing file);
//   4 observe the journal's ACL (the circularity: a file SDDL exists only after creation), check it against policy and the directory just
//     verified, then run the RUNTIME checkWindowsStorage against those observed values;
//   5 establish the domain under the qualified exclusion (the exact row initializeOperatorEffects/openOperatorEffects use);
//   6 open it through the RUNTIME openOperatorEffects with the same exclusion and storage options (zero records), release;
//   7 write the config (wx, never over an existing file), re-read it through the runtime loader and rebuild the exclusion from it;
//   8 write the sanitized receipt beside the config (wx).
// It does NOT register services/tasks, set machine environment (ENCLAVE_OPERATOR_EFFECTS_CONFIG / _SHA256), restart anything, cut a host
// over, change grants, touch the network or delete anything. A rerun after any partial step refuses (IncompleteInstall) and leaves
// every byte for explicit investigation.
//
// TEST (portable tests only): an explicit TEST object labelled TEST-ONLY-NOT-WINDOWS (ioOf) may inject runtime/fs/PowerShell, a
// createStateDir hook, a releaseRoot and TEST_inProcessExclusion for the journal opens. Refused on win32; receipts say production:false.
// A TEST apply proves the sequencing and refusals only - never Windows ACLs, EXLOCK, NTFS or power-loss behaviour.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeOwnedLog, openOwnedLog, checkWindowsStorage, storageProbeScript } from "../vbslike/manager/win-durable.mjs";
import { NODE_RUNTIME_PIN } from "../vbslike/manager/win-exclusion.mjs";
import { OPERATOR_EFFECTS_PURPOSE, STATE_SCHEMA, normalizeDomain, openOperatorEffects } from "./operator-effects.mjs";
import { STORE_NAME, CONFIG_ENV, CONFIG_SHA256_ENV, MAX_CONFIG_BYTES, fail, ioOf, pathProblem, pathApi, sameOrInside, readPinnedFile, strictJson,
  sddlProblem, parseOperatorEffectsConfig, configBytes, qualifiedExclusion, NOT_QUALIFICATION } from "./operator-effects-config.mjs";

export const PLAN_SCHEMA = "enclave-operator-effects-install-plan/1";
export const RECEIPT_SCHEMA = "enclave-operator-effects-install-receipt/1";
export const RELEASE_SCHEMA = "enclave-operator-effects-release/1";
export const APPLY_CONFIRM = "install-operator-effects-store";
/** every file of the install + runtime chain the release manifest must pin (it may pin more) */
export const RELEASE_FILES = Object.freeze([
  "control/windows/node/agent.mjs", "control/windows/node/host.mjs", "control/windows/node/chain.mjs",
  "control/windows/node/operator-effects.mjs", "control/windows/node/operator-effects-config.mjs", "control/windows/node/install-operator-effects.mjs",
  "control/windows/node/lease-gas-runtime.bundle.mjs", "control/windows/vbslike/manager/win-durable.mjs",
  "control/windows/vbslike/manager/win-exclusion.mjs", "control/windows/vbslike/manager/psrun.mjs",
]);
const RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_RELEASE_MANIFEST = 64 * 1024, MAX_RELEASE_FILE = 32 * 1024 * 1024, MAX_LEGACY_BYTES = 8 * 1024 * 1024, MAX_RECEIPT_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const SERVICE_ACCOUNT = /^(NT SERVICE\\[A-Za-z][A-Za-z0-9_.-]{0,79}|S-1-5-80(-[0-9]{1,10}){5}|S-1-5-18|NT AUTHORITY\\SYSTEM|\.\\[A-Za-z0-9_.-]{1,20}|[A-Za-z0-9-]{1,15}\\[A-Za-z0-9_.-]{1,20})$/;
const BROAD_ACCOUNT = /^(BUILTIN\\|NT AUTHORITY\\(?!SYSTEM$))|\\(users|everyone|guests|authenticated users|domain users)$/i;
const INPUT_KEYS = ["stateDir", "account", "chainId", "serviceAccount", "configOut", "legacyDir", "qualificationFile", "qualificationSha256",
  "evidenceFile", "evidenceSha256", "releaseManifest", "releaseManifestSha256"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sanitize = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
export const receiptPath = (configOut) => `${configOut}.install-receipt.json`;

// ---- bounded, read-only PowerShell probes and the one creation script (all through psrun.mjs powershellRunner) ----------------------------
export function directoryProbeScript(dir) {
  const d = q(dir);
  return `$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath ${d})) { '{"exists":false}'; return }
    $i = Get-Item -LiteralPath ${d} -Force; $v = Get-Volume -FilePath ${d}; $rp = $false; $a = $i;
    while ($a) { if ($a.Attributes -band [IO.FileAttributes]::ReparsePoint) { $rp = $true }; $a = $a.Parent }
    @{ exists=$true; directory=[bool]$i.PSIsContainer; reparse=$rp; fileSystem=[string]$v.FileSystem; driveType=[string]$v.DriveType;
       sddl=(Get-Acl -LiteralPath ${d}).Sddl; entries=@(Get-ChildItem -LiteralPath ${d} -Force).Count } | ConvertTo-Json -Compress`.replace(/\r?\n\s*/g, " ");
}
/** ONE CreateDirectory(path, DirectorySecurity): protected DACL from the first instant; refuses an existing path */
export function createStateDirScript(dir, account) {
  return `$ErrorActionPreference='Stop'; $d = ${q(dir)}; $n = ${q(account)};
    if (Test-Path -LiteralPath $d) { throw 'state directory already exists' }
    if ($n -like 'S-1-*') { $sid = New-Object Security.Principal.SecurityIdentifier($n) } else { $sid = (New-Object Security.Principal.NTAccount($n)).Translate([Security.Principal.SecurityIdentifier]) }
    $inh = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'; $np = [Security.AccessControl.PropagationFlags]::None; $al = [Security.AccessControl.AccessControlType]::Allow;
    $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetAccessRuleProtection($true, $false);
    $s.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));
    foreach ($p in @('S-1-5-18', 'S-1-5-32-544')) { $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p)), [Security.AccessControl.FileSystemRights]'FullControl', $inh, $np, $al))) }
    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]'Read, Write', $inh, $np, $al)));
    [void][IO.Directory]::CreateDirectory($d, $s);
    @{ created=$true; serviceSid=[string]$sid.Value } | ConvertTo-Json -Compress`.replace(/\r?\n\s*/g, " ");
}
async function psJson(run, script, what) {
  const r = await run(script);
  let j; try { j = JSON.parse(String(r.stdout || "").trim()); } catch { throw fail(`${what}: the probe returned no JSON`, "ProbeFailed"); }
  if (r.code !== 0) throw fail(`${what}: the probe failed (${r.code})`, "ProbeFailed");   // raw stderr is never echoed
  return j;
}
async function probeDir(run, dir, what) {
  const d = await psJson(run, directoryProbeScript(dir), what);
  if (d.exists !== true || d.directory !== true) throw fail(`${what}: not an existing directory`, "BadPath");
  if (d.reparse !== false || d.fileSystem !== "NTFS" || d.driveType !== "Fixed") throw fail(`${what}: must be link-free on a fixed NTFS volume`, "StorageUnqualified");
  return d;
}
function noLinkAncestors(dir, io) {
  const P = pathApi(io.pathPlatform);
  for (let cur = dir; ; cur = P.dirname(cur)) {
    let st; try { st = io.fsImpl.lstatSync(cur); } catch { throw fail("a state path ancestor cannot be inspected", "BadPath"); }
    if (st.isSymbolicLink()) throw fail("reparse point or symbolic link in a state path ancestor", "BadPath");
    if (P.dirname(cur) === cur) return;
  }
}
function writeNew(fsImpl, file, bytes) {
  const fd = fsImpl.openSync(file, "wx", 0o600);   // never over an existing file
  try {
    let off = 0;
    while (off < bytes.length) { const n = fsImpl.writeSync(fd, bytes, off, bytes.length - off, off); if (n <= 0) throw Error("short write"); off += n; }
    fsImpl.fsyncSync(fd);
  } finally { fsImpl.closeSync(fd); }
}

// ---- inputs, existing state, release, legacy ---------------------------------------------------------------------------------------------
export function validateInputs(input, io) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== INPUT_KEYS.length || !INPUT_KEYS.every((k) => typeof input[k] === "string"))
    throw fail(`installer inputs must be exactly ${INPUT_KEYS.join(", ")} (strings)`, "BadInput");
  const P = pathApi(io.pathPlatform);
  for (const k of ["stateDir", "configOut", "legacyDir", "qualificationFile", "evidenceFile", "releaseManifest"]) { const p = pathProblem(input[k], io.pathPlatform); if (p) throw fail(`${k}: ${p}`, "BadPath"); }
  for (const k of ["qualificationSha256", "evidenceSha256", "releaseManifestSha256"]) if (!HASH.test(input[k])) throw fail(`${k} must be 64 lowercase hex`, "BadPin");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.account) || /^0x0{40}$/.test(input.account)) throw fail("account must be a public non-zero operator address (never a key)", "BadDomain");
  if (!/^[1-9][0-9]{0,14}$/.test(input.chainId)) throw fail("chainId must be a positive integer", "BadDomain");
  const domain = normalizeDomain({ account: input.account, chainId: Number(input.chainId) });
  if (!SERVICE_ACCOUNT.test(input.serviceAccount) || BROAD_ACCOUNT.test(input.serviceAccount)) throw fail("serviceAccount must name exactly one service identity (NT SERVICE\\name, a service SID, SYSTEM or one account), never a group", "BadInput");
  const store = P.join(input.stateDir, STORE_NAME);
  if (P.relative(P.parse(input.stateDir).root, input.stateDir).split(P.sep).filter(Boolean).length < 2) throw fail("stateDir must be a dedicated directory at least two levels below the volume root", "BadPath");
  if (!/^[A-Za-z0-9_.-]{1,64}\.json$/.test(P.basename(input.configOut))) throw fail("configOut must name a .json file", "BadPath");
  for (const k of ["configOut", "qualificationFile", "evidenceFile", "releaseManifest", "legacyDir"])
    if (sameOrInside(input[k], input.stateDir, io.pathPlatform)) throw fail(`${k} must not be (or live in) the store's writable state directory`, "BadPath");
  // the same exclusion-input rules parseOperatorEffectsConfig enforces, checked BEFORE anything is created
  if (sameOrInside(input.qualificationFile, input.evidenceFile, io.pathPlatform)) throw fail("qualification record and its evidence must be distinct files", "BadPath");
  for (const k of ["qualificationSha256", "evidenceSha256"])
    if (NOT_QUALIFICATION.includes(input[k])) throw fail(`${k} names a reviewed cross-build artifact: build evidence is not Windows qualification`, "QualificationRefused");
  return Object.freeze({ ...input, domain, store, exclusion: Object.freeze({ kind: "numeric-qualified", qualificationFile: input.qualificationFile,
    qualificationSha256: input.qualificationSha256, evidenceFile: input.evidenceFile, evidenceSha256: input.evidenceSha256 }) });
}
/** read-only: absent | already-established (receipt matches config bytes) | incomplete-or-foreign. Never modifies anything. */
export function inspectInstall(v, io) {
  const has = (f) => { try { io.fsImpl.lstatSync(f); return true; } catch (e) { return e.code === "ENOENT" ? false : null; } };
  const s = { stateDir: has(v.stateDir), store: has(v.store), config: has(v.configOut), receipt: has(receiptPath(v.configOut)) };
  if (Object.values(s).every((x) => x === false)) return { state: "absent", ...s };
  if (Object.values(s).every((x) => x === true)) {
    try {
      const cfg = io.fsImpl.readFileSync(v.configOut), rec = io.fsImpl.readFileSync(receiptPath(v.configOut));
      if (cfg.length <= MAX_CONFIG_BYTES && rec.length <= MAX_RECEIPT_BYTES) {
        const r = strictJson(rec, "install receipt");
        if (r.schema === RECEIPT_SCHEMA && r.configSha256 === sha(cfg) && r.store === v.store && r.domain?.account === v.domain.account && r.domain?.chainId === v.domain.chainId)
          return { state: "already-established", configSha256: r.configSha256, ...s };
      }
    } catch { /* falls through: not a complete matching install */ }
  }
  return { state: "incomplete-or-foreign", ...s };
}
function verifyRelease(v, io, root) {
  const m = strictJson(readPinnedFile(v.releaseManifest, v.releaseManifestSha256, { max: MAX_RELEASE_MANIFEST, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "release manifest" }), "release manifest");
  if (!m || typeof m !== "object" || Object.keys(m).length !== 2 || m.schema !== RELEASE_SCHEMA || !m.files || typeof m.files !== "object" || Array.isArray(m.files))
    throw fail("release manifest must be exactly { schema, files }", "Malformed");
  const names = Object.keys(m.files);
  if (names.length > 256) throw fail("release manifest pins too many files", "Malformed");
  for (const f of RELEASE_FILES) if (!names.includes(f)) throw fail(`release manifest does not pin ${f}`, "ReleaseUnpinned");
  const P = pathApi(io.pathPlatform);
  for (const rel of names) {
    if (!/^control\/[A-Za-z0-9_./-]+$/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw fail("release manifest names an unsafe path", "Malformed");
    readPinnedFile(P.join(root, ...rel.split("/")), m.files[rel], { max: MAX_RELEASE_FILE, fsImpl: io.fsImpl, platform: io.pathPlatform, what: `release file ${rel}` });
  }
  return names.length;
}
function legacyProblem(v, io) {
  const P = pathApi(io.pathPlatform);
  for (const name of ["operator-writes.json", "sponsored-obligations.json"]) {
    const f = P.join(v.legacyDir, name);
    let st; try { st = io.fsImpl.lstatSync(f); } catch (e) { if (e.code === "ENOENT") continue; return `${name} cannot be inspected`; }
    if (!st.isFile() || st.size > MAX_LEGACY_BYTES) return `${name} is not a bounded regular file`;
    let j; try { j = JSON.parse(io.fsImpl.readFileSync(f, "utf8")); } catch { return `${name} is unreadable or malformed`; }
    if (!j?.records || typeof j.records !== "object" || Array.isArray(j.records) || Object.keys(j.records).length) return `${name} holds unresolved records: settle them explicitly first`;
  }
  for (const sfx of ["", ".established", ".intent", ".commit", ".history", ".lock"]) {
    try { io.fsImpl.lstatSync(P.join(v.legacyDir, STORE_NAME + sfx)); return `an operator-effects store or its evidence (${STORE_NAME}${sfx}) exists at the legacy default: reconcile it explicitly first`; }
    catch (e) { if (e.code !== "ENOENT") return `legacy default ${STORE_NAME}${sfx} cannot be inspected`; }
  }
  return null;
}

// ---- plan / apply ------------------------------------------------------------------------------------------------------------------------------
async function preflight(input, TEST) {
  const io = ioOf(TEST), checks = [];
  const v = validateInputs(input, io); checks.push("inputs");
  if (io.platform !== "win32") throw fail("the operator-effects installer is Windows-only", "UnsupportedPlatform");
  const existing = inspectInstall(v, io);
  if (existing.state === "already-established") throw Object.assign(fail("already established (state, store, config and a matching receipt exist): nothing changed; activation and review are separate steps", "AlreadyEstablished"), { existing });
  if (existing.state !== "absent") throw Object.assign(fail("an incomplete or foreign installation exists: PRESERVED for explicit investigation; nothing is replaced, reset or deleted", "IncompleteInstall"), { existing });
  checks.push("nothing-exists");
  const releaseFiles = verifyRelease(v, io, TEST?.releaseRoot ?? RELEASE_ROOT); checks.push("release-pinned");
  const runtime = io.runtime();
  const exclusion = qualifiedExclusion({ config: { exclusion: v.exclusion }, runtime, fsImpl: io.fsImpl, pathPlatform: io.pathPlatform }); checks.push("runtime-pin+qualification+exclusion");
  const lp = legacyProblem(v, io);
  if (lp) throw fail(lp, "LegacyObligations");
  checks.push("legacy-clear");
  const run = io.run();
  if (typeof run !== "function") throw fail("the bounded PowerShell runner is unavailable", "StorageUnqualified");
  const P = pathApi(io.pathPlatform);
  await probeDir(run, P.dirname(v.stateDir), "state parent directory"); noLinkAncestors(P.dirname(v.stateDir), io); checks.push("state-parent");
  const cfgDir = await probeDir(run, P.dirname(v.configOut), "config directory");
  const cp = sddlProblem(cfgDir.sddl);
  if (cp) throw fail(`config directory ACL refused: ${cp}`, "StorageUnqualified");
  checks.push("config-directory");
  const plan = Object.freeze({ schema: PLAN_SCHEMA, mode: "plan", writes: "none", production: io.production, store: v.store, stateDir: v.stateDir,
    configOut: v.configOut, receipt: receiptPath(v.configOut), domain: { ...v.domain }, serviceAccount: v.serviceAccount, runtimePin: { ...NODE_RUNTIME_PIN },
    exclusionBasis: exclusion.basis, qualificationSha256: v.qualificationSha256, evidenceSha256: v.evidenceSha256, releaseManifestSha256: v.releaseManifestSha256,
    releaseFiles, checks, apply: ["create-state-directory", "verify-state-directory", "create-journal", "observe-and-pin-journal-acl", "establish-domain",
      "verify-runtime-open", "validate-config-bytes", "write-config", "verify-config", "write-receipt"],
    notPerformed: ["service/task registration", `machine environment ${CONFIG_ENV} / ${CONFIG_SHA256_ENV}`, "service or app restart", "host cutover", "grant changes", "network"] });
  return { plan, v, io, run, exclusion };
}
/** read-only preflight -> sanitized plan (throws a coded refusal) */
export async function planOperatorEffectsInstall(input, { TEST } = {}) { return (await preflight(input, TEST)).plan; }

/** explicit apply -> sanitized receipt; any failure throws IncompleteInstall naming completed steps; nothing created is ever deleted */
export async function applyOperatorEffectsInstall(input, { confirm, TEST } = {}) {
  if (confirm !== APPLY_CONFIRM) throw fail(`explicit apply requires --confirm ${APPLY_CONFIRM}; nothing changed`, "NotConfirmed");
  const { plan, v, io, run, exclusion } = await preflight(input, TEST);
  // the journal opens use the qualified exclusion; a labelled TEST run may substitute TEST_inProcessExclusion (never in production)
  const ex = io.production ? exclusion : (TEST.exclusion ?? exclusion);
  const done = [];
  const step = async (name, f) => {
    try { const r = await f(); done.push(name); return r; }
    catch (e) { throw Object.assign(fail(`install stopped at ${name} after [${done.join(", ") || "nothing"}]: ${sanitize(e.message)}. Everything created so far is PRESERVED; a rerun refuses until it is investigated explicitly`, "IncompleteInstall"), { completed: [...done], failedStep: name }); }
  };
  await step("create-state-directory", async () => {
    if (!io.production) return TEST.createStateDir(v.stateDir, v.serviceAccount);
    const r = await psJson(run, createStateDirScript(v.stateDir, v.serviceAccount), "state directory creation");
    if (r.created !== true) throw fail("state directory creation not confirmed");
  });
  const dir = await step("verify-state-directory", async () => {
    const d = await probeDir(run, v.stateDir, "state directory");
    if (d.entries !== 0) throw fail("the new state directory is not empty");
    const p = sddlProblem(d.sddl, { protectedDacl: true });
    if (p) throw fail(`state directory ACL refused: ${p}`);
    noLinkAncestors(v.stateDir, io);
    return d;
  });
  await step("create-journal", () => initializeOwnedLog(v.store, { purpose: OPERATOR_EFFECTS_PURPOSE, fsImpl: io.fsImpl }));
  const storage = await step("observe-and-pin-journal-acl", async () => {
    const j = await psJson(run, storageProbeScript(v.store), "journal storage");
    if (j.reparse !== false || j.fileSystem !== "NTFS" || j.driveType !== "Fixed") throw fail("journal must be a non-reparse file on a fixed NTFS volume");
    if (j.parentSddl !== dir.sddl) throw fail("the state directory ACL changed after it was verified");
    const p = sddlProblem(j.sddl);
    if (p) throw fail(`journal ACL refused: ${p}`);
    const s = { sddl: j.sddl, parentSddl: j.parentSddl };
    await checkWindowsStorage(run, v.store, s);   // the RUNTIME check, against exactly the values that will be pinned
    return s;
  });
  await step("establish-domain", () => {
    const log = openOwnedLog(v.store, { purpose: OPERATOR_EFFECTS_PURPOSE, exclusion: ex, fsImpl: io.fsImpl, platform: io.openPlatform });
    try {
      if (log.failed() || log.ambiguous()) throw fail(`new operator-effects log not usable: ${log.failed() || "torn"}`);
      log.append("operator-effects-established", { schema: STATE_SCHEMA, domain: { ...v.domain } });   // the row initializeOperatorEffects writes
    } finally { log.release(); }
  });
  await step("verify-runtime-open", async () => {
    const s = await openOperatorEffects(v.store, { domain: v.domain, backend: "windows-owned-log", platform: io.openPlatform, exclusion: ex, fsImpl: io.fsImpl, storage: { run, ...storage } });
    try { if (s.records().length !== 0) throw fail("the new store is not empty"); } finally { await s.release("install verification"); }
  });
  const bytes = configBytes({ store: v.store, domain: v.domain, storage, exclusion: v.exclusion }), configSha256 = sha(bytes);
  await step("validate-config-bytes", () => { if (parseOperatorEffectsConfig(bytes, { pathPlatform: io.pathPlatform }).store !== v.store) throw fail("config round trip differs"); });
  await step("write-config", () => writeNew(io.fsImpl, v.configOut, bytes));
  await step("verify-config", () => {
    const back = readPinnedFile(v.configOut, configSha256, { max: MAX_CONFIG_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "written config" });
    qualifiedExclusion({ config: parseOperatorEffectsConfig(back, { pathPlatform: io.pathPlatform }), runtime: io.runtime(), fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
  });
  const receipt = { schema: RECEIPT_SCHEMA, production: io.production, ...(io.production ? {} : { label: "TEST-ONLY-NOT-WINDOWS: not an installation, not Windows qualification" }),
    store: v.store, domain: { ...v.domain }, storage: { ...storage }, configFile: v.configOut, configSha256, qualificationSha256: v.qualificationSha256,
    evidenceSha256: v.evidenceSha256, releaseManifestSha256: v.releaseManifestSha256, runtimePin: { ...NODE_RUNTIME_PIN }, exclusionBasis: exclusion.basis,
    steps: [...done, "write-receipt"], activation: { performed: false, reviewedStepSets: { [CONFIG_ENV]: v.configOut, [CONFIG_SHA256_ENV]: configSha256 } },
    notPerformed: plan.notPerformed, at: new Date().toISOString() };
  await step("write-receipt", () => writeNew(io.fsImpl, receiptPath(v.configOut), Buffer.from(JSON.stringify(receipt, null, 2) + "\n")));
  return receipt;
}

// ---- CLI (plan by default) -----------------------------------------------------------------------------------------------------------------
const FLAGS = Object.fromEntries(INPUT_KEYS.map((k) => [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, k]));
export function parseArgs(argv) {
  const input = {}; let mode = "plan", confirm;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") mode = "plan";
    else if (a === "--apply") mode = "apply";
    else if (a === "--confirm") confirm = argv[++i];
    else if (Object.hasOwn(FLAGS, a) && !Object.hasOwn(input, FLAGS[a]) && typeof argv[i + 1] === "string") input[FLAGS[a]] = argv[++i];
    else throw fail("unknown, repeated or valueless argument (inputs are listed at the top of install-operator-effects.mjs)", "BadInput");
  }
  return { mode, confirm, input };
}
async function main() {
  process.stdout.on("error", () => {});
  try {
    const { mode, confirm, input } = parseArgs(process.argv.slice(2));
    const out = mode === "apply" ? await applyOperatorEffectsInstall(input, { confirm }) : await planOperatorEffectsInstall(input);
    console.log(JSON.stringify({ ok: true, ...out }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code || "Error", error: sanitize(e.message), ...(e.completed ? { completed: e.completed, failedStep: e.failedStep } : {}), ...(e.existing ? { existing: e.existing } : {}) }, null, 2));
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
