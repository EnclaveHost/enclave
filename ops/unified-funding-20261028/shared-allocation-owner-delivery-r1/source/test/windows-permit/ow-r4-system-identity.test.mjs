// ow-r4: explicit NT AUTHORITY\SYSTEM identity slice (operator Windows wiring r4). AUTHORED, NOT RUN.
// Exercises the ACTUAL config parser/loader, ACL evaluators, installer plan/apply and the agent construction seam (operatorEffectsForHost
// -> actual openOperatorEffects). Every external Windows boundary - PowerShell answers, SDDL strings, runtime identity, task data - is a
// labelled TEST-ONLY-NOT-WINDOWS fixture (helpers/ow-fixture.mjs). Nothing here observes a scheduled task, a process, its ancestry, its
// effective NODE_DIR, writer exclusion, EXLOCK or a native ACL; the SYSTEM path is asserted to REFUSE (CutoverUnqualified), never to work.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as C from "../../control/windows/node/operator-effects-config.mjs";
import * as I from "../../control/windows/node/install-operator-effects.mjs";
import { openOperatorEffects } from "../../control/windows/node/operator-effects.mjs";
import { sha, SERVICE, SVC, DIR_SDDL, FILE_SDDL, TESTio, testRun, fixture, domainOK, installFixture, nothingCreated,
  SYSTEM_ACCOUNT, SYSTEM_SID, OBSERVED_LAUNCHER, OWNER_LAUNCHER, SYS_DIR_SDDL, SYS_FILE_SDDL, systemFixture, systemInstallFixture } from "./helpers/ow-fixture.mjs";

const code = (c) => (e) => e.code === c;
const edited = (bytes, f) => { const j = JSON.parse(bytes); f(j); return Buffer.from(JSON.stringify(j)); };
const parse = (b) => C.parseOperatorEffectsConfig(b, { pathPlatform: "linux" });

// ==== identity primitives ===================================================================================================================
test("S1 explicit SYSTEM identity: canonical account + S-1-5-18 + a separately specified launcher; the SID is never taken from the task", () => {
  const a = C.systemIdentity({ account: SYSTEM_ACCOUNT, sid: SYSTEM_SID, launcher: OBSERVED_LAUNCHER });
  assert.deepEqual(a, { account: "NT AUTHORITY\\SYSTEM", name: null, sid: "S-1-5-18", principalType: "local-system", launcher: { ...OBSERVED_LAUNCHER } });
  const b = C.systemIdentity({ account: "nt authority\\system", sid: SYSTEM_SID, launcher: OWNER_LAUNCHER });   // case-insensitive input, canonical output
  assert.equal(b.account, SYSTEM_ACCOUNT); assert.equal(b.sid, a.sid);
  assert.deepEqual(b.launcher, { kind: "scheduled-task", taskPath: "\\Owner Tasks\\Base\\", taskName: "operator-node 2", specifiedBy: "local-machine-owner" });
  assert.equal(C.launcherIdentity({ ...OBSERVED_LAUNCHER, taskPath: "\\", taskName: "EnclaveAgent" }).taskPath, "\\", "a root-folder task is a bounded owner choice too");
  // the virtual-service parser is unchanged: it still refuses SYSTEM in every spelling
  for (const s of [SYSTEM_ACCOUNT, "SYSTEM", "LocalSystem", "NT SERVICE\\..\\SYSTEM"]) assert.throws(() => C.serviceIdentity(s), code("BadServiceIdentity"), s);
  assert.equal(C.serviceIdentity(SERVICE).principalType, "virtual-service-account");
});

