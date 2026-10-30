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
//           --migration-evidence <root migration record> --migration-evidence-sha256 <hex>                                     (r2)
// Only a PUBLIC account is accepted; no operator key is read, derived or exported.
//
// PREFLIGHT (plan and the first stage of apply; read-only, all before any write), r2 order:
//   inputs -> nothing exists (state dir, store, config, receipt, attempt marker; existing files are size-refused BEFORE any read) ->
//   release closure pinned (exact bytes; every static import of the operator closure pinned) -> runtime pin + the SAME qualified exclusion
//   the agent builds -> state parent (link-free fixed NTFS) -> config directory (protected, trusted owner, no broad or non-trusted write,
//   the bound service SID may read) -> trust inputs (qualification, evidence, release files, pinned node.exe, their directories and every
//   ancestor up to the volume root: trusted owners, nobody untrusted may write them / delete-rename-repermission them, the service may
//   read) -> the service account resolves to its derived SID -> legacy r12 obligations clear (bounded reads) -> migration evidence.
// Plan writes nothing. The installer's own successful reads/opens prove nothing about the SERVICE's access: every ACL statement here is a
// structural reading of observed SDDL for the bound service SID, not a native AccessCheck under the service token (root qualification).
//
// APPLY (only with the confirmation string), in order, stopping at the first failure with everything created PRESERVED:
//   0 record the install attempt (wx marker beside the config) so a rerun after ANY interruption refuses - including a creation whose
//     PowerShell timed out and may still be running;
//   1 create the NEW state directory with a protected DACL (inheritance off; SYSTEM + Administrators full; the bound service SID
//     Read+Write, no Delete; owner Administrators) in one CreateDirectory(path, DirectorySecurity) call; it must not exist before.
//     A timed-out/unconfirmed creation stops here (ProcessUnresolved): no later step, no retry;
//   2 verify it: empty, EXACTLY that ACL (not merely "no broad principal"), no reparse in any ancestor, fixed NTFS;
//   3 initializeOwnedLog (purpose enclave-operator-effects/1; wx refuses an existing file);
//   4 observe the journal's ACL (the circularity: a file SDDL exists only after creation), check it is EXACTLY the inherited state ACL
//     under the directory just verified, then run the RUNTIME checkWindowsStorage against those observed values;
//   5 establish the domain under the qualified exclusion (the exact row initializeOperatorEffects/openOperatorEffects use);
//   6 open it through the RUNTIME openOperatorEffects with the same exclusion and storage options (zero records), release;
//   7 re-read the legacy obligation files: unchanged since preflight (a concurrent old writer stops the install before any config);
//   8 write the config (wx, never over an existing file), re-read it through the runtime loader and rebuild the exclusion from it;
//   9 observe the written config file's ACL: trusted owner, nobody untrusted may write it, the service may read it;
//  10 write the sanitized receipt beside the config (wx).
// It does NOT register services/tasks, set machine environment (ENCLAVE_OPERATOR_EFFECTS_CONFIG / _SHA256), stop/start anything, cut a
// host over, change grants, touch the network, mutate any existing ACL, create identities or delete anything. A rerun after any partial
// step refuses (IncompleteInstall) and leaves every byte for explicit investigation.
//
// TEST (portable tests only): an explicit TEST object labelled TEST-ONLY-NOT-WINDOWS (ioOf) may inject runtime/fs/PowerShell, a
// createStateDir hook (answering in the runner's result shape; without it the creation script goes to the injected runner), a
// releaseRoot, a clock, the unresolved-process view and TEST_inProcessExclusion for the journal opens. Refused on win32; receipts say
// production:false. A TEST apply proves the sequencing and refusals only - never Windows ACLs, EXLOCK, NTFS or power-loss behaviour.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeOwnedLog, openOwnedLog, checkWindowsStorage, storageProbeScript } from "../vbslike/manager/win-durable.mjs";
import { NODE_RUNTIME_PIN } from "../vbslike/manager/win-exclusion.mjs";
import { TIMEOUT_CODE } from "../vbslike/manager/psrun.mjs";
import { OPERATOR_EFFECTS_PURPOSE, STATE_SCHEMA, normalizeDomain, openOperatorEffects } from "./operator-effects.mjs";
import { STORE_NAME, CONFIG_ENV, CONFIG_SHA256_ENV, MAX_CONFIG_BYTES, MAX_LEGACY_BYTES, fail, ioOf, pathProblem, pathApi, sameOrInside, sameDir,
  readBoundedFile, readPinnedFile, strictJson, sddlProblem, aclProblem, stateAclProblem, serviceIdentity, legacyState, LEGACY_FILES,
  parseOperatorEffectsConfig, configBytes, qualifiedExclusion, NOT_QUALIFICATION, FILE_READ, DIR_READ } from "./operator-effects-config.mjs";

