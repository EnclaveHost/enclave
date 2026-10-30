// operator Windows wiring r1 (AUTHORED, NOT RUN). Portable consumer tests of the ACTUAL shared config loader
// (operator-effects-config.mjs), the ACTUAL explicit installer (install-operator-effects.mjs) and the ACTUAL construction seam
// agent.mjs uses (operatorEffectsForHost -> actual Host constructor -> actual chain.mjs setOperatorEffects -> actual openOperatorEffects).
// agent.mjs itself is NEVER imported (its top level measures compute, dials tunnels and starts services); part B checks its source text
// for the seam call and drives that exact seam with external TEST inputs.
//
// TEST, explicitly labelled - NOTHING here is Windows evidence:
//   - runtime: the NODE_RUNTIME_PIN values injected as a TEST runtime (platform "win32") through the TEST object (label
//     TEST-ONLY-NOT-WINDOWS), never through an environment switch; paths are POSIX temp paths (TEST pathPlatform "linux");
//   - PowerShell: a TEST runner answering the probe scripts from the real temp files with TEST SDDL strings (no ACL is observed);
//   - qualification: a TEST record in the reviewed schema plus a TEST evidence placeholder, written ONLY to exercise byte/pin binding.
//     It is NOT a qualification. On Linux the numeric flag is ignored by open(2), so the real windowsNumericExclusion self-check
//     REFUSES every open here (asserted) - no TEST outcome can make operator effects available on a TEST config;
//   - the explicit apply runs only in a disposable temp directory with TEST_inProcessExclusion for the journal opens (labelled; not
//     EXLOCK, not cross-process, not NTFS, not power loss);
//   - chain.mjs runs with the same inert viem doubles as od-r1 (TEST account, nothing signed, broadcast or paid; no network).
// Every global/env mutation is restored after the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import * as C from "./candidate/control/windows/node/operator-effects-config.mjs";
import * as I from "./candidate/control/windows/node/install-operator-effects.mjs";
import { openOperatorEffects, initializeOperatorEffects } from "./candidate/control/windows/node/operator-effects.mjs";
import { storageProbeScript, TEST_inProcessExclusion } from "./candidate/control/windows/vbslike/manager/win-durable.mjs";
import { NODE_RUNTIME_PIN, QUALIFICATION_SCHEMA, UV_FS_O_EXLOCK_NUMERIC } from "./candidate/control/windows/vbslike/manager/win-exclusion.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const ACCOUNT = "0x" + "11".repeat(20), OTHER = "0x" + "99".repeat(20), CHAIN = 8453;
const RT = Object.freeze({ platform: "win32", version: NODE_RUNTIME_PIN.version, execPath: NODE_RUNTIME_PIN.execPath, execSha256: NODE_RUNTIME_PIN.execSha256 });   // TEST runtime
// TEST SDDL strings (shape only; no Windows ACL was observed)
const DIR_SDDL = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x12019f;;;S-1-5-80-1-2-3-4-5)";
const FILE_SDDL = "O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x12019f;;;S-1-5-80-1-2-3-4-5)";
const CFG_SDDL = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
const CANDIDATE = fileURLToPath(new URL("./candidate/", import.meta.url)).replace(/\/$/, "");
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** TEST PowerShell boundary: answers directory probes and journal storage probes from the real temp files */
function testRun({ journal = "ok", stateDir = null, timeoutOn = null, cfgSddl = CFG_SDDL } = {}) {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (timeoutOn && script.includes(timeoutOn)) return { code: 124, stdout: "", stderr: "TEST timed out" };
    const target = /-LiteralPath '((?:[^']|'')*)'/.exec(script)?.[1]?.replace(/''/g, "'");
    if (script.includes("Get-ChildItem")) {
      if (!fs.existsSync(target)) return { code: 0, stdout: '{"exists":false}' };
      return { code: 0, stdout: JSON.stringify({ exists: true, directory: fs.statSync(target).isDirectory(), reparse: false, fileSystem: "NTFS", driveType: "Fixed",
        sddl: target === stateDir ? DIR_SDDL : cfgSddl, entries: fs.readdirSync(target).length }) };
    }
    if (journal === "fail") return { code: 1, stdout: "{}", stderr: "TEST raw PowerShell error text that must never be echoed" };
    return { code: 0, stdout: JSON.stringify({ sddl: FILE_SDDL, parentSddl: DIR_SDDL, reparse: false, fileSystem: "NTFS", driveType: "Fixed" }) };
  };
  return { run, calls };
}
const TESTio = (extra = {}) => ({ label: C.TEST_LABEL, runtime: RT, pathPlatform: "linux", fsImpl: fs, ...extra });