test("S2 wrong account/SID and malformed launcher data are refused with their own codes", () => {
  for (const account of ["SYSTEM", "LocalSystem", "NT AUTHORITY\\LocalService", "NT AUTHORITY\\NetworkService", "BUILTIN\\Administrators", "BUILTIN\\Users",
    "Everyone", "CONTOSO\\svc-node", SERVICE, "S-1-5-18", "NT AUTHORITY\\SYSTEM ", "", undefined])
    assert.throws(() => C.systemIdentity({ account, sid: SYSTEM_SID, launcher: OBSERVED_LAUNCHER }), code("BadProcessIdentity"), String(account));
  for (const sid of ["S-1-5-19", "S-1-5-20", "S-1-5-32-544", "S-1-5-18-1", "s-1-5-18", SVC, "", undefined])
    assert.throws(() => C.systemIdentity({ account: SYSTEM_ACCOUNT, sid, launcher: OBSERVED_LAUNCHER }), code("BadProcessIdentity"), String(sid));
  const L = (edit) => { const l = { ...OBSERVED_LAUNCHER }; edit(l); return l; };
  for (const launcher of [null, undefined, "\\Enclave\\Node", L((l) => { delete l.specifiedBy; }), L((l) => { l.approvedBy = "enclave"; }),
    L((l) => { l.kind = "service"; }), L((l) => { l.specifiedBy = "enclave"; }), L((l) => { l.taskPath = "Enclave\\"; }), L((l) => { l.taskPath = "\\Enclave"; }),
    L((l) => { l.taskPath = "\\Enclave\\..\\"; }), L((l) => { l.taskPath = "\\Enclave\\.\\"; }), L((l) => { l.taskPath = "\\\\"; }), L((l) => { l.taskPath = "\\Enclave//"; }),
    L((l) => { l.taskPath = "\\a\\b\\c\\d\\e\\"; }), L((l) => { l.taskPath = "\\" + "x".repeat(65) + "\\"; }), L((l) => { l.taskPath = "\\CON\\"; }),
    L((l) => { l.taskPath = "\\Enclave \\"; }), L((l) => { l.taskPath = "\\En*clave\\"; }), L((l) => { l.taskName = ""; }), L((l) => { l.taskName = "Enclave\\Node"; }),
    L((l) => { l.taskName = "Node."; }), L((l) => { l.taskName = "n".repeat(65); }), L((l) => { l.taskName = "Node\u0000"; }), L((l) => { l.taskName = "NUL"; }),
    L((l) => { l.taskName = 5; })])
    assert.throws(() => C.systemIdentity({ account: SYSTEM_ACCOUNT, sid: SYSTEM_SID, launcher }), code("BadLauncherIdentity"), JSON.stringify(launcher));
});

// ==== ACL evaluation =========================================================================================================================
test("S3 SYSTEM state ACL: exactly the SYSTEM + Administrators full-control entries; duplicate SYSTEM, extra service or broad entries refused", () => {
  assert.equal(C.stateAclProblem(SYS_DIR_SDDL, SYSTEM_SID, { directory: true }), null);
  assert.equal(C.stateAclProblem(SYS_FILE_SDDL, SYSTEM_SID, { directory: false }), null);
  assert.equal(C.stateAclProblem("O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", SYSTEM_SID, { directory: true }), null, "SYSTEM owner is trusted");
  for (const bad of [
    SYS_DIR_SDDL + "(A;OICI;0x12019f;;;SY)",                    // a duplicate SYSTEM "service" entry
    "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;SY)",            // SYSTEM twice, no Administrators
    SYS_DIR_SDDL + `(A;OICI;0x12019f;;;${SVC})`,                // the NT SERVICE shape is not the SYSTEM shape
    SYS_DIR_SDDL + "(A;OICI;FR;;;WD)", SYS_DIR_SDDL + "(A;OICI;FR;;;BU)", SYS_DIR_SDDL + "(A;OICI;FA;;;AU)",
    "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BU)",            // Users in place of Administrators
    "O:BAG:SYD:PAI(A;OICI;0x12019f;;;SY)(A;OICI;FA;;;BA)",      // SYSTEM narrowed: not the trusted full-control entry
    "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(D;OICI;FA;;;BA)",            // a deny in place of the Administrators grant
    "O:BAG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",             // directory DACL not protected
    "O:BUG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",            // untrusted owner
    "O:BAG:SYD:PAI(A;CI;FA;;;SY)(A;OICI;FA;;;BA)",              // wrong inheritance flags
  ]) assert.notEqual(C.stateAclProblem(bad, SYSTEM_SID, { directory: true }), null, bad);
  assert.notEqual(C.stateAclProblem(SYS_FILE_SDDL + "(A;ID;FA;;;SY)", SYSTEM_SID, { directory: false }), null);
});

