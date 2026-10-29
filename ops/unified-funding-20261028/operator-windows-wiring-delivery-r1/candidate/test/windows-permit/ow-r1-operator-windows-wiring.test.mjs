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
import * as C from "../../control/windows/node/operator-effects-config.mjs";
import * as I from "../../control/windows/node/install-operator-effects.mjs";
import { openOperatorEffects, initializeOperatorEffects } from "../../control/windows/node/operator-effects.mjs";
import { storageProbeScript, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { NODE_RUNTIME_PIN, QUALIFICATION_SCHEMA, UV_FS_O_EXLOCK_NUMERIC } from "../../control/windows/vbslike/manager/win-exclusion.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const ACCOUNT = "0x" + "11".repeat(20), OTHER = "0x" + "99".repeat(20), CHAIN = 8453;
const RT = Object.freeze({ platform: "win32", version: NODE_RUNTIME_PIN.version, execPath: NODE_RUNTIME_PIN.execPath, execSha256: NODE_RUNTIME_PIN.execSha256 });   // TEST runtime
// TEST SDDL strings (shape only; no Windows ACL was observed)
const DIR_SDDL = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x12019f;;;S-1-5-80-1-2-3-4-5)";
const FILE_SDDL = "O:BAG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x12019f;;;S-1-5-80-1-2-3-4-5)";
const CFG_SDDL = "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
const CANDIDATE = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
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

// ==== A. the shared loader ==================================================================================================================
test("A1 positive: the exact pinned config bytes become exactly these Host options (TEST: production false)", (t) => {
  const fx = fixture(t), { run, calls } = testRun();
  const r = C.operatorEffectsForHost({ env: fx.env, actualDomain: domainOK, TEST: TESTio({ run }) });
  assert.equal(r.state, "configured", r.reason); assert.equal(r.production, false);
  assert.equal(r.configSha256, sha(fx.bytes)); assert.equal(r.store, fx.store);
  assert.equal(r.option.file, fx.store); assert.equal(r.option.backend, "windows-owned-log"); assert.equal(r.option.platform, "win32");
  assert.equal(r.option.storage.sddl, FILE_SDDL); assert.equal(r.option.storage.parentSddl, DIR_SDDL);
  assert.equal(r.option.exclusion.name, "windows-exlock"); assert.equal(r.option.exclusion.basis, `numeric-qualified:${fx.exclusion.evidenceSha256}`);
  assert.equal(Object.hasOwn(r.option, "refused"), false);
  assert.deepEqual(calls, [], "loading probes nothing; the storage probe belongs to the open");
  const { config } = C.loadOperatorEffectsConfig({ file: fx.configFile, sha256: sha(fx.bytes), pathPlatform: "linux" });
  assert.deepEqual(config.runtime, { ...NODE_RUNTIME_PIN }); assert.deepEqual(config.domain, { account: ACCOUNT, chainId: CHAIN });
});