export const PLAN_SCHEMA = "enclave-operator-effects-install-plan/2";
export const RECEIPT_SCHEMA = "enclave-operator-effects-install-receipt/2";
export const ATTEMPT_SCHEMA = "enclave-operator-effects-install-attempt/1";
export const RELEASE_SCHEMA = "enclave-operator-effects-release/1";
export const MIGRATION_SCHEMA = "enclave-operator-effects-migration-evidence/1";
export const APPLY_CONFIRM = "install-operator-effects-store";
// RELEASE CLOSURE (r2). The agreed operator/config/installer durable import closure, scanned for static imports at install time, plus
// the two construction-seam entries and the two generated bundles chain.mjs imports. This is NOT the whole agent/Host/npm/runtime
// composition: agent.mjs and host.mjs import far more (pinned here only as the seam entries, never scanned or evaluated); the bundles
// are opaque leaves; node_modules (viem) and node.exe are outside it (node.exe is bound by NODE_RUNTIME_PIN).
export const SEAM_ENTRIES = Object.freeze(["control/windows/node/agent.mjs", "control/windows/node/host.mjs"]);
export const OPERATOR_CLOSURE = Object.freeze([
  "control/windows/node/operator-effects-config.mjs", "control/windows/node/install-operator-effects.mjs", "control/windows/node/operator-effects.mjs",
  "control/windows/node/initialize-operator-effects.mjs", "control/windows/node/chain.mjs", "control/windows/node/waf.mjs",
  "control/windows/node/verification-checkpoints.mjs", "control/network/owned-durable-state.mjs", "control/network/runtime-lock.mjs",
  "control/windows/vbslike/manager/win-durable.mjs", "control/windows/vbslike/manager/win-exclusion.mjs", "control/windows/vbslike/manager/psrun.mjs",
]);
export const OPAQUE_LEAVES = Object.freeze(["control/windows/node/lease-gas-runtime.bundle.mjs", "control/windows/node/host-admission.bundle.mjs"]);
/** every file the release manifest must pin (it may pin more) */
export const RELEASE_FILES = Object.freeze([...SEAM_ENTRIES, ...OPERATOR_CLOSURE, ...OPAQUE_LEAVES]);
/** the only non-relative modules the operator closure may import */
export const CLOSURE_EXTERNALS = Object.freeze(["node:child_process", "node:crypto", "node:fs", "node:path", "node:url", "viem", "viem/accounts", "viem/chains"]);
const RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_RELEASE_MANIFEST = 64 * 1024, MAX_RELEASE_FILE = 32 * 1024 * 1024, MAX_RECEIPT_BYTES = 64 * 1024, MAX_MIGRATION_BYTES = 64 * 1024;
export const MIGRATION_MAX_AGE_MS = 6 * 3600_000, MIGRATION_CLOCK_SKEW_MS = 5 * 60_000;
const ACL_BATCH = 40;
const HASH = /^[0-9a-f]{64}$/;
const BASE_KEYS = ["stateDir", "account", "chainId", "serviceAccount", "configOut", "legacyDir", "qualificationFile", "qualificationSha256",
  "evidenceFile", "evidenceSha256", "releaseManifest", "releaseManifestSha256"];
const MIGRATION_KEYS = ["migrationEvidence", "migrationEvidenceSha256"];
const INPUT_KEYS = [...BASE_KEYS, ...MIGRATION_KEYS];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sanitize = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const onlyKeys = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
export const receiptPath = (configOut) => `${configOut}.install-receipt.json`;
export const attemptPath = (configOut) => `${configOut}.install-attempt.json`;