test("S4 SYSTEM reads: grants to SYSTEM or a group its token carries count; broad or non-trusted write stays refused", () => {
  const trustFile = "O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)", cfgDir = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
  assert.equal(C.aclProblem(trustFile, { serviceSid: SYSTEM_SID, read: C.FILE_READ, deny: "write" }), null);
  assert.equal(C.aclProblem("O:BAG:SYD:AI(A;ID;FA;;;BA)", { serviceSid: SYSTEM_SID, read: C.FILE_READ, deny: "write" }), null, "Administrators is in the SYSTEM token");
  assert.equal(C.aclProblem(cfgDir, { serviceSid: SYSTEM_SID, read: C.DIR_READ, deny: "write", protectedDacl: true, noBroad: true }), null);
  assert.equal(C.aclProblem(cfgDir, { serviceSid: SYSTEM_SID, read: C.DIR_READ, deny: "replace" }), null);
  assert.notEqual(C.aclProblem("O:BAG:SYD:AI(A;ID;FA;;;BA)(D;ID;FR;;;SY)", { serviceSid: SYSTEM_SID, read: C.FILE_READ }), null, "a deny of the read is honoured");
  for (const bad of [trustFile + "(A;ID;FW;;;WD)", trustFile + "(A;ID;0x120116;;;S-1-5-21-1-2-3-1001)", trustFile + "(A;ID;SD;;;BU)"])
    assert.notEqual(C.aclProblem(bad, { serviceSid: SYSTEM_SID, read: C.FILE_READ, deny: "write" }), null, bad);
  assert.notEqual(C.aclProblem(cfgDir + "(A;OICI;SD;;;BU)", { serviceSid: SYSTEM_SID, read: C.DIR_READ, deny: "replace" }), null);
  assert.notEqual(C.aclProblem(cfgDir + "(A;OICI;FR;;;WD)", { serviceSid: SYSTEM_SID, read: C.DIR_READ, noBroad: true }), null, "broad principal denied");
});

test("S5 NT SERVICE semantics retained: own Read+Write state entry, no-write trust inputs, BA/SY-only stays unreadable for the service", (t) => {
  assert.equal(C.stateAclProblem(DIR_SDDL, SVC, { directory: true }), null);
  assert.equal(C.stateAclProblem(FILE_SDDL, SVC, { directory: false }), null);
  assert.notEqual(C.stateAclProblem(SYS_DIR_SDDL, SVC, { directory: true }), null, "the service still needs exactly its own entry");
  assert.notEqual(C.aclProblem("O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)", { serviceSid: SVC, read: C.FILE_READ }), null, "Administrators is NOT in a service token");
  assert.match(C.aclProblem(`O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SVC})`, { serviceSid: SVC, read: C.FILE_READ, deny: "write" }), /service identity may write/);
  const fx = fixture(t);
  assert.throws(() => parse(edited(fx.bytes, (j) => { j.storage = { sddl: SYS_FILE_SDDL, parentSddl: SYS_DIR_SDDL }; })), code("StorageUnqualified"));
  assert.deepEqual(parse(fx.bytes).instance, { serviceAccount: SERVICE, serviceSid: SVC, nodeDir: fx.nodeDir });
});

