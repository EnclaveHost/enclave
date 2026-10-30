#!/usr/bin/env node
// proof-key-run.mjs <out_dir> <apk> <code_hash> -- the DEVICE check for the lease proof key (PROOF-KEY.md; LAB, not
// production): the Pixel 10's real VM signs EnclaveProofOfTime checkpoints for a lease on a LOCAL chain -- the real
// EnclaveRegistry / EnclaveDeployments / EnclaveProofOfTime on anvil (test/fixtures/lease-chain.mjs: no network, no funds,
// nothing public). The owner's order:
//   1. the tenant creates and funds a deployment; the VM is launched with pins for THAT lease (chain, contracts, deployment,
//      the runner id of https://api.enclave.host/t/<name>, the operator);
//   2. PROOFKEY: the VM's attested statement, verified by the canonical verifyPvmProofKey under Google's roots, the build's
//      pins, the deployment and the VM's logged instance -- its proof key must be the one the VM logged;
//   3. the OPERATOR (a separate account: the gas wallet) registers exactly that key and claims the lease;
//   4. CHECKPOINTs the device signs over the local chain's anchors are checked offline (verifyPvmCheckpoint) and posted by a
//      third account: provenUntil must advance; the VM's own refusals (its 60 s rate, a non-increasing upto, a malformed
//      request) and the chain's (a replay) are recorded;
//   5. RESTART: the same pins, a new boot -- the same proof key logged and attested, and the lease still proven.
// Every call is appended to calls.jsonl BEFORE its outcome is judged, and the relay carrier records every exchange
// (evidence/), so runtime/conformance/check-proof-key.mjs derives coverage from the run's own records. A failure stops the
// run where it is (exit 1), never retried. The APK and the app stay on the phone; its data is never cleared.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const [OUT, APK, CODE] = process.argv.slice(2);
if (!OUT || !APK || !/^[0-9a-f]{64}$/.test(CODE || "")) { console.error("usage: proof-key-run.mjs <out_dir> <apk> <code_hash>"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to mix runs`); process.exit(2); }
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), REPO = path.resolve(H, "../../..");
const ADB = process.env.ADB || path.join(process.env.HOME, "Android/Sdk/platform-tools/adb"), P = "host.enclave.anchor.avf", F = `/data/user/0/${P}/files`;
const NAME = "pixel10-pvm-cpu", PORT = 18443, APPPORT = 18445, EVPORT = 18446, WEBPORT = 18447, SEALPORT = 18448, CHAINPORT = 18845, SERVE_S = 1500;
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate
const RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba", ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const BUNDLE = path.join(H, "runtime/conformance/bundles/stream-probe.wasm");
fs.mkdirSync(path.join(OUT, "vm"), { recursive: true });
const RUN_ID = "pk" + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
const log = (m) => { const l = `${new Date().toISOString().slice(11, 19)}Z ${m}`; console.log(l); fs.appendFileSync(path.join(OUT, "run.log"), l + "\n"); };
const rec = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + "\n");
const sh = (cmd) => { try { return execFileSync(ADB, ["shell", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, ""); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false;
const fail = (m) => { log(`STOP: ${m}`); stopped = true; throw new Error(m); };

const { startLeaseChain } = await import(path.join(REPO, "test/fixtures/lease-chain.mjs"));
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const V = await import("viem");
const APPID = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
let chain = null, hub = null;
const cleanup = () => { try { chain && chain.stop(); } catch {} try { hub && hub.kill(); } catch {} try { execFileSync(ADB, ["reverse", "--remove", `tcp:${PORT}`], { stdio: "ignore" }); } catch {} };
try {
  // ---- the local chain and the lease the VM will prove ----
  chain = await startLeaseChain({ port: CHAINPORT });
  const endpoint = `https://api.enclave.host/t/${NAME}`, enclaveId = V.keccak256(V.stringToBytes(endpoint));
  const D = await chain.createFunded(), pins = chain.pins(D, enclaveId);
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ runId: RUN_ID, apk: path.basename(APK), code: CODE, app: APPID, endpoint, pins, accounts: chain.accounts,
    addresses: chain.addresses, chain: "anvil (local: no network, no funds)", googleRootPins: ROOTS, runtimeId: RID, authority: AUTH }, null, 1));
  log(`local chain ${chain.chainId}: ledger ${chain.addresses.ledger}, prover ${chain.addresses.proofOfTime}, registry ${chain.addresses.registry}; deployment ${D}; runner ${enclaveId} (${endpoint}); operator ${pins.operator}`);
  // ---- the phone, the hub (recording every evidence-port exchange), the carrier ----
  const want = execFileSync("sha256sum", [APK], { encoding: "utf8" }).slice(0, 64), have = sh(`sha256sum $(pm path ${P} | sed s/package://)`).slice(0, 64);
  if (want !== have) { execFileSync(ADB, ["install", "-r", APK], { stdio: "ignore", timeout: 300000 }); log(`installed ${path.basename(APK)} over the previous build, data kept (${want})`); }
  else log(`installed APK is already ${path.basename(APK)} (${want})`);
  execFileSync(ADB, ["push", BUNDLE, "/data/local/tmp/app-stream-probe.wasm"], { stdio: "ignore" }); sh(`run-as ${P} cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm`);
  hub = spawn(process.execPath, ["cpu/local-hub.mjs", "--port", String(PORT), "--code-hash", CODE, "--authority", AUTH,
    "--model-sha", "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", "--selftest-sha", "9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f",
    "--min-tok-s", "10", "--app-id", APPID, "--app-port", String(APPPORT), "--evidence-port", String(EVPORT), "--sealed-port", String(SEALPORT), "--web-port", String(WEBPORT),
    "--app-name", NAME, "--seconds", String(2 * SERVE_S + 900), "--record-evidence", path.join(OUT, "evidence")], { cwd: H, stdio: ["ignore", fs.openSync(path.join(OUT, "hub.jsonl"), "a"), fs.openSync(path.join(OUT, "hub.err"), "a")] });
  await sleep(2000);
  if (hub.exitCode !== null) fail(`the hub exited at startup: ${fs.readFileSync(path.join(OUT, "hub.err"), "utf8").slice(-300)}`);
  execFileSync(ADB, ["reverse", `tcp:${PORT}`, `tcp:${PORT}`], { stdio: "ignore" });
  const CARRIER = `http://127.0.0.1:${WEBPORT}`;
  let calls = 0;
  const ask = async (label, phase, line) => {   // one evidence-port request through the relay carrier; recorded before it is judged
    await sleep(3000);   // the VM answers at most one evidence-port request every 2 s
    const t0 = new Date().toISOString(); let body = "", status = 0;
    try { const r = await fetch(`${CARRIER}/evidence`, { method: "POST", body: line + "\n" }); status = r.status; body = await r.text(); } catch (e) { body = `carrier error: ${e.message}`; }
    const doc = (() => { try { return JSON.parse(body.split("\n")[0]); } catch { return null; } })();
    rec("calls.jsonl", { n: ++calls, label, phase, request: line, utcStart: t0, utcEnd: new Date().toISOString(), status, answer: doc });
    return doc;
  };
  const launch = async (phase) => {
    const l = `${RUN_ID}-${phase}`;
    sh(`am force-stop ${P}; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard`); await sleep(2000);
    if (!/mWakefulness=Awake/.test(sh("dumpsys power"))) fail("PHONE NOT AWAKE");
    const pinLine = [pins.chainId, pins.proofOfTime, pins.registry, pins.deployment, pins.enclaveId, pins.operator].join(" ");
    sh(`am start -S -n ${P}/.Main --es mode app --es vmname anchorlocal --es model ${F}/model.gguf --es app ${F}/app-stream-probe.wasm --es app_graph gemma-4-e2b-it-q4_0 --ei app_tls 1 --ei app_serve_s ${SERVE_S} --es relay ws://127.0.0.1:${PORT}/v1/fleet-tunnel --es name ${NAME} --es capture ${l} --es proof_pins '${pinLine}'`);
    const t0 = Date.now();
    while (Date.now() - t0 < 400000) {
      const c = sh(`run-as ${P} cat files/capture/${l}.log`);
      if (/APP evidence endpoint on vsock/.test(c)) { fs.writeFileSync(path.join(OUT, "vm", `${phase}.log`), c); log(`${phase}: the VM serves (${Math.round((Date.now() - t0) / 1000)} s)`); return l; }
      if (/^CAPTURE END/m.test(c)) { fs.writeFileSync(path.join(OUT, "vm", `${phase}.log`), c); fail(`${phase}: the VM ended before serving`); }
      await sleep(5000);
    }
    fail(`${phase}: not serving within 400 s`);
  };
  const vmfacts = (phase) => { const c = fs.readFileSync(path.join(OUT, "vm", `${phase}.log`), "utf8");
    return { instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1], pinsAccepted: /PROOFPINS accepted/.test(c) }; };
  const expectOf = (nonce, instanceId) => ({ nonce, appId: APPID, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS,
                                              instanceIds: [instanceId], deployment: D });
  const statement = async (label, phase, instanceId) => {
    const nonce = randomBytes(32).toString("hex"), doc = await ask(label, phase, `PROOFKEY ${nonce}`);
    const v = verifyPvmProofKey(doc, expectOf(nonce, instanceId));
    log(`${label}: ${v.ok ? `VERIFIED -- proof key ${v.claims.proofKey}, instance ${v.claims.instanceId.slice(0, 16)}…` : `REFUSED: ${v.reasons.at(-1)}`}`);
    if (!v.ok) fail(`${label}: the statement did not verify`);
    return v;
  };
  const checkpoint = async (label, phase, v, upto) => {
    const a = await chain.anchor(), doc = await ask(label, phase, `CHECKPOINT ${upto} ${a.anchorBlock} ${a.anchorHash.slice(2)}`);
    if (!doc || doc.error) return { refused: doc && doc.error };
    const c = await verifyPvmCheckpoint(doc, { pins: v.claims, proofKey: v.claims.proofKey });
    if (!c.ok) fail(`${label}: the checkpoint did not verify offline: ${c.reasons[0]}`);
    const r = await chain.checkpoint({ ...c.checkpoint });
    rec("chain.jsonl", { label, phase, upto: String(c.checkpoint.upto), anchorBlock: String(c.checkpoint.anchorBlock), digest: c.checkpoint.digest, ok: r.ok, reason: r.reason || null, provenUntil: r.provenUntil });
    log(`${label}: ${r.ok ? `ACCEPTED by the chain -- provenUntil ${r.provenUntil}` : `refused by the chain: ${r.reason}`}`);
    return { c, r };
  };

  // ================= A. the first boot: attest, register, claim, prove =================
  log("== A: first boot"); await launch("a");
  const A = vmfacts("a");
  if (!A.pinsAccepted || !A.proofKey || !A.instance) fail(`the VM did not take its pins or log its proof key (${JSON.stringify(A)})`);
  log(`A: the VM logged INSTANCE ${A.instance} and PROOF key ${A.proofKey}`);
  const va = await statement("statement-a", "a", A.instance);
  if (va.claims.proofKey !== A.proofKey) fail("the attested proof key is not the one the VM logged");
  await chain.register({ endpoint, proofKey: va.claims.proofKey });
  const reg = await chain.registeredProofKey(enclaveId);
  rec("chain.jsonl", { label: "register", phase: "a", endpoint, enclaveId, proofKey: reg, operator: pins.operator });
  await chain.claim(D, enclaveId); rec("chain.jsonl", { label: "claim", phase: "a", deployment: D, enclaveId, provenUntil: await chain.provenUntil(D) });
  log(`A: the operator registered ${reg} (the attested key) and claimed ${D.slice(0, 18)}…`);
  for (let i = 1; i <= 2; i++) {
    await chain.advance(300);
    const r = await checkpoint(`checkpoint-a${i}`, "a", va, await chain.now());
    if (!r.r || !r.r.ok) fail(`checkpoint-a${i}: not accepted (${r.refused || r.r?.reason})`);
    if (i === 1) {   // the VM's own refusals right after a signature
      const rate = await ask("refuse-rate-a", "a", `CHECKPOINT ${(await chain.now()) + 1} ${(await chain.anchor()).anchorBlock} ${"ab".repeat(32)}`);
      log(`refuse-rate-a: ${JSON.stringify(rate)}`);
      const again = await chain.checkpoint({ ...r.c.checkpoint });
      rec("chain.jsonl", { label: "replay-a1", phase: "a", ok: again.ok, reason: again.reason || null, provenUntil: again.provenUntil });
      log(`replay-a1: ${again.ok ? "ACCEPTED (wrong)" : `refused by the chain: ${again.reason}`}`);
      const bad = await ask("refuse-malformed-a", "a", "CHECKPOINT 12 x 34");
      log(`refuse-malformed-a: ${JSON.stringify(bad)}`);
      log("A: waiting out the VM's 60 s checkpoint rate"); await sleep(61000);
    }
  }
  const mono = await ask("refuse-monotonic-a", "a", `CHECKPOINT 5 ${(await chain.anchor()).anchorBlock} ${"cd".repeat(32)}`);
  log(`refuse-monotonic-a: ${JSON.stringify(mono)}`);
  // ================= B. restart: the same key, the lease still proven =================
  log("== B: restart (the same pins, a new boot)"); await launch("b");
  const B = vmfacts("b");
  log(`B: the VM logged INSTANCE ${B.instance} and PROOF key ${B.proofKey} (${B.proofKey === A.proofKey ? "SAME" : "DIFFERENT"})`);
  const vb = await statement("statement-b", "b", B.instance);
  await chain.advance(300);
  const rb = await checkpoint("checkpoint-b1", "b", vb, await chain.now());
  if (!rb.r || !rb.r.ok) fail(`checkpoint-b1: not accepted after the restart (${rb.refused || rb.r?.reason})`);
  sh(`am force-stop ${P}`); log("the lab app was stopped by the script (the VM ends with it)");
  log(`done: proof key A ${A.proofKey} / B ${B.proofKey}; provenUntil ${await chain.provenUntil(D)}`);
} catch (e) { if (!stopped) log(`STOP: ${e.message}`); process.exitCode = 1; }
finally { cleanup(); }