// ---- bounded, read-only PowerShell probes and the one creation script (all through psrun.mjs powershellRunner) ----------------------------
export function directoryProbeScript(dir) {
  const d = q(dir);
  return `$ErrorActionPreference='Stop'; if (-not (Test-Path -LiteralPath ${d})) { '{"exists":false}'; return };
    $i = Get-Item -LiteralPath ${d} -Force; $v = Get-Volume -FilePath ${d}; $rp = $false; $a = $i;
    while ($a) { if ($a.Attributes -band [IO.FileAttributes]::ReparsePoint) { $rp = $true }; $a = $a.Parent };
    @{ exists=$true; directory=[bool]$i.PSIsContainer; reparse=$rp; fileSystem=[string]$v.FileSystem; driveType=[string]$v.DriveType;
       sddl=(Get-Acl -LiteralPath ${d}).Sddl; entries=@(Get-ChildItem -LiteralPath ${d} -Force).Count } | ConvertTo-Json -Compress`.replace(/\r?\n\s*/g, " ");
}
/** read-only: existence, kind, reparse flag and SDDL of each path (one PowerShell run per batch) */
export function aclBatchProbeScript(paths) {
  return `$ErrorActionPreference='Stop'; $enclaveAclBatch = @(${paths.map(q).join(",")}); $out = @();
    foreach ($p in $enclaveAclBatch) { if (-not (Test-Path -LiteralPath $p)) { $out += @{ path=$p; exists=$false }; continue };
      $i = Get-Item -LiteralPath $p -Force; $out += @{ path=$p; exists=$true; directory=[bool]$i.PSIsContainer;
        reparse=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); sddl=(Get-Acl -LiteralPath $p).Sddl } };
    ConvertTo-Json -Compress -InputObject @($out)`.replace(/\r?\n\s*/g, " ");
}
/** read-only: the SID the account name resolves to on this machine (it must equal the derived service SID) */
export function serviceAccountProbeScript(account) {
  return `$ErrorActionPreference='Stop'; $sid = (New-Object Security.Principal.NTAccount(${q(account)})).Translate([Security.Principal.SecurityIdentifier]); @{ sid=[string]$sid.Value } | ConvertTo-Json -Compress`;
}
/** ONE CreateDirectory(path, DirectorySecurity): protected DACL from the first instant for the RESOLVED service SID; refuses an existing path */
export function createStateDirScript(dir, serviceSid) {
  return `$ErrorActionPreference='Stop'; $d = ${q(dir)}; $sid = New-Object Security.Principal.SecurityIdentifier(${q(serviceSid)});
    if (Test-Path -LiteralPath $d) { throw 'state directory already exists' };
    $inh = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'; $np = [Security.AccessControl.PropagationFlags]::None; $al = [Security.AccessControl.AccessControlType]::Allow;
    $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetAccessRuleProtection($true, $false);
    $s.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));
    foreach ($p in @('S-1-5-18', 'S-1-5-32-544')) { $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p)), [Security.AccessControl.FileSystemRights]'FullControl', $inh, $np, $al))) };
    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]'Read, Write', $inh, $np, $al)));
    [void][IO.Directory]::CreateDirectory($d, $s);
    @{ created=$true; serviceSid=[string]$sid.Value } | ConvertTo-Json -Compress`.replace(/\r?\n\s*/g, " ");
}
async function psJson(run, script, what) {
  const r = await run(script);
  let j; try { j = JSON.parse(String(r?.stdout || "").trim()); } catch { throw fail(`${what}: the probe returned no JSON`, "ProbeFailed"); }
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

// ---- inputs, existing state, release, trust inputs, legacy, migration evidence -----------------------------------------------------------
/** syntax + derived identity. The two migration-evidence keys are optional HERE (r1 inputs still parse) and REQUIRED by every preflight. */
export function validateInputs(input, io) {
  const keys = input && typeof input === "object" ? Object.keys(input) : [];
  const exactly = (ks) => keys.length === ks.length && ks.every((k) => typeof input[k] === "string");
  if (!exactly(INPUT_KEYS) && !exactly(BASE_KEYS)) throw fail(`installer inputs must be exactly ${INPUT_KEYS.join(", ")} (strings)`, "BadInput");
  const P = pathApi(io.pathPlatform), withMigration = exactly(INPUT_KEYS);
  for (const k of ["stateDir", "configOut", "legacyDir", "qualificationFile", "evidenceFile", "releaseManifest", ...(withMigration ? ["migrationEvidence"] : [])]) {
    const p = pathProblem(input[k], io.pathPlatform); if (p) throw fail(`${k}: ${p}`, "BadPath");
  }
  for (const k of ["qualificationSha256", "evidenceSha256", "releaseManifestSha256", ...(withMigration ? ["migrationEvidenceSha256"] : [])])
    if (!HASH.test(input[k])) throw fail(`${k} must be 64 lowercase hex`, "BadPin");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.account) || /^0x0{40}$/.test(input.account)) throw fail("account must be a public non-zero operator address (never a key)", "BadDomain");
  if (!/^[1-9][0-9]{0,14}$/.test(input.chainId)) throw fail("chainId must be a positive integer", "BadDomain");
  const domain = normalizeDomain({ account: input.account, chainId: Number(input.chainId) });
  let identity; try { identity = serviceIdentity(input.serviceAccount); } catch (e) { throw fail(`serviceAccount: ${e.message}`, "BadInput"); }
  const store = P.join(input.stateDir, STORE_NAME);
  if (P.relative(P.parse(input.stateDir).root, input.stateDir).split(P.sep).filter(Boolean).length < 2) throw fail("stateDir must be a dedicated directory at least two levels below the volume root", "BadPath");
  if (!/^[A-Za-z0-9_.-]{1,64}\.json$/.test(P.basename(input.configOut))) throw fail("configOut must name a .json file", "BadPath");
  for (const k of ["configOut", "qualificationFile", "evidenceFile", "releaseManifest", "legacyDir", ...(withMigration ? ["migrationEvidence"] : [])])
    if (sameOrInside(input[k], input.stateDir, io.pathPlatform)) throw fail(`${k} must not be (or live in) the store's writable state directory`, "BadPath");
  if (sameOrInside(input.stateDir, input.legacyDir, io.pathPlatform)) throw fail("stateDir must not live in the agent's NODE_DIR (legacyDir)", "BadPath");
  // the same exclusion-input rules parseOperatorEffectsConfig enforces, checked BEFORE anything is created
  if (sameOrInside(input.qualificationFile, input.evidenceFile, io.pathPlatform)) throw fail("qualification record and its evidence must be distinct files", "BadPath");
  for (const k of ["qualificationSha256", "evidenceSha256"])
    if (NOT_QUALIFICATION.includes(input[k])) throw fail(`${k} names a reviewed cross-build artifact: build evidence is not Windows qualification`, "QualificationRefused");
  return Object.freeze({ ...input, domain, store, identity,
    migration: withMigration ? Object.freeze({ file: input.migrationEvidence, sha256: input.migrationEvidenceSha256 }) : null,
    exclusion: Object.freeze({ kind: "numeric-qualified", qualificationFile: input.qualificationFile,
      qualificationSha256: input.qualificationSha256, evidenceFile: input.evidenceFile, evidenceSha256: input.evidenceSha256 }) });
}
/**
 * read-only: absent | already-established | incomplete-or-foreign. Never modifies anything. Existing config/receipt are size-refused from
 * lstat BEFORE any allocation and read with readBoundedFile (growth/replacement = uncertain). "already-established" means only that the
 * receipt and config BYTES bind these inputs (store, domain, service SID, NODE_DIR); it is NOT proof that the store, its ACLs, service
 * access or qualification are valid (verified:false) - the runtime seam and root qualification decide that.
 */