// ==== config parsing ===========================================================================================================================
test("S6 config /2 SYSTEM instance through the actual loader: observed \\Enclave\\Node and a second non-Enclave owner task", (t) => {
  for (const launcher of [OBSERVED_LAUNCHER, OWNER_LAUNCHER]) {
    const fx = systemFixture(t, { launcher });
    const { config, sha256 } = C.loadOperatorEffectsConfig({ file: fx.configFile, sha256: sha(fx.bytes), pathPlatform: "linux" });
    assert.equal(sha256, sha(fx.bytes));
    assert.deepEqual(config.instance, { processAccount: SYSTEM_ACCOUNT, processSid: SYSTEM_SID, principalType: "local-system", launcher: { ...launcher }, nodeDir: fx.nodeDir });
    assert.equal(Object.hasOwn(config.instance, "serviceSid"), false, "no pretend service SID");
    assert.deepEqual(config.storage, { sddl: SYS_FILE_SDDL, parentSddl: SYS_DIR_SDDL });
    assert.deepEqual(C.configBytes({ store: config.store, domain: config.domain, instance: config.instance, storage: config.storage, exclusion: config.exclusion }), fx.bytes, "canonical round trip");
  }
});

const CONFIG_REFUSALS = [
  ["service and SYSTEM keys mixed", (j) => { j.instance.serviceSid = SVC; }, "Malformed"],
  ["NT SERVICE form carrying a launcher", (j) => { j.instance = { serviceAccount: SERVICE, serviceSid: SVC, launcher: { ...OBSERVED_LAUNCHER }, nodeDir: j.instance.nodeDir }; }, "Malformed"],
  ["non-canonical account spelling", (j) => { j.instance.processAccount = "nt authority\\system"; }, "BadProcessIdentity"],
  ["an NT SERVICE account in the SYSTEM form", (j) => { j.instance.processAccount = SERVICE; }, "BadProcessIdentity"],
  ["a group in the SYSTEM form", (j) => { j.instance.processAccount = "BUILTIN\\Administrators"; }, "BadProcessIdentity"],
  ["the service SID", (j) => { j.instance.processSid = SVC; }, "BadProcessIdentity"],
  ["LocalService SID", (j) => { j.instance.processSid = "S-1-5-19"; }, "BadProcessIdentity"],
  ["relative task path", (j) => { j.instance.launcher.taskPath = "Enclave"; }, "BadLauncherIdentity"],
  ["no launcher", (j) => { j.instance.launcher = null; }, "BadLauncherIdentity"],
  ["an approval field", (j) => { j.instance.launcher.approvedBy = "enclave"; }, "BadLauncherIdentity"],
  ["duplicate SYSTEM state entry", (j) => { j.storage.parentSddl = SYS_DIR_SDDL + "(A;OICI;0x12019f;;;SY)"; }, "StorageUnqualified"],
  ["NT SERVICE three-entry state ACL", (j) => { j.storage = { sddl: FILE_SDDL, parentSddl: DIR_SDDL }; }, "StorageUnqualified"],
  ["Everyone in the journal ACL", (j) => { j.storage.sddl = SYS_FILE_SDDL + "(A;ID;FR;;;WD)"; }, "StorageUnqualified"],
  ["unprotected state directory", (j) => { j.storage.parentSddl = SYS_DIR_SDDL.replace("D:PAI", "D:AI"); }, "StorageUnqualified"],
];
for (const [name, edit, want] of CONFIG_REFUSALS) {
  test(`S7 SYSTEM config refused: ${name} -> ${want}`, (t) => {
    const fx = systemFixture(t);
    assert.throws(() => parse(edited(fx.bytes, edit)), code(want));
  });
}

