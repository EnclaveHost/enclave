// TEST-ONLY-NOT-WINDOWS fixtures for the operator Windows wiring tests (ow-r1 adapted in r2, ow-r2). AUTHORED, NOT RUN.
// Nothing here is Windows evidence: the SDDL strings are shapes the ACTUAL production evaluators read, the PowerShell answers are
// computed from real temp files plus those strings, the qualification and migration records are TEST records in the reviewed schemas,
// and no ACL, service, EXLOCK, NTFS or process observation is made.
//
// r2 fixture change (documented in REPORT-OPERATOR-WINDOWS-WIRING-R2.md): the r1 positive config-directory ACL granted ONLY SYSTEM and
// Administrators (BA/SY), which the selected NT SERVICE identity cannot read; it is no longer a positive fixture (BASY_ONLY_SDDL, used
// as a refusal). The positive CFG_SDDL grants the DERIVED service SID exactly directory read (0x1200a9) and nothing else; the state ACLs
// name the derived SID instead of the r1 placeholder S-1-5-80-1-2-3-4-5.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as C from "../../../control/windows/node/operator-effects-config.mjs";
import * as I from "../../../control/windows/node/install-operator-effects.mjs";
import { TEST_inProcessExclusion } from "../../../control/windows/vbslike/manager/win-durable.mjs";
import { NODE_RUNTIME_PIN, QUALIFICATION_SCHEMA, UV_FS_O_EXLOCK_NUMERIC } from "../../../control/windows/vbslike/manager/win-exclusion.mjs";

export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const ACCOUNT = "0x" + "11".repeat(20), OTHER = "0x" + "99".repeat(20), CHAIN = 8453;
export const RT = Object.freeze({ platform: "win32", version: NODE_RUNTIME_PIN.version, execPath: NODE_RUNTIME_PIN.execPath, execSha256: NODE_RUNTIME_PIN.execSha256 });   // TEST runtime
export const SERVICE = "NT SERVICE\\EnclaveNode", SVC = C.virtualServiceSid("EnclaveNode");
// TEST SDDL strings (shape only; no Windows ACL was observed)
export const DIR_SDDL = `O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x12019f;;;${SVC})`;
export const FILE_SDDL = `O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x12019f;;;${SVC})`;
export const CFG_SDDL = `O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;${SVC})`;   // exact selected-service read, no write
export const READ_FILE_SDDL = `O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;${SVC})`;
export const BASY_ONLY_SDDL = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";   // r1's positive fixture: the service cannot read it
export const CANDIDATE = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
export const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
export const TESTio = (extra = {}) => ({ label: C.TEST_LABEL, runtime: RT, pathPlatform: "linux", fsImpl: fs, ...extra });

/**
 * TEST PowerShell boundary. Answers, from the real temp files: directory probes, storage probes, trust-input ACL batches, the
 * service-account resolution and the running-process identity. acl: { <exact path>: SDDL } overrides; accountSid / processSid
 * override the resolved/running SIDs; onScript(script) runs first (e.g. to simulate a concurrent writer).
 */