/** a disposable TEST layout: state/, config/, qual/ with a TEST qualification record + TEST evidence and a pinned config */
function fixture(t, { qual = {}, cfg = {} } = {}) {
  const root = tmp(t, "ow-r1-");
  for (const d of ["state", "config", "qual"]) fs.mkdirSync(path.join(root, d));
  const stateDir = path.join(root, "state", "operator-effects"); fs.mkdirSync(stateDir);
  const evidence = Buffer.from("TEST-ONLY-NOT-WINDOWS evidence placeholder: no observation was made\n");
  const evidenceFile = path.join(root, "qual", "evidence.txt"); fs.writeFileSync(evidenceFile, evidence);
  const record = { schema: QUALIFICATION_SCHEMA, nodeVersion: RT.version, execSha256: RT.execSha256, flag: UV_FS_O_EXLOCK_NUMERIC, crossProcessOpenRefused: true,
    crossProcessRenameRefused: true, crossProcessDeleteRefused: true, holderDeathReleases: true, sameProcessSecondOpenRefused: true,
    evidenceSha256: sha(evidence), qualifiedBy: "root", ...qual };   // TEST fixture in the reviewed schema; NOT a qualification
  const qualBytes = Buffer.from(JSON.stringify(record));
  const qualificationFile = path.join(root, "qual", "exlock-qualification.json"); fs.writeFileSync(qualificationFile, qualBytes);
  const store = path.join(stateDir, C.STORE_NAME);
  const exclusion = { qualificationFile, qualificationSha256: sha(qualBytes), evidenceFile, evidenceSha256: sha(evidence) };
  const bytes = C.configBytes({ store, domain: { account: ACCOUNT, chainId: CHAIN }, storage: { sddl: FILE_SDDL, parentSddl: DIR_SDDL }, exclusion });
  const json = { ...JSON.parse(bytes), ...cfg };
  const finalBytes = Object.keys(cfg).length ? Buffer.from(JSON.stringify(json)) : bytes;
  const configFile = path.join(root, "config", "operator-effects.json"); fs.writeFileSync(configFile, finalBytes);
  return { root, stateDir, store, configFile, bytes: finalBytes, qualificationFile, evidenceFile, exclusion, record,
    env: { [C.CONFIG_ENV]: configFile, [C.CONFIG_SHA256_ENV]: sha(finalBytes) },
    repin(file, buf) { fs.writeFileSync(file, buf); return sha(buf); } };
}
const domainOK = () => ({ account: ACCOUNT, chainId: CHAIN });

function installFixture(t, extra = {}) {
  const fx = fixture(t);
  fs.rmSync(fx.stateDir, { recursive: true });   // the installer creates it
  fs.rmSync(fx.configFile);
  const legacyDir = path.join(fx.root, "node"); fs.mkdirSync(legacyDir);
  const files = Object.fromEntries(I.RELEASE_FILES.map((rel) => [rel, sha(fs.readFileSync(path.join(CANDIDATE, ...rel.split("/"))))]));
  const manifest = Buffer.from(JSON.stringify({ schema: I.RELEASE_SCHEMA, files }));
  const releaseManifest = path.join(fx.root, "qual", "release.json"); fs.writeFileSync(releaseManifest, manifest);
  const input = { stateDir: fx.stateDir, account: ACCOUNT, chainId: String(CHAIN), serviceAccount: "NT SERVICE\\EnclaveNode", configOut: fx.configFile, legacyDir,
    qualificationFile: fx.qualificationFile, qualificationSha256: fx.exclusion.qualificationSha256, evidenceFile: fx.evidenceFile, evidenceSha256: fx.exclusion.evidenceSha256,
    releaseManifest, releaseManifestSha256: sha(manifest), ...extra };
  const io = testRun({ stateDir: fx.stateDir });
  const TEST = TESTio({ run: io.run, openPlatform: "linux", releaseRoot: CANDIDATE, exclusion: TEST_inProcessExclusion(),
    createStateDir: (d) => fs.mkdirSync(d) });   // TEST hook: a plain temp directory; no ACL is set or observed
  return { fx, input, TEST, calls: io.calls, legacyDir };
}
const nothingCreated = (s) => { assert.equal(fs.existsSync(s.input.stateDir), false); assert.equal(fs.existsSync(s.input.configOut), false); assert.equal(fs.existsSync(I.receiptPath(s.input.configOut)), false); };


// ROOT regressions: actual installer/reads with external TEST runtime and probe answers.
// Source fixtures prove refusal/byte bounds only, never Windows ACL semantics or native qualification.
test('ROOT installer must reject service-writable configuration directory',async(t)=>{
 const s=installFixture(t);
 s.TEST.run=testRun({stateDir:s.input.stateDir,cfgSddl:CFG_SDDL+'(A;OICI;FA;;;S-1-5-80-1-2-3-4-5)'}).run;
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}));
 nothingCreated(s);
});
test('ROOT installer must reject config inaccessible to selected service account',async(t)=>{
 const s=installFixture(t); // config ACL grants ONLY BA/SY; requested NT SERVICE agent has no read permission
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}));
 nothingCreated(s);
});
test('ROOT release verification must include actual owned-durable-state dependency',async(t)=>{
 const s=installFixture(t),j=JSON.parse(fs.readFileSync(s.input.releaseManifest));
 delete j.files['control/network/owned-durable-state.mjs'];
 const b=Buffer.from(JSON.stringify(j));fs.writeFileSync(s.input.releaseManifest,b);s.input.releaseManifestSha256=sha(b);
 await assert.rejects(I.planOperatorEffectsInstall(s.input,{TEST:s.TEST}));
 nothingCreated(s);
});
test('ROOT existing oversized config is refused before unbounded readFileSync',t=>{
 const s=installFixture(t);fs.mkdirSync(s.input.stateDir);fs.writeFileSync(path.join(s.input.stateDir,C.STORE_NAME),'TEST');
 fs.writeFileSync(s.input.configOut,Buffer.alloc(1024*1024,32));fs.writeFileSync(I.receiptPath(s.input.configOut),'{}');
 let unbounded=0;const io=C.ioOf(s.TEST);io.fsImpl={...fs,readFileSync(f,...args){if(f===s.input.configOut)unbounded++;return fs.readFileSync(f,...args);}};
 const v=I.validateInputs(s.input,io);assert.equal(I.inspectInstall(v,io).state,'incomplete-or-foreign');
 assert.equal(unbounded,0,'oversized config must be sized/bounded before read, not after allocation');
});