// ==== runtime construction seam ===============================================================================================================
test("S8 runtime seam: a well-formed SYSTEM config is recognised, then refused CutoverUnqualified before NODE_DIR, legacy, exclusion or any probe", async (t) => {
  for (const launcher of [OBSERVED_LAUNCHER, OWNER_LAUNCHER]) {
    const fx = systemFixture(t, { launcher }), { run, calls } = testRun({ processSid: SYSTEM_SID });
    fs.writeFileSync(path.join(fx.nodeDir, "operator-writes.json"), "{not json");   // legacy files are not consulted either
    const before = fs.readdirSync(fx.stateDir);
    for (const env of [fx.env,
      { ...fx.env, NODE_DIR: path.join(fx.root, "elsewhere") },                                            // NODE_DIR is not compared or inferred
      { ...fx.env, ENCLAVE_SYSTEM_CUTOVER_QUALIFIED: "1", ENCLAVE_OPERATOR_EFFECTS_SYSTEM: "true" }]) {     // no environment Boolean lifts it
      const r = C.operatorEffectsForHost({ env, actualDomain: domainOK, TEST: TESTio({ run, cutoverQualified: true, systemQualified: true }) });
      assert.equal(r.state, "refused"); assert.match(r.reason, /\(CutoverUnqualified\)/);
      assert.equal(r.store, null); assert.equal(r.configSha256, null); assert.equal(r.option.refused, r.reason); assert.equal(Object.hasOwn(r.option, "file"), false);
      assert.doesNotMatch(r.reason, /O:BA|D:P|TEST raw PowerShell/);
      await assert.rejects(r.option.storage.run("anything"), code("OperatorEffectsConfigRefused"));
      assert.throws(() => r.option.exclusion.open("/anything"), code("OperatorEffectsConfigRefused"));
      const absent = path.join(fx.root, "never-created.journal");   // through the ACTUAL openOperatorEffects: refused before any fs access
      await assert.rejects(openOperatorEffects(absent, { ...r.option, domain: domainOK() }), code("OperatorEffectsConfigRefused"));
      assert.equal(fs.existsSync(absent), false);
    }
    assert.deepEqual(calls, [], "no identity, storage or task probe: nothing is observed, so nothing is invented");
    assert.deepEqual(fs.readdirSync(fx.stateDir), before, "no journal or other state artifact");
  }
  const e = C.systemCutoverUnqualified("x");
  assert.equal(e.code, "CutoverUnqualified"); assert.deepEqual(e.unproven, [...C.SYSTEM_CUTOVER_UNPROVEN]);
  assert.deepEqual(C.SYSTEM_CUTOVER_UNPROVEN, ["continuous old-writer exclusion", "effective NODE_DIR of the running process", "scheduled-task-to-process ancestry"]);
});

test("S9 runtime seam: malformed SYSTEM bindings refuse with their own codes; a SYSTEM process cannot use an NT SERVICE config", async (t) => {
  for (const [edit, want] of [[(j) => { j.instance.processSid = "S-1-5-19"; }, /BadProcessIdentity/], [(j) => { j.instance.launcher.taskName = "a\\b"; }, /BadLauncherIdentity/]]) {
    const fx = systemFixture(t), { run, calls } = testRun();
    const pin = fx.repin(fx.configFile, edited(fx.bytes, edit));
    const r = C.operatorEffectsForHost({ env: { ...fx.env, [C.CONFIG_SHA256_ENV]: pin }, actualDomain: domainOK, TEST: TESTio({ run }) });
    assert.equal(r.state, "refused"); assert.match(r.reason, want); assert.deepEqual(calls, []);
  }
  // NT SERVICE config (default fixture) is still configured; the existing running-identity check refuses a process reporting S-1-5-18
  const fx = fixture(t), { run, calls } = testRun({ processSid: SYSTEM_SID });
  const r = C.operatorEffectsForHost({ env: fx.env, actualDomain: domainOK, TEST: TESTio({ run }) });
  assert.equal(r.state, "configured", r.reason); assert.deepEqual(calls, []);
  await assert.rejects(r.option.storage.run("storage probe"), code("ServiceIdentityMismatch"));
  assert.equal(calls.length, 1, "only the identity probe ran; the storage probe never did");
});

// ==== installer ================================================================================================================================
test("S10 installer: SYSTEM plan and apply refuse CutoverUnqualified right after input validation; no probe, marker, state, journal, config or receipt", async (t) => {
  const isCutover = (e) => e.code === "CutoverUnqualified" && e.unproven.join("|") === C.SYSTEM_CUTOVER_UNPROVEN.join("|");
  for (const launcher of [OBSERVED_LAUNCHER, OWNER_LAUNCHER]) {
    const s = systemInstallFixture(t, launcher);
    await assert.rejects(I.planOperatorEffectsInstall(s.input, { TEST: s.TEST }), isCutover);
    await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), isCutover);
    await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: { ...s.TEST, cutoverQualified: true } }), isCutover, "a caller Boolean changes nothing");
    await assert.rejects(I.applyOperatorEffectsInstall(s.input, { TEST: s.TEST }), code("NotConfirmed"));
    assert.deepEqual(s.calls, [], "no directory, ACL, account or task probe");
    nothingCreated(assert, s);
    assert.equal(fs.existsSync(path.join(s.input.stateDir, C.STORE_NAME)), false);
  }
  const m = systemInstallFixture(t); delete m.input.migrationEvidence; delete m.input.migrationEvidenceSha256;   // the base (r1-shaped) SYSTEM form parses too
  await assert.rejects(I.planOperatorEffectsInstall(m.input, { TEST: m.TEST }), isCutover);
  nothingCreated(assert, m);
});