export function testRun({ journal = "ok", stateDir = null, timeoutOn = null, cfgSddl = CFG_SDDL, acl = {}, accountSid = null, processSid = null, onScript = null } = {}) {
  const calls = [];
  const sddlFor = (p, dir) => (Object.hasOwn(acl, p) ? acl[p] : dir ? cfgSddl : READ_FILE_SDDL);
  const run = async (script) => {
    calls.push(script);
    onScript?.(script);
    if (timeoutOn && script.includes(timeoutOn)) return { code: 124, stdout: "", stderr: "TEST timed out", timedOut: true, processState: "unresolved" };
    if (script.includes("WindowsIdentity")) return { code: 0, stdout: JSON.stringify({ sid: processSid ?? SVC }) };
    if (script.includes("NTAccount(")) {
      const n = /NTAccount\('NT SERVICE\\([^']+)'\)/.exec(script)?.[1];
      return { code: 0, stdout: JSON.stringify({ sid: accountSid ?? C.virtualServiceSid(n) }) };
    }
    if (script.includes("$enclaveAclBatch")) {
      const list = /\$enclaveAclBatch = @\((.*?)\); \$out/.exec(script)[1];
      const paths = [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      return { code: 0, stdout: JSON.stringify(paths.map((p) => {
        if (/^[A-Za-z]:\\/.test(p)) {   // TEST stand-in for the pinned Windows node.exe path and its ancestors (no Windows file exists here)
          const dir = !/\.exe$/i.test(p);
          return { path: p, exists: true, directory: dir, reparse: false, sddl: sddlFor(p, dir) };
        }
        if (!fs.existsSync(p)) return { path: p, exists: false };
        const st = fs.lstatSync(p);
        return { path: p, exists: true, directory: st.isDirectory(), reparse: st.isSymbolicLink(), sddl: sddlFor(p, st.isDirectory()) };
      })) };
    }
    const target = /-LiteralPath '((?:[^']|'')*)'/.exec(script)?.[1]?.replace(/''/g, "'");
    if (script.includes("Get-ChildItem")) {
      if (!fs.existsSync(target)) return { code: 0, stdout: '{"exists":false}' };
      return { code: 0, stdout: JSON.stringify({ exists: true, directory: fs.statSync(target).isDirectory(), reparse: false, fileSystem: "NTFS", driveType: "Fixed",
        sddl: target === stateDir ? DIR_SDDL : sddlFor(target, true), entries: fs.readdirSync(target).length }) };
    }
    if (journal === "fail") return { code: 1, stdout: "{}", stderr: "TEST raw PowerShell error text that must never be echoed" };
    if (target && path.basename(target) === C.STORE_NAME) return { code: 0, stdout: JSON.stringify({ sddl: FILE_SDDL, parentSddl: DIR_SDDL, reparse: false, fileSystem: "NTFS", driveType: "Fixed" }) };
    return { code: 0, stdout: JSON.stringify({ sddl: sddlFor(target, false), parentSddl: sddlFor(path.dirname(String(target)), true), reparse: false, fileSystem: "NTFS", driveType: "Fixed" }) };
  };
  return { run, calls };
}

/** a disposable TEST layout: state/, config/, qual/, node/ (the agent NODE_DIR) with TEST qualification + evidence and a pinned /2 config */
export function fixture(t, { qual = {}, cfg = {} } = {}) {
  const root = tmp(t, "ow-");
  for (const d of ["state", "config", "qual", "node"]) fs.mkdirSync(path.join(root, d));
  const stateDir = path.join(root, "state", "operator-effects"); fs.mkdirSync(stateDir);
  const nodeDir = path.join(root, "node");
  const evidence = Buffer.from("TEST-ONLY-NOT-WINDOWS evidence placeholder: no observation was made\n");
  const evidenceFile = path.join(root, "qual", "evidence.txt"); fs.writeFileSync(evidenceFile, evidence);
  const record = { schema: QUALIFICATION_SCHEMA, nodeVersion: RT.version, execSha256: RT.execSha256, flag: UV_FS_O_EXLOCK_NUMERIC, crossProcessOpenRefused: true,
    crossProcessRenameRefused: true, crossProcessDeleteRefused: true, holderDeathReleases: true, sameProcessSecondOpenRefused: true,
    evidenceSha256: sha(evidence), qualifiedBy: "root", ...qual };   // TEST fixture in the reviewed schema; NOT a qualification
  const qualBytes = Buffer.from(JSON.stringify(record));
  const qualificationFile = path.join(root, "qual", "exlock-qualification.json"); fs.writeFileSync(qualificationFile, qualBytes);
  const store = path.join(stateDir, C.STORE_NAME);
  const exclusion = { qualificationFile, qualificationSha256: sha(qualBytes), evidenceFile, evidenceSha256: sha(evidence) };
  const instance = { serviceAccount: SERVICE, serviceSid: SVC, nodeDir };
  const bytes = C.configBytes({ store, domain: { account: ACCOUNT, chainId: CHAIN }, instance, storage: { sddl: FILE_SDDL, parentSddl: DIR_SDDL }, exclusion });
  const json = { ...JSON.parse(bytes), ...cfg };
  const finalBytes = Object.keys(cfg).length ? Buffer.from(JSON.stringify(json)) : bytes;
  const configFile = path.join(root, "config", "operator-effects.json"); fs.writeFileSync(configFile, finalBytes);
  return { root, stateDir, store, nodeDir, instance, configFile, bytes: finalBytes, qualificationFile, evidenceFile, exclusion, record,
    env: { [C.CONFIG_ENV]: configFile, [C.CONFIG_SHA256_ENV]: sha(finalBytes), NODE_DIR: nodeDir },
    repin(file, buf) { fs.writeFileSync(file, buf); return sha(buf); } };
}
export const domainOK = () => ({ account: ACCOUNT, chainId: CHAIN });