export function inspectInstall(v, io) {
  const has = (f) => { try { io.fsImpl.lstatSync(f); return true; } catch (e) { return e.code === "ENOENT" ? false : null; } };
  const s = { stateDir: has(v.stateDir), store: has(v.store), config: has(v.configOut), receipt: has(receiptPath(v.configOut)), attempt: has(attemptPath(v.configOut)) };
  if (Object.values(s).every((x) => x === false)) return { state: "absent", ...s };
  if (s.config === true && s.receipt === true) {
    let cfg, rec;
    try {
      cfg = readBoundedFile(v.configOut, { max: MAX_CONFIG_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "existing config" });
      rec = readBoundedFile(receiptPath(v.configOut), { max: MAX_RECEIPT_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "existing receipt" });
    } catch (e) { return { state: "incomplete-or-foreign", reason: `existing config/receipt refused (${sanitize(e.code)}): oversized, linked, non-regular or changing`, ...s }; }
    if (Object.values(s).every((x) => x === true)) {
      try {
        const r = strictJson(rec, "install receipt"), c = parseOperatorEffectsConfig(cfg, { pathPlatform: io.pathPlatform });
        if (r.schema === RECEIPT_SCHEMA && r.configSha256 === sha(cfg) && r.store === v.store && c.store === v.store
            && r.domain?.account === v.domain.account && r.domain?.chainId === v.domain.chainId && c.domain.account === v.domain.account && c.domain.chainId === v.domain.chainId
            && c.instance.serviceSid === v.identity.sid && r.instance?.serviceSid === v.identity.sid && sameDir(c.instance.nodeDir, v.legacyDir, io.pathPlatform))
          return { state: "already-established", configSha256: r.configSha256, verified: false,
            note: "receipt and config bytes bind these inputs; store, ACLs, service access and qualification are NOT re-verified by this read-only inspection", ...s };
      } catch { /* falls through: not a complete matching install */ }
    }
  }
  return { state: "incomplete-or-foreign", ...s };
}
/** literal static module specifiers of one source text: import/export ... from <literal>, side-effect import <literal>, and
 *  dynamic import or require called with a literal. A false match can only refuse (fail closed), never admit. */
export function staticImports(text) {
  const out = new Set();
  for (const re of [/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm, /^[ \t]*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g]) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}