const SYSTEM_INPUT_REFUSALS = [
  ["wrong process SID", (s) => { s.input.processSid = "S-1-5-19"; }, /BadProcessIdentity/],
  ["the service SID as process SID", (s) => { s.input.processSid = SVC; }, /BadProcessIdentity/],
  ["bare SYSTEM", (s) => { s.input.processAccount = "SYSTEM"; }, /BadProcessIdentity/],
  ["a user", (s) => { s.input.processAccount = "CONTOSO\\node-user"; }, /BadProcessIdentity/],
  ["a group", (s) => { s.input.processAccount = "BUILTIN\\Administrators"; }, /BadProcessIdentity/],
  ["NT SERVICE in the SYSTEM form", (s) => { s.input.processAccount = SERVICE; }, /BadProcessIdentity/],
  ["relative task path", (s) => { s.input.launcherTaskPath = "Enclave\\"; }, /BadLauncherIdentity/],
  ["dot task folder", (s) => { s.input.launcherTaskPath = "\\Enclave\\..\\"; }, /BadLauncherIdentity/],
  ["task name with a separator", (s) => { s.input.launcherTaskName = "Enclave\\Node"; }, /BadLauncherIdentity/],
  ["over-long task name", (s) => { s.input.launcherTaskName = "n".repeat(65); }, /BadLauncherIdentity/],
  ["missing task name", (s) => { delete s.input.launcherTaskName; }, /exactly/],
  ["serviceAccount beside the SYSTEM form", (s) => { s.input.serviceAccount = SERVICE; }, /exactly/],
  ["NT SERVICE form with launcher inputs", (s) => { delete s.input.processAccount; delete s.input.processSid; s.input.serviceAccount = SERVICE; }, /exactly/],
  ["a qualification flag as input", (s) => { s.input.cutoverQualified = "true"; }, /exactly/],
];
for (const [name, mutate, msg] of SYSTEM_INPUT_REFUSALS) {
  test(`S11 installer refuses SYSTEM input: ${name} -> BadInput; nothing probed or created`, async (t) => {
    const s = systemInstallFixture(t); mutate(s);
    await assert.rejects(I.planOperatorEffectsInstall(s.input, { TEST: s.TEST }), (e) => e.code === "BadInput" && msg.test(e.message));
    await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), code("BadInput"));
    assert.deepEqual(s.calls, []); nothingCreated(assert, s);
  });
}

test("S12 NT SERVICE installer path and CLI retained; the SYSTEM flags parse as plain strings", async (t) => {
  const s = installFixture(t);
  const plan = await I.planOperatorEffectsInstall(s.input, { TEST: s.TEST });
  assert.deepEqual(plan.serviceIdentity, { account: SERVICE, sid: SVC, principalType: "virtual-service-account" });
  nothingCreated(assert, s);
  assert.deepEqual(I.parseArgs(["--process-account", SYSTEM_ACCOUNT, "--process-sid", SYSTEM_SID, "--launcher-task-path", "\\Owner Tasks\\", "--launcher-task-name", "Node"]).input,
    { processAccount: SYSTEM_ACCOUNT, processSid: SYSTEM_SID, launcherTaskPath: "\\Owner Tasks\\", launcherTaskName: "Node" });
  assert.throws(() => I.parseArgs(["--cutover-qualified", "true"]), code("BadInput"));
});