/** a TEST root migration record (reviewed schema; NOT an observation) for legacyDir, edited by `edit` */
export function migrationRecord(legacyDir, edit = (r) => r) {
  const now = Date.now();
  return edit({ schema: I.MIGRATION_SCHEMA, observedBy: "root",
    instance: { serviceAccount: SERVICE, serviceSid: SVC, nodeDir: legacyDir, domain: { account: ACCOUNT, chainId: CHAIN } },
    writers: { observedAt: new Date(now - 60_000).toISOString(), method: "service-stopped-start-disabled",
      excluded: [{ kind: "service", name: "EnclaveNode", state: "stopped", startType: "disabled" }], sameDomainWritersElsewhere: "none" },
    legacy: { observedAt: new Date(now - 30_000).toISOString(), dir: legacyDir,
      files: { "operator-writes.json": { state: "absent" }, "sponsored-obligations.json": { state: "absent" } } },
    priorStores: [], history: "complete-for-domain" });
}
/** write + pin a migration record into the installer inputs */
export function pinMigration(s, record) { const b = Buffer.from(JSON.stringify(record)); fs.writeFileSync(s.input.migrationEvidence, b); s.input.migrationEvidenceSha256 = sha(b); }
/** TEST creation hook in the shared runner's result shape: a plain temp directory; no ACL is set or observed */
export const testCreate = (d, sid) => { fs.mkdirSync(d); return { code: 0, stdout: JSON.stringify({ created: true, serviceSid: sid }), stderr: "", processState: "exited" }; };

export function installFixture(t, extra = {}) {
  const fx = fixture(t);
  fs.rmSync(fx.stateDir, { recursive: true });   // the installer creates it
  fs.rmSync(fx.configFile);
  const legacyDir = fx.nodeDir;
  const files = Object.fromEntries(I.RELEASE_FILES.map((rel) => [rel, sha(fs.readFileSync(path.join(CANDIDATE, ...rel.split("/"))))]));
  const manifest = Buffer.from(JSON.stringify({ schema: I.RELEASE_SCHEMA, files }));
  const releaseManifest = path.join(fx.root, "qual", "release.json"); fs.writeFileSync(releaseManifest, manifest);
  const migrationEvidence = path.join(fx.root, "qual", "migration.json");
  const input = { stateDir: fx.stateDir, account: ACCOUNT, chainId: String(CHAIN), serviceAccount: SERVICE, configOut: fx.configFile, legacyDir,
    qualificationFile: fx.qualificationFile, qualificationSha256: fx.exclusion.qualificationSha256, evidenceFile: fx.evidenceFile, evidenceSha256: fx.exclusion.evidenceSha256,
    releaseManifest, releaseManifestSha256: sha(manifest), migrationEvidence, migrationEvidenceSha256: "0".repeat(64), ...extra };
  const s = { fx, input, legacyDir };
  pinMigration(s, migrationRecord(legacyDir));
  const io = testRun({ stateDir: fx.stateDir });
  s.TEST = TESTio({ run: io.run, openPlatform: "linux", releaseRoot: CANDIDATE, exclusion: TEST_inProcessExclusion(), createStateDir: testCreate });
  s.calls = io.calls;
  return s;
}
export const nothingCreated = (assert, s) => {
  for (const f of [s.input.stateDir, s.input.configOut, I.receiptPath(s.input.configOut), I.attemptPath(s.input.configOut)]) assert.equal(fs.existsSync(f), false, f);
};