function verifyRelease(v, io, root) {
  const m = strictJson(readPinnedFile(v.releaseManifest, v.releaseManifestSha256, { max: MAX_RELEASE_MANIFEST, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "release manifest" }), "release manifest");
  if (!m || typeof m !== "object" || Object.keys(m).length !== 2 || m.schema !== RELEASE_SCHEMA || !m.files || typeof m.files !== "object" || Array.isArray(m.files))
    throw fail("release manifest must be exactly { schema, files }", "Malformed");
  const names = Object.keys(m.files);
  if (names.length > 256) throw fail("release manifest pins too many files", "Malformed");
  for (const f of RELEASE_FILES) if (!names.includes(f)) throw fail(`release manifest does not pin ${f}`, "ReleaseUnpinned");
  const P = pathApi(io.pathPlatform), bytes = new Map();
  for (const rel of names) {
    if (!/^control\/[A-Za-z0-9_./-]+$/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw fail("release manifest names an unsafe path", "Malformed");
    bytes.set(rel, readPinnedFile(P.join(root, ...rel.split("/")), m.files[rel], { max: MAX_RELEASE_FILE, fsImpl: io.fsImpl, platform: io.pathPlatform, what: `release file ${rel}` }));
  }
  // the pinned operator closure must be CLOSED: every static import it makes is itself pinned (or one of the stated externals)
  for (const rel of OPERATOR_CLOSURE) for (const spec of staticImports(bytes.get(rel).toString("utf8"))) {
    if (spec.startsWith(".")) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!RELEASE_FILES.includes(to)) throw fail(`release closure: ${rel} imports ${to}, which the installer does not require pinned`, "ReleaseUnpinned");
    } else if (!CLOSURE_EXTERNALS.includes(spec)) throw fail(`release closure: ${rel} imports ${spec}, outside the stated operator closure`, "ReleaseUnpinned");
  }
  return names.length;
}
/** every trust input, its directory and its ancestors -> Map(key -> { path, roles:Set }) */
function trustPaths(v, io, root) {
  const P = pathApi(io.pathPlatform), map = new Map();
  const add = (p, role, A) => { const k = A === path.win32 ? p.toLowerCase() : p; if (!map.has(k)) map.set(k, { path: p, roles: new Set() }); map.get(k).roles.add(role); };
  const ancestors = (dir, A) => { for (let c = dir; ; c = A.dirname(c)) { add(c, "ancestor", A); if (A.dirname(c) === c) return; } };
  const file = (f, A) => { const d = A.dirname(f); add(f, "trust-file", A); add(d, "trust-dir", A); if (A.dirname(d) !== d) ancestors(A.dirname(d), A); };
  const cfgDir = P.dirname(v.configOut);
  if (P.dirname(cfgDir) !== cfgDir) ancestors(P.dirname(cfgDir), P);
  file(v.qualificationFile, P); file(v.evidenceFile, P);
  file(v.releaseManifest, P);
  if (v.migration) file(v.migration.file, P);
  for (const rel of RELEASE_FILES) file(P.join(root, ...rel.split("/")), P);
  file(NODE_RUNTIME_PIN.execPath, path.win32);   // the pinned runtime is always a Windows path
  ancestors(P.dirname(v.stateDir), P);
  return map;
}
const ROLE_CHECK = {
  "trust-file": (e, sid) => (e.directory === false ? aclProblem(e.sddl, { serviceSid: sid, read: FILE_READ, deny: "write" }) : "not a regular file"),
  "trust-dir": (e, sid) => (e.directory === true ? aclProblem(e.sddl, { serviceSid: sid, read: DIR_READ, deny: "write" }) : "not a directory"),
  "ancestor": (e, sid) => (e.directory === true ? aclProblem(e.sddl, { serviceSid: sid, read: DIR_READ, deny: "replace" }) : "not a directory"),
};
async function verifyTrustAcls(run, v, io, root) {
  const entries = [...trustPaths(v, io, root).values()];
  for (let i = 0; i < entries.length; i += ACL_BATCH) {
    const part = entries.slice(i, i + ACL_BATCH);
    const j = await psJson(run, aclBatchProbeScript(part.map((e) => e.path)), "trust-input ACL probe");
    if (!Array.isArray(j) || j.length !== part.length) throw fail("trust-input ACL probe: the answer does not match the request", "ProbeFailed");
    part.forEach((want, k) => {
      const got = j[k];
      if (!plain(got) || got.path !== want.path) throw fail("trust-input ACL probe: the answer does not match the request", "ProbeFailed");
      if (got.exists !== true || got.reparse !== false || typeof got.sddl !== "string") throw fail(`trust input ${sanitize(want.path)}: absent, a reparse point or without an observable ACL`, "TrustInputUnsafe");
      for (const role of want.roles) {
        const p = ROLE_CHECK[role](got, v.identity.sid);
        if (p) throw fail(`trust input ${sanitize(want.path)} (${role}): ${p}`, "TrustInputUnsafe");
      }
    });
  }
  return entries.length;
}
function legacyClear(v, io) {
  let st; try { st = io.fsImpl.lstatSync(v.legacyDir); } catch { st = null; }
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw fail("legacyDir must be the agent's existing NODE_DIR directory (no link)", "LegacyObligations");
  noLinkAncestors(v.legacyDir, io);
  const s = legacyState(v.legacyDir, { fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
  if (s.problem) throw fail(s.problem, "LegacyObligations");
  return s.files;
}
const isoMs = (s) => (typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(s) ? Date.parse(s) : NaN);
/**
 * The pinned ROOT migration record (schema MIGRATION_SCHEMA). This source never produces it and never observes services: it binds what
 * root observed to THIS install and refuses anything stale, foreign or contradicted by the installer's own bounded re-reads:
 *   instance { serviceAccount, serviceSid, nodeDir, domain }   = the bound service, --legacy-dir and the domain;
 *   writers { observedAt, method: "service-stopped-start-disabled", excluded: [{ kind: "service", name, state: "stopped",
 *             startType: "disabled" }] (must include the agent service), sameDomainWritersElsewhere: "none" };
 *   legacy { observedAt (>= writers.observedAt: reconciled AFTER exclusion), dir, files: { <r12 file>: { state: "absent" } |
 *            { state: "empty", sha256 } } }   - re-read now: any difference refuses (a writer is active or the record is stale);
 *   priorStores [{ path, state: "absent" | "reconciled", sha256 }]  - every other store/legacy location of this account+chain root knows,
 *            re-checked now (absent, or exactly the reconciled bytes);
 *   history: "complete-for-domain";  observedBy: "root".  writers.observedAt must be within MIGRATION_MAX_AGE_MS.
 */
function migrationEvidence(v, io, legacyFiles) {
  if (!v.migration) throw fail("migration evidence is required (--migration-evidence + --migration-evidence-sha256): a pinned root record binding this service, NODE_DIR and domain, its excluded old writers and the reconciled legacy state", "MigrationEvidenceRequired");
  const m = strictJson(readPinnedFile(v.migration.file, v.migration.sha256, { max: MAX_MIGRATION_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "migration evidence" }), "migration evidence");
  const bad = (why) => fail(`migration evidence refused: ${why}`, "MigrationEvidenceRefused");
  if (!onlyKeys(m, ["schema", "observedBy", "instance", "writers", "legacy", "priorStores", "history"]) || m.schema !== MIGRATION_SCHEMA) throw bad("unknown or missing fields, or another schema");
  if (m.observedBy !== "root") throw bad("not a root observation");
  const i = m.instance;
  if (!onlyKeys(i, ["serviceAccount", "serviceSid", "nodeDir", "domain"]) || !onlyKeys(i.domain, ["account", "chainId"])) throw bad("instance must be exactly { serviceAccount, serviceSid, nodeDir, domain { account, chainId } }");
  if (String(i.serviceAccount).toLowerCase() !== v.identity.account.toLowerCase() || i.serviceSid !== v.identity.sid) throw bad("it names another service identity");
  if (!sameDir(i.nodeDir, v.legacyDir, io.pathPlatform)) throw bad("it names another agent NODE_DIR than --legacy-dir");
  if (String(i.domain.account).toLowerCase() !== v.domain.account || i.domain.chainId !== v.domain.chainId) throw bad("it names another operator account or chain");
  const w = m.writers;
  if (!onlyKeys(w, ["observedAt", "method", "excluded", "sameDomainWritersElsewhere"]) || w.method !== "service-stopped-start-disabled") throw bad("old writers must be excluded by stopping their services with start disabled");
  if (w.sameDomainWritersElsewhere !== "none") throw bad("another writer of this account/chain is not excluded");
  if (!Array.isArray(w.excluded) || w.excluded.length < 1 || w.excluded.length > 16) throw bad("excluded writers must list 1..16 services");
  for (const e of w.excluded)
    if (!onlyKeys(e, ["kind", "name", "state", "startType"]) || e.kind !== "service" || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(String(e.name)) || e.state !== "stopped" || e.startType !== "disabled")
      throw bad("every excluded writer must be a service observed stopped with start disabled");
  if (!w.excluded.some((e) => e.name.toLowerCase() === v.identity.name.toLowerCase())) throw bad("the agent service itself is not among the excluded old writers");
  const L = m.legacy, now = io.now(), tw = isoMs(w.observedAt), tl = isoMs(L?.observedAt);
  if (!onlyKeys(L, ["observedAt", "dir", "files"]) || !onlyKeys(L.files, [...LEGACY_FILES])) throw bad("legacy must be exactly { observedAt, dir, files } naming both r12 files");
  if (!sameDir(L.dir, v.legacyDir, io.pathPlatform)) throw bad("legacy state was observed in another directory");
  if (!Number.isFinite(tw) || !Number.isFinite(tl)) throw bad("observation times must be UTC ISO-8601");
  if (tl < tw) throw bad("legacy state was observed before the old writers were excluded (wrong boundary)");
  if (tw > now + MIGRATION_CLOCK_SKEW_MS || tl > now + MIGRATION_CLOCK_SKEW_MS) throw bad("observed in the future");
  if (now - tw > MIGRATION_MAX_AGE_MS) throw bad("stale: old-writer exclusion must be observed again");
  for (const name of LEGACY_FILES) {
    const want = L.files[name], got = legacyFiles[name];
    const same = (onlyKeys(want, ["state"]) && want.state === "absent" && got?.state === "absent")
      || (onlyKeys(want, ["state", "sha256"]) && want.state === "empty" && got?.state === "empty" && want.sha256 === got.sha256);
    if (!same) throw bad(`${name} is not in the state root reconciled (changed since, or an old writer is still active)`);
  }
  if (!Array.isArray(m.priorStores) || m.priorStores.length > 16) throw bad("priorStores must list at most 16 locations");
  for (const s of m.priorStores) {
    if (!onlyKeys(s, ["path", "state", "sha256"]) || pathProblem(s.path, io.pathPlatform)) throw bad("a prior store entry is malformed");
    if (s.state === "absent") {
      let gone = false; try { io.fsImpl.lstatSync(s.path); } catch (e) { gone = e.code === "ENOENT"; }
      if (!gone) throw bad("a prior store root reported absent exists (or cannot be inspected): its history is unresolved");
    } else if (s.state === "reconciled" && HASH.test(String(s.sha256))) {
      try { readPinnedFile(s.path, s.sha256, { max: MAX_LEGACY_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "prior store" }); }
      catch { throw bad("a reconciled prior store changed since (or cannot be read within bounds): its history is unresolved"); }
    } else throw bad("a prior store is neither absent nor reconciled with its exact bytes");
  }
  if (m.history !== "complete-for-domain") throw bad("root has not stated that this account/chain's operator history was searched completely");
  return Object.freeze({ evidenceSha256: v.migration.sha256, writersObservedAt: w.observedAt, legacyObservedAt: L.observedAt,
    expiresAt: new Date(tw + MIGRATION_MAX_AGE_MS).toISOString(), nodeDir: i.nodeDir, excludedWriters: w.excluded.map((e) => e.name), priorStores: m.priorStores.length });
}

// ---- plan / apply ------------------------------------------------------------------------------------------------------------------------------
async function preflight(input, TEST) {
  const io = ioOf(TEST), checks = [];
  const v = validateInputs(input, io); checks.push("inputs");
  if (io.platform !== "win32") throw fail("the operator-effects installer is Windows-only", "UnsupportedPlatform");
  const existing = inspectInstall(v, io);
  if (existing.state === "already-established") throw Object.assign(fail("already established (state, store, config, attempt marker and a receipt binding these inputs exist): nothing changed; this is not a validation of that store; activation and review are separate steps", "AlreadyEstablished"), { existing });
  if (existing.state !== "absent") throw Object.assign(fail("an incomplete or foreign installation (or an earlier install attempt) exists: PRESERVED for explicit investigation; nothing is replaced, reset, deleted or retried", "IncompleteInstall"), { existing });
  checks.push("nothing-exists");
  const root = TEST?.releaseRoot ?? RELEASE_ROOT;
  const releaseFiles = verifyRelease(v, io, root); checks.push("release-pinned");
  const runtime = io.runtime();
  const exclusion = qualifiedExclusion({ config: { exclusion: v.exclusion }, runtime, fsImpl: io.fsImpl, pathPlatform: io.pathPlatform }); checks.push("runtime-pin+qualification+exclusion");
  const run = io.run();
  if (typeof run !== "function") throw fail("the bounded PowerShell runner is unavailable", "StorageUnqualified");
  const P = pathApi(io.pathPlatform);
  await probeDir(run, P.dirname(v.stateDir), "state parent directory"); noLinkAncestors(P.dirname(v.stateDir), io); checks.push("state-parent");
  const cfgDir = await probeDir(run, P.dirname(v.configOut), "config directory");
  const cp = aclProblem(cfgDir.sddl, { serviceSid: v.identity.sid, read: DIR_READ, deny: "write", protectedDacl: true, noBroad: true });
  if (cp) throw fail(`config directory ACL refused: ${cp}`, "StorageUnqualified");
  checks.push("config-directory");
  const trustInputs = await verifyTrustAcls(run, v, io, root); checks.push("trust-inputs-acl");
  const resolved = await psJson(run, serviceAccountProbeScript(v.identity.account), "service account");
  if (resolved.sid !== v.identity.sid) throw fail("the service account does not resolve to its derived per-service SID on this machine", "BadServiceIdentity");
  checks.push("service-account-resolves");
  const legacyFiles = legacyClear(v, io); checks.push("legacy-clear");
  const migration = migrationEvidence(v, io, legacyFiles); checks.push("migration-evidence");
  const plan = Object.freeze({ schema: PLAN_SCHEMA, mode: "plan", writes: "none", production: io.production, store: v.store, stateDir: v.stateDir,
    configOut: v.configOut, receipt: receiptPath(v.configOut), attemptMarker: attemptPath(v.configOut), domain: { ...v.domain },
    serviceIdentity: { account: v.identity.account, sid: v.identity.sid, principalType: v.identity.principalType }, nodeDir: v.legacyDir, migration,
    runtimePin: { ...NODE_RUNTIME_PIN }, exclusionBasis: exclusion.basis, qualificationSha256: v.qualificationSha256, evidenceSha256: v.evidenceSha256,
    releaseManifestSha256: v.releaseManifestSha256, releaseFiles, trustInputs, checks,
    aclBasis: "structural reading of observed SDDL for the bound service SID by the installer identity; NOT a native effective-access observation under the service token",
    apply: ["record-install-attempt", "create-state-directory", "verify-state-directory", "create-journal", "observe-and-pin-journal-acl", "establish-domain",
      "verify-runtime-open", "recheck-legacy", "validate-config-bytes", "write-config", "verify-config", "verify-config-acl", "write-receipt"],
    notPerformed: ["service/task registration", `machine environment ${CONFIG_ENV} / ${CONFIG_SHA256_ENV}`, "service stop/start or app restart", "host cutover",
      "grant changes", "ACL changes to existing objects", "identity creation", "legacy record migration", "network"] });
  return { plan, v, io, run, exclusion, cfgDir, legacyFiles, migration };
}
/** read-only preflight -> sanitized plan (throws a coded refusal) */
export async function planOperatorEffectsInstall(input, { TEST } = {}) { return (await preflight(input, TEST)).plan; }

/** explicit apply -> sanitized receipt; any failure throws IncompleteInstall naming completed steps; nothing created is ever deleted */
export async function applyOperatorEffectsInstall(input, { confirm, TEST } = {}) {
  if (confirm !== APPLY_CONFIRM) throw fail(`explicit apply requires --confirm ${APPLY_CONFIRM}; nothing changed`, "NotConfirmed");
  const { plan, v, io, run, exclusion, cfgDir, legacyFiles, migration } = await preflight(input, TEST);
  if (io.unresolved().count !== 0) throw fail("an earlier PowerShell child of this process timed out without a confirmed exit: no install step starts", "ProcessUnresolved");
  // the journal opens use the qualified exclusion; a labelled TEST run may substitute TEST_inProcessExclusion (never in production)
  const ex = io.production ? exclusion : (TEST.exclusion ?? exclusion);
  const sid = v.identity.sid, done = [];
  const step = async (name, f) => {
    try { const r = await f(); done.push(name); return r; }
    catch (e) { throw Object.assign(fail(`install stopped at ${name} after [${done.join(", ") || "nothing"}]: ${sanitize(e.message)}. Everything created so far is PRESERVED; a rerun refuses until it is investigated explicitly`, "IncompleteInstall"), { completed: [...done], failedStep: name, cause: e.code ?? null }); }
  };
  await step("record-install-attempt", () => writeNew(io.fsImpl, attemptPath(v.configOut), Buffer.from(JSON.stringify({ schema: ATTEMPT_SCHEMA, production: io.production,
    store: v.store, stateDir: v.stateDir, configOut: v.configOut, domain: { ...v.domain }, serviceSid: sid, startedAt: new Date(io.now()).toISOString(),
    note: "an install attempt began here: every rerun refuses until it is investigated explicitly" }, null, 2) + "\n")));
  await step("create-state-directory", async () => {
    // a labelled TEST hook answers in the runner's result shape, so TEST and production pass the SAME result checks below
    const r = !io.production && typeof TEST.createStateDir === "function" ? await TEST.createStateDir(v.stateDir, sid) : await run(createStateDirScript(v.stateDir, sid));
    if (r?.code === TIMEOUT_CODE || r?.timedOut || r?.processState === "unresolved")
      throw fail("state directory creation did not finish and its process may still be running: no further step and no retry", "ProcessUnresolved");
    let j; try { j = JSON.parse(String(r?.stdout || "").trim()); } catch { j = null; }
    if (r?.code !== 0 || r?.processState === "not-started" || j?.created !== true || j?.serviceSid !== sid) throw fail("state directory creation not confirmed for the bound service SID");
  });
  const dir = await step("verify-state-directory", async () => {
    const d = await probeDir(run, v.stateDir, "state directory");
    if (d.entries !== 0) throw fail("the new state directory is not empty");
    const p = sddlProblem(d.sddl, { protectedDacl: true }) || stateAclProblem(d.sddl, sid, { directory: true });
    if (p) throw fail(`state directory ACL refused: ${p}`);
    noLinkAncestors(v.stateDir, io);
    return d;
  });
  await step("create-journal", () => initializeOwnedLog(v.store, { purpose: OPERATOR_EFFECTS_PURPOSE, fsImpl: io.fsImpl }));
  const storage = await step("observe-and-pin-journal-acl", async () => {
    const j = await psJson(run, storageProbeScript(v.store), "journal storage");
    if (j.reparse !== false || j.fileSystem !== "NTFS" || j.driveType !== "Fixed") throw fail("journal must be a non-reparse file on a fixed NTFS volume");
    if (j.parentSddl !== dir.sddl) throw fail("the state directory ACL changed after it was verified");
    const p = sddlProblem(j.sddl) || stateAclProblem(j.sddl, sid, { directory: false });
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
  await step("recheck-legacy", () => {
    const now = legacyState(v.legacyDir, { fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
    if (now.problem || JSON.stringify(now.files) !== JSON.stringify(legacyFiles)) throw fail("legacy obligation files changed during the install: an old writer may be active; no config is written");
  });
  const instance = { serviceAccount: v.identity.account, serviceSid: sid, nodeDir: v.legacyDir };
  const bytes = configBytes({ store: v.store, domain: v.domain, instance, storage, exclusion: v.exclusion }), configSha256 = sha(bytes);
  await step("validate-config-bytes", () => { if (parseOperatorEffectsConfig(bytes, { pathPlatform: io.pathPlatform }).store !== v.store) throw fail("config round trip differs"); });
  await step("write-config", () => writeNew(io.fsImpl, v.configOut, bytes));
  await step("verify-config", () => {
    const back = readPinnedFile(v.configOut, configSha256, { max: MAX_CONFIG_BYTES, fsImpl: io.fsImpl, platform: io.pathPlatform, what: "written config" });
    qualifiedExclusion({ config: parseOperatorEffectsConfig(back, { pathPlatform: io.pathPlatform }), runtime: io.runtime(), fsImpl: io.fsImpl, pathPlatform: io.pathPlatform });
  });
  await step("verify-config-acl", async () => {
    const j = await psJson(run, storageProbeScript(v.configOut), "written config ACL");
    if (j.reparse !== false) throw fail("the written config is a reparse point");
    if (j.parentSddl !== cfgDir.sddl) throw fail("the config directory ACL changed during the install");
    const p = aclProblem(j.sddl, { serviceSid: sid, read: FILE_READ, deny: "write" });
    if (p) throw fail(`written config ACL refused: ${p}`);
  });
  const receipt = { schema: RECEIPT_SCHEMA, production: io.production, ...(io.production ? {} : { label: "TEST-ONLY-NOT-WINDOWS: not an installation, not Windows qualification" }),
    store: v.store, domain: { ...v.domain }, instance: { ...instance, principalType: v.identity.principalType }, storage: { ...storage }, configFile: v.configOut, configSha256,
    qualificationSha256: v.qualificationSha256, evidenceSha256: v.evidenceSha256, releaseManifestSha256: v.releaseManifestSha256, migration,
    runtimePin: { ...NODE_RUNTIME_PIN }, exclusionBasis: exclusion.basis, aclBasis: plan.aclBasis,
    steps: [...done, "write-receipt"], activation: { performed: false, reviewedStepSets: { [CONFIG_ENV]: v.configOut, [CONFIG_SHA256_ENV]: configSha256 },
      requires: ["root observes the agent service running as the bound service SID with NODE_DIR = nodeDir", "old writers stay excluded until the new build starts",
        "native qualification of EXLOCK, ACL effective access and the probes (not established by this receipt)"] },
    notPerformed: plan.notPerformed, at: new Date(io.now()).toISOString() };
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
    console.log(JSON.stringify({ ok: false, code: e.code || "Error", error: sanitize(e.message), ...(e.completed ? { completed: e.completed, failedStep: e.failedStep, cause: e.cause ?? null } : {}), ...(e.existing ? { existing: e.existing } : {}) }, null, 2));
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