const REFUSALS = [
  ["no config named", (fx) => ({ env: {} }), /NotConfigured/],
  ["no pin", (fx) => ({ env: { [C.CONFIG_ENV]: fx.configFile } }), /NotConfigured/],
  ["tampered config byte", (fx) => { fs.appendFileSync(fx.configFile, " "); return {}; }, /DigestMismatch/],
  ["malformed config (re-pinned)", (fx) => ({ env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from("{not json")) } }), /Malformed/],
  ["unknown config field", (fx) => { const j = { ...JSON.parse(fx.bytes), extra: 1 }; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /Malformed/],
  ["missing config field", (fx) => { const j = JSON.parse(fx.bytes); delete j.storage; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /Malformed/],
  ["config widens the runtime pin", (fx) => { const j = JSON.parse(fx.bytes); j.runtime.version = "v24.16.1"; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /RuntimeDrift/],
  ["actual executable differs", () => ({ TEST: { runtime: { ...RT, execSha256: "f".repeat(64) } } }), /RuntimeDrift/],
  ["actual Node version differs", () => ({ TEST: { runtime: { ...RT, version: "v24.17.0" } } }), /RuntimeDrift/],
  ["named constant with another value", () => ({ TEST: { fsImpl: { ...fs, constants: { ...fs.constants, UV_FS_O_EXLOCK: 1 } } } }), /RuntimeDrift/],
  ["named-constant kind selected", (fx) => { const j = JSON.parse(fx.bytes); j.exclusion.kind = "named-exlock"; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /ExclusionRefused/],
  ["unqualified numeric flag", (fx) => { const j = JSON.parse(fx.bytes); j.exclusion.flag = 0x20000000; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /ExclusionRefused/],
  ["tampered qualification bytes", (fx) => { fs.appendFileSync(fx.qualificationFile, " "); return {}; }, /DigestMismatch/],
  ["qualification with a false observation", (fx) => { const q = Buffer.from(JSON.stringify({ ...fx.record, holderDeathReleases: false })); const h = fx.repin(fx.qualificationFile, q);
    const j = JSON.parse(fx.bytes); j.exclusion.qualificationSha256 = h; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /QualificationRefused/],
  ["qualification names other evidence", (fx) => { const q = Buffer.from(JSON.stringify({ ...fx.record, evidenceSha256: "e".repeat(64) })); const h = fx.repin(fx.qualificationFile, q);
    const j = JSON.parse(fx.bytes); j.exclusion.qualificationSha256 = h; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /QualificationRefused/],
  ["named evidence absent", (fx) => { fs.rmSync(fx.evidenceFile); return {}; }, /Absent/],
  ["cross-build probe artifact as qualification", (fx) => { const j = JSON.parse(fx.bytes); j.exclusion.qualificationSha256 = C.NOT_QUALIFICATION[1]; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /QualificationRefused/],
  ["missing SDDL", (fx) => { const j = JSON.parse(fx.bytes); j.storage.sddl = ""; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /StorageUnqualified/],
  ["unprotected directory DACL", (fx) => { const j = JSON.parse(fx.bytes); j.storage.parentSddl = DIR_SDDL.replace("D:PAI", "D:AI"); return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /StorageUnqualified/],
  ["Everyone in the journal ACL", (fx) => { const j = JSON.parse(fx.bytes); j.storage.sddl = FILE_SDDL + "(A;;FA;;;WD)"; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /StorageUnqualified/],
  ["another store name", (fx) => { const j = JSON.parse(fx.bytes); j.store = path.join(fx.stateDir, "x.journal"); return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /BadPath/],
  ["relative / dotted store path", (fx) => { const j = JSON.parse(fx.bytes); j.store = fx.stateDir + "/../operator-effects/" + C.STORE_NAME; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /BadPath/],
  ["config inside the writable state directory", (fx) => { const f = path.join(fx.stateDir, "operator-effects.json"); fs.copyFileSync(fx.configFile, f); return { env: { [C.CONFIG_ENV]: f, [C.CONFIG_SHA256_ENV]: sha(fx.bytes) } }; }, /BadPath/],
  ["config through a symbolic link", (fx) => { const l = path.join(fx.root, "config", "link.json"); fs.symlinkSync(fx.configFile, l); return { env: { ...fx.env, [C.CONFIG_ENV]: l } }; }, /BadPath/],
  ["hard-linked config (link ambiguity)", (fx) => { fs.linkSync(fx.configFile, path.join(fx.root, "config", "second.json")); return {}; }, /BadPath|BadFile/],
  ["non-canonical (uppercase) account", (fx) => { const j = JSON.parse(fx.bytes); j.domain.account = "0x" + "AB".repeat(20); return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /BadDomain/],
  ["string chain id", (fx) => { const j = JSON.parse(fx.bytes); j.domain.chainId = "8453"; return { env: { ...fx.env, [C.CONFIG_SHA256_ENV]: fx.repin(fx.configFile, Buffer.from(JSON.stringify(j))) } }; }, /BadDomain/],
  ["unsupported platform with a config named", () => ({ TEST: { runtime: { ...RT, platform: "linux" } } }), /UnsupportedPlatform/],
  ["unlabelled TEST injection", () => ({ TEST: { label: "production" } }), /TestRefused/],
];
for (const [name, mutate, code] of REFUSALS) {
  test(`A2 refused: ${name} -> REFUSING options, no probe, no file access at open`, async (t) => {
    const fx = fixture(t), { run, calls } = testRun();
    const m = mutate(fx) ?? {};
    const r = C.operatorEffectsForHost({ env: m.env ?? fx.env, actualDomain: domainOK, TEST: TESTio({ run, ...(m.TEST ?? {}) }) });
    assert.equal(r.state, "refused"); assert.match(r.reason, code); assert.equal(r.option.refused, r.reason); assert.equal(Object.hasOwn(r.option, "file"), false);
    assert.doesNotMatch(r.reason, /O:BA|D:P|TEST raw PowerShell/, "no ACL/config bytes or raw PowerShell text in diagnostics");
    await assert.rejects(r.option.storage.run("anything"), (e) => e.code === "OperatorEffectsConfigRefused");
    assert.throws(() => r.option.exclusion.open("/anything"), (e) => e.code === "OperatorEffectsConfigRefused");
    // through the ACTUAL openOperatorEffects: refused before any fs access; nothing is created
    const absent = path.join(fx.root, "never-created.journal");
    await assert.rejects(openOperatorEffects(absent, { ...r.option, domain: domainOK() }), (e) => e.code === "OperatorEffectsConfigRefused");
    assert.equal(fs.existsSync(absent), false); assert.deepEqual(calls, []);
  });
}

test("A3 Windows path rules: UNC, device, relative, stream, dot, short-name, reserved and separator forms refused", () => {
  assert.equal(C.windowsPathProblem("C:\\ProgramData\\Enclave\\operator-effects\\operator-effects.journal"), null);
  for (const p of ["\\\\server\\share\\x.journal", "\\\\?\\C:\\x\\y", "\\\\.\\pipe\\x", "C:x\\y", "x\\y", "C:\\a\\b:stream", "C:\\a\\..\\b", "C:\\a\\.\\b",
    "C:\\PROGRA~1\\x", "C:\\a\\b.", "C:\\a\\b ", "C:\\a\\CON\\b", "C:\\a\\nul.txt", "C:\\a/b", "C:\\a\\\\b", "C:\\a\\b*"])
    assert.notEqual(C.windowsPathProblem(p), null, p);
});

test("A4 identity: the loaded key's ACTUAL account/chain must equal the config domain before any probe; configuration never selects the signer", async (t) => {
  const fx = fixture(t), { run, calls } = testRun();
  let actual = { account: OTHER, chainId: CHAIN };
  const r = C.operatorEffectsForHost({ env: fx.env, actualDomain: () => actual, TEST: TESTio({ run }) });
  await assert.rejects(r.option.storage.run(storageProbeScript(fx.store)), (e) => e.code === "ForeignDomain");
  assert.throws(() => r.option.exclusion.open(fx.store), (e) => e.code === "ForeignDomain");
  actual = { account: ACCOUNT, chainId: 1 };
  await assert.rejects(r.option.storage.run("x"), (e) => e.code === "ForeignDomain");
  actual = { account: null, chainId: CHAIN };
  await assert.rejects(r.option.storage.run("x"), (e) => e.code === "OperatorIdentityUnavailable");
  assert.deepEqual(calls, [], "no PowerShell for a foreign or unknown identity");
  actual = { account: ACCOUNT, chainId: CHAIN };
  await r.option.storage.run(storageProbeScript(fx.store));
  assert.deepEqual(calls, [storageProbeScript(fx.store)]);
});

test("A5 Linux honesty: the real numeric exclusion refuses (flag ignored -> second open succeeded); no unlocked fallback, store bytes unchanged", async (t) => {
  const fx = fixture(t), { run } = testRun();
  await initializeOperatorEffects(fx.store, { domain: domainOK(), backend: "windows-owned-log", platform: "linux", exclusion: TEST_inProcessExclusion() });   // TEST store
  const before = fs.readFileSync(fx.store);
  const r = C.operatorEffectsForHost({ env: fx.env, actualDomain: domainOK, TEST: TESTio({ run, openPlatform: "linux" }) });
  assert.equal(r.state, "configured", r.reason);
  const { file, ...opts } = r.option;
  await assert.rejects(openOperatorEffects(file, { ...opts, domain: domainOK() }), (e) => e.code === "StoreUnavailable" && /ignored|EXLOCK/.test(e.message));
  assert.deepEqual(fs.readFileSync(fx.store), before);
});

test("A6 missing established journal: refused, never created", async (t) => {
  const fx = fixture(t), { run } = testRun();
  const r = C.operatorEffectsForHost({ env: fx.env, actualDomain: domainOK, TEST: TESTio({ run, openPlatform: "linux" }) });
  const { file, ...opts } = r.option;
  await assert.rejects(openOperatorEffects(file, { ...opts, domain: domainOK() }), (e) => e.code === "StoreUnavailable");
  assert.equal(fs.existsSync(fx.store), false);
});

// ==== B. the actual construction seam: agent.mjs source -> Host -> chain.setOperatorEffects -> openOperatorEffects ========================
test("B0 agent.mjs builds Host with exactly the seam's option (static source check; agent is never imported)", () => {
  const src = fs.readFileSync(new URL("../../control/windows/node/agent.mjs", import.meta.url), "utf8");
  const seam = src.indexOf("operatorEffectsForHost({ env: process.env, actualDomain: () => ({ account: operatorAddress(), chainId: publicClient().chain?.id }) })");
  const host = src.indexOf("const host = new Host({"), opt = src.indexOf("operatorEffects: OPERATOR_EFFECTS.option,");
  assert.ok(seam > 0 && seam < host && host < opt, "the seam runs before Host construction and its option is passed to it");
  assert.doesNotMatch(src, /TEST_inProcessExclusion|TEST-ONLY-NOT-WINDOWS|initializeOperatorEffects\(/, "no TEST exclusion or initialization in the agent");
  assert.doesNotMatch(src, /^import[^;]*(install-operator-effects|initialize-operator-effects|win-durable|win-exclusion)/m, "the agent imports no installer and no raw exclusion");
});

const hostURL = new URL("../../control/windows/node/host.mjs", import.meta.url);
const chainURL = new URL("../../control/windows/node/chain.mjs", import.meta.url);
const S = { writes: [] };
globalThis.__owR1 = S;
const chainDoubles = {
  viem: `const s=globalThis.__owR1;
  export const createPublicClient=(o)=>({chain:o?.chain,simulateContract:async()=>{},getTransactionCount:async()=>0,waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async()=>null});
  export const createWalletClient=()=>({writeContract:async(o)=>{s.writes.push(o.functionName);return '0x'+'ab'.repeat(32);}});
  export const http=()=>null,fallback=()=>null,keccak256=()=>'0x'+'a1'.repeat(32),toBytes=()=>null,getAddress=x=>x,formatEther=x=>String(x),stringToHex=x=>x,pad=x=>x;`,
  "viem/accounts": "export const privateKeyToAccount=()=>({address:'0x'+'11'.repeat(20),label:'TEST inert account; no signer'});",
  "viem/chains": "export const base={id:8453};",
  "./host-admission.bundle.mjs": "export const loadContractPins=()=>null;",
  "./waf.mjs": "export const parseWaf=()=>({});",
  "./verification-checkpoints.mjs": "export const planCheckpoints=()=>[];",
  "./lease-gas-runtime.bundle.mjs": "export const leaseGasConfigured=()=>false,loadLeaseGasConfig=()=>{throw Error('TEST no sponsored path');},configuredLeaseSender=()=>{throw Error('TEST no sponsored path');},openReleaseJournal=()=>null;",
};
const hostExports = new Map();
for (const m of fs.readFileSync(hostURL, "utf8").matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm)) {
  if (!m[2].startsWith(".") || m[2] === "./chain.mjs" || m[2] === "./protected-supervisor.mjs") continue;
  hostExports.set(m[2], m[1].trim().startsWith("{") ? m[1].replace(/[{}]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : []);
}
const hostImpl = { desktopReleaseFromEnv: "()=>null", loadCaps: "()=>({caps:{paused:false,cpuShare:1,gpuShare:1},error:null})", hostAdmissionFromEnv: "()=>null",
  createHostServiceGate: "()=>({enabled:false,serviceRefusal:()=>null,newWorkRefusal:()=>null,start(){}})", shieldStartupEnvelope: "()=>null" };
const data = (src) => ({ url: "data:text/javascript;base64," + Buffer.from(src).toString("base64"), shortCircuit: true });
const hooks = registerHooks({ resolve(spec, ctx, next) {
  const [parent, query] = String(ctx.parentURL ?? "").split("?");
  if (parent === hostURL.href && spec.startsWith(".")) {
    if (spec === "./chain.mjs") return { url: `${chainURL.href}?${query}`, shortCircuit: true };   // one fresh chain per Host instance
    if (spec === "./protected-supervisor.mjs") return next(spec, ctx);
    const names = hostExports.get(spec); if (!names) throw Error("TEST unlisted host dependency " + spec);
    return data(names.map((n) => `export const ${n}=${hostImpl[n] || `(...a)=>{throw Error(${JSON.stringify("TEST unexpected dependency " + spec + ":" + n)});}`};`).join("\n"));
  }
  if (parent === chainURL.href && Object.hasOwn(chainDoubles, spec)) return data(chainDoubles[spec]);
  return next(spec, ctx);
} });
const saved = { key: process.env.NODE_OPERATOR_KEY, fx: process.env.ENCLAVE_OPERATOR_EFFECTS };
const live = new Set();
test.after(async () => {
  for (const m of live) await m.releaseOperatorEffects("TEST end").catch(() => {});
  hooks.deregister(); delete globalThis.__owR1;
  if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key;
  if (saved.fx === undefined) delete process.env.ENCLAVE_OPERATOR_EFFECTS; else process.env.ENCLAVE_OPERATOR_EFFECTS = saved.fx;
});
let serial = 0;
/** the seam exactly as agent.mjs calls it (actualDomain reads the ACTUAL chain module), then the ACTUAL Host constructor */
async function hostWith(env, TEST, dir) {
  delete process.env.ENCLAVE_OPERATOR_EFFECTS;
  const q = `ow-r1-${++serial}`;
  const { Host } = await import(`${hostURL.href}?${q}`);
  const chain = await import(`${chainURL.href}?${q}`); live.add(chain);
  const seam = C.operatorEffectsForHost({ env, actualDomain: () => ({ account: chain.operatorAddress(), chainId: chain.publicClient().chain?.id }), TEST });
  const host = new Host({ dir, endpoint: "TEST", appsEnabled: true, ownerStartup: null, walletAdmission: null, operatorEffects: seam.option });
  process.env.NODE_OPERATOR_KEY = "0x" + "11".repeat(32);
  try { chain.loadOperator(); } finally { if (saved.key === undefined) delete process.env.NODE_OPERATOR_KEY; else process.env.NODE_OPERATOR_KEY = saved.key; }
  chain.addresses.deployments = "0x" + "44".repeat(20);
  return { host, chain, seam };
}
const dep = "0x" + "22".repeat(32);

test("B1 configured seam through the actual Host/chain: storage probe of EXACTLY the pinned store first, then the platform refuses; no write", async (t) => {
  const fx = fixture(t), { run, calls } = testRun(), dir = tmp(t, "ow-r1-host-");
  S.writes = [];
  const { host, chain, seam } = await hostWith(fx.env, TESTio({ run }), dir);
  assert.equal(seam.state, "configured", seam.reason); assert.equal(host.operatorEffectsRefusal, null);
  await assert.rejects(chain.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true);
  assert.deepEqual(calls, [storageProbeScript(fx.store)], "the ACL/NTFS/fixed probe ran for the configured store, before the journal was opened");
  assert.deepEqual(S.writes, [], "nothing signed or sent");
  assert.match(chain.operatorEffectsStatus().ownership, /refused/, "TEST POSIX path under the win32 path rules: refused, not opened");
  assert.equal(host.operatorEffectsReadiness().available, false);
  assert.equal(fs.existsSync(path.join(dir, "operator-effects.journal")), false, "the Host default path is not used when a store is configured");
});

test("B2 refused seam through the actual Host/chain: zero initialization/writes/signatures/probes; readiness says why; read-only paths stay", async (t) => {
  const fx = fixture(t), { run, calls } = testRun(), dir = tmp(t, "ow-r1-host-");
  fs.appendFileSync(fx.configFile, " ");   // tampered
  S.writes = [];
  const before = fs.readdirSync(dir).sort();
  const { host, chain, seam } = await hostWith(fx.env, TESTio({ run }), dir);
  assert.equal(seam.state, "refused");
  assert.equal(host.operatorEffectsRefusal, seam.reason);
  await assert.rejects(chain.renewDeployment(dep, { gate: () => null }), (e) => e.notSent === true && e.code === "OperatorEffectsConfigRefused");
  await assert.rejects(chain.withdrawEarnings("0x" + "55".repeat(20)), (e) => e.notSent === true);
  assert.deepEqual(S.writes, []); assert.deepEqual(calls, []);
  const ready = host.operatorEffectsReadiness();
  assert.equal(ready.available, false); assert.equal(ready.configuration, "refused"); assert.match(ready.refused, /DigestMismatch/);
  assert.doesNotThrow(() => chain.operatorEffectsStatus(), "read-only diagnostics never throw");
  assert.equal(fs.existsSync(path.join(dir, "operator-effects.journal")), false, "never created at startup");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /operator-effects/.test(f)), before.filter((f) => /operator-effects/.test(f)));
  assert.equal(fs.existsSync(fx.store), false);
});

// ==== C. the explicit installer =================================================================================================================
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

test("C1 plan (default) is read-only: every preflight check, sanitized plan, nothing created", async (t) => {
  const s = installFixture(t);
  const plan = await I.planOperatorEffectsInstall(s.input, { TEST: s.TEST });
  assert.equal(plan.mode, "plan"); assert.equal(plan.writes, "none"); assert.equal(plan.production, false);
  assert.deepEqual(plan.checks, ["inputs", "nothing-exists", "release-pinned", "runtime-pin+qualification+exclusion", "legacy-clear", "state-parent", "config-directory"]);
  assert.equal(plan.store, path.join(s.input.stateDir, C.STORE_NAME));
  assert.ok(s.calls.every((c) => c.includes("Get-ChildItem")), "only read-only directory probes");
  nothingCreated(s);
});

const PLAN_REFUSALS = [
  ["legacy r12 records", (s) => fs.writeFileSync(path.join(s.legacyDir, "operator-writes.json"), JSON.stringify({ records: { x: {} } })), /LegacyObligations/],
  ["store evidence at the legacy default", (s) => fs.writeFileSync(path.join(s.legacyDir, C.STORE_NAME + ".established"), "x"), /LegacyObligations/],
  ["release manifest omits a chain file", (s) => { const b = Buffer.from(JSON.stringify({ schema: I.RELEASE_SCHEMA, files: {} })); fs.writeFileSync(s.input.releaseManifest, b); s.input.releaseManifestSha256 = sha(b); }, /ReleaseUnpinned/],
  ["release file differs from its pin", (s) => { const j = JSON.parse(fs.readFileSync(s.input.releaseManifest)); j.files["control/windows/node/chain.mjs"] = "0".repeat(64); const b = Buffer.from(JSON.stringify(j)); fs.writeFileSync(s.input.releaseManifest, b); s.input.releaseManifestSha256 = sha(b); }, /DigestMismatch/],
  ["runtime drift", (s) => { s.TEST.runtime = { ...RT, execSha256: "f".repeat(64) }; }, /RuntimeDrift/],
  ["missing qualification", (s) => fs.rmSync(s.input.qualificationFile), /Absent/],
  ["cross-build launcher as qualification", (s) => { s.input.qualificationSha256 = C.NOT_QUALIFICATION[0]; }, /QualificationRefused/],
  ["config inside the state directory", (s) => { s.input.configOut = path.join(s.input.stateDir, "operator-effects.json"); }, /BadPath/],
  ["a group as the service account", (s) => { s.input.serviceAccount = "BUILTIN\\Users"; }, /BadInput/],
  ["a key-shaped account", (s) => { s.input.account = "0x" + "ab".repeat(32); }, /BadDomain/],
  ["unknown input (e.g. a key)", (s) => { s.input.privateKey = "0x" + "ab".repeat(32); }, /BadInput/],
  ["non-Windows runtime", (s) => { s.TEST.runtime = { ...RT, platform: "linux" }; }, /UnsupportedPlatform/],
  ["broad config directory ACL", (s) => { s.TEST.run = testRun({ stateDir: s.input.stateDir, cfgSddl: CFG_SDDL + "(A;OICI;FA;;;BU)" }).run; }, /StorageUnqualified/],
  ["storage probe timeout", (s) => { s.TEST.run = testRun({ stateDir: s.input.stateDir, timeoutOn: "Get-ChildItem" }).run; }, /ProbeFailed/],
];
for (const [name, mutate, code] of PLAN_REFUSALS) {
  test(`C2 plan refuses: ${name}; nothing created`, async (t) => {
    const s = installFixture(t); mutate(s);
    await assert.rejects(I.planOperatorEffectsInstall(s.input, { TEST: s.TEST }), (e) => code.test(e.code) && !/TEST raw PowerShell/.test(e.message));
    await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), (e) => code.test(e.code));
    nothingCreated(s);
  });
}

test("C3 apply needs the explicit confirmation; without it nothing is created", async (t) => {
  const s = installFixture(t);
  await assert.rejects(I.applyOperatorEffectsInstall(s.input, { TEST: s.TEST }), (e) => e.code === "NotConfirmed");
  await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: "yes", TEST: s.TEST }), (e) => e.code === "NotConfirmed");
  nothingCreated(s);
});

test("C4 TEST apply in disposable storage: exact config bytes the runtime loader accepts, established domain, one owner; rerun is non-destructive", async (t) => {
  const s = installFixture(t);
  const receipt = await I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST });
  assert.equal(receipt.production, false); assert.match(receipt.label, /TEST-ONLY-NOT-WINDOWS/);
  assert.deepEqual(receipt.storage, { sddl: FILE_SDDL, parentSddl: DIR_SDDL }, "the OBSERVED (TEST) ACLs are what gets pinned");
  assert.equal(receipt.activation.performed, false);
  const bytes = fs.readFileSync(s.input.configOut);
  assert.deepEqual(bytes, C.configBytes({ store: receipt.store, domain: { account: ACCOUNT, chainId: CHAIN }, storage: receipt.storage, exclusion: s.fx.exclusion }));
  assert.equal(receipt.configSha256, sha(bytes));
  assert.doesNotMatch(JSON.stringify(receipt), /privateKey|NODE_OPERATOR_KEY/);
  // the runtime seam accepts exactly the installed config; on Linux its real exclusion then refuses (honest), never an unlocked open
  const env = { [C.CONFIG_ENV]: s.input.configOut, [C.CONFIG_SHA256_ENV]: receipt.configSha256 };
  const r = C.operatorEffectsForHost({ env, actualDomain: domainOK, TEST: TESTio({ run: s.TEST.run, openPlatform: "linux" }) });
  assert.equal(r.state, "configured", r.reason); assert.equal(r.option.file, receipt.store);
  const { file, ...opts } = r.option;
  await assert.rejects(openOperatorEffects(file, { ...opts, domain: domainOK() }), (e) => e.code === "StoreUnavailable");
  // the store logic under the labelled TEST exclusion: established for this domain, empty, a second owner refused, a foreign domain refused
  const X = TEST_inProcessExclusion(), W = { backend: "windows-owned-log", platform: "linux", exclusion: X };
  const store = await openOperatorEffects(receipt.store, { ...W, domain: domainOK() });
  assert.equal(store.records().length, 0);
  await assert.rejects(openOperatorEffects(receipt.store, { ...W, domain: domainOK() }), (e) => e.code === "OwnedElsewhere");
  await store.release();
  await assert.rejects(openOperatorEffects(receipt.store, { ...W, domain: { account: OTHER, chainId: CHAIN } }), /not this operator domain/);
  // rerun: already established, nothing changed
  const snap = [receipt.store, s.input.configOut, I.receiptPath(s.input.configOut)].map((f) => fs.readFileSync(f));
  await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), (e) => e.code === "AlreadyEstablished" && e.existing.state === "already-established");
  await assert.rejects(I.planOperatorEffectsInstall(s.input, { TEST: s.TEST }), (e) => e.code === "AlreadyEstablished");
  assert.deepEqual([receipt.store, s.input.configOut, I.receiptPath(s.input.configOut)].map((f) => fs.readFileSync(f)), snap);
});

test("C5 partial install: a failed journal probe stops apply, PRESERVES the created state, and every rerun refuses as incomplete", async (t) => {
  const s = installFixture(t);
  s.TEST.run = testRun({ stateDir: s.input.stateDir, journal: "fail" }).run;
  await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), (e) => e.code === "IncompleteInstall"
    && e.failedStep === "observe-and-pin-journal-acl" && e.completed.join() === "create-state-directory,verify-state-directory,create-journal" && !/TEST raw PowerShell/.test(e.message));
  const journal = path.join(s.input.stateDir, C.STORE_NAME), kept = fs.readFileSync(journal);
  assert.equal(fs.existsSync(s.input.configOut), false, "no config for an unverified store");
  s.TEST.run = testRun({ stateDir: s.input.stateDir }).run;
  await assert.rejects(I.applyOperatorEffectsInstall(s.input, { confirm: I.APPLY_CONFIRM, TEST: s.TEST }), (e) => e.code === "IncompleteInstall" && e.existing.state === "incomplete-or-foreign");
  await assert.rejects(I.planOperatorEffectsInstall(s.input, { TEST: s.TEST }), (e) => e.code === "IncompleteInstall");
  assert.deepEqual(fs.readFileSync(journal), kept, "nothing deleted, reset or replaced");
});

test("C6 CLI parsing: plan by default; unknown, repeated or valueless arguments refuse", () => {
  assert.equal(I.parseArgs(["--state-dir", "C:\\x\\y"]).mode, "plan");
  assert.equal(I.parseArgs(["--apply", "--confirm", I.APPLY_CONFIRM]).mode, "apply");
  for (const argv of [["--private-key", "0x1"], ["--state-dir", "a", "--state-dir", "b"], ["--account"]]) assert.throws(() => I.parseArgs(argv), (e) => e.code === "BadInput");
});
