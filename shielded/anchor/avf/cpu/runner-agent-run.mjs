#!/usr/bin/env node
// runner-agent-run.mjs <out_dir> <apk> <code_hash> -- the DEVICE check of the runner LIFECYCLE agent (runner/runner-agent.mjs;
// RUNNER-AGENT.md; LAB, not production). The Pixel 10's real VM attests and signs; the AGENT does every owner step -- it
// registers the ATTESTED key, claims, proves, heartbeats, renews (and, interrupted, renews exactly once after a restart), and
// finally posts a last proof and releases -- against the REAL EnclaveRegistry / EnclaveDeployments / EnclaveProofOfTime /
// EnclaveAddressBook on a LOCAL anvil chain mining a block every 2 s (no network, no funds, nothing public). The lease clock
// is moved with evm_increaseTime (the ledger's 1800 s quantum and 900 s heartbeat would otherwise take an hour); the VM's own
// 60 s signing gap is honoured in real time. The operator is a FRESH random key held in memory only; the lab registration
// values are synthetic (repo "lab/pvm-runner-device", the build's code hash as measurement, a lab price).
// Steps (each checked against its expectation; the run stops at the first that differs): start, register, claim, prove-1,
// heartbeat, renew, approach-N (proofs moving the lease toward its margin), renew-interrupted (the renew is journaled and never
// delivered; the agent stops), renew-recovered (a new agent delivers the SAME bytes once), after-renew (no second renew),
// release (final proof, then release). Records as cpu/proof-agent-run.mjs, plus chain-events.jsonl (every lifecycle and
// proof event on the local chain, read before it stops) and balances in steps.jsonl.
// runtime/conformance/check-runner-agent.mjs re-checks it offline.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const [OUT, APK, CODE] = process.argv.slice(2);
if (!OUT || !APK || !/^[0-9a-f]{64}$/.test(CODE || "")) { console.error("usage: runner-agent-run.mjs <out_dir> <apk> <code_hash>"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to mix runs`); process.exit(2); }
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), REPO = path.resolve(H, "../../..");
const ADB = process.env.ADB || path.join(process.env.HOME, "Android/Sdk/platform-tools/adb"), P = "host.enclave.anchor.avf", F = `/data/user/0/${P}/files`;
const NAME = "pixel10-pvm-cpu", PORT = 18443, APPPORT = 18445, EVPORT = 18446, WEBPORT = 18447, SEALPORT = 18448, CHAINPORT = 18845, SERVE_S = 2400, BLOCK_S = 2;
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate
const RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba", ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const BUNDLE = path.join(H, "runtime/conformance/bundles/stream-probe.wasm");
const POLICY = { confirmations: 2, receiptTimeoutMs: 10000, confirmTimeoutMs: 30000, pollMs: 1000, maxReplacements: 3, maxAnchorAgeBlocks: 20 };
const LAB_REGISTER = { repo: "lab/pvm-runner-device", measurement: "0x" + CODE, cpuPricePerSec6: "834" };   // synthetic LAB values, not a production price
fs.mkdirSync(path.join(OUT, "vm"), { recursive: true });
const RUN_ID = "ra" + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
const log = (m) => { const l = `${new Date().toISOString().slice(11, 19)}Z ${m}`; console.log(l); fs.appendFileSync(path.join(OUT, "run.log"), l + "\n"); };
const rec = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + "\n");
const sh = (cmd) => { try { return execFileSync(ADB, ["shell", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, ""); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false;
const fail = (m) => { log(`STOP: ${m}`); stopped = true; throw new Error(m); };

const { startLeaseChain } = await import(path.join(REPO, "test/fixtures/lease-chain.mjs"));
const { AGENT_CONFIG_FORMAT } = await import(path.join(H, "runner/proof-agent.mjs"));
const { createRunnerAgent, RUNNER_CONFIG_FORMAT } = await import(path.join(H, "runner/runner-agent.mjs"));
const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const APPID = createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
let OPKEY = generatePrivateKey();
const operator = privateKeyToAccount(OPKEY);
let chain = null, hub = null, proxy = null, runner = null, curStep = "start";
const cleanup = () => { try { runner && runner.close(); } catch {} try { proxy && proxy.close(); } catch {} try { chain && chain.stop(); } catch {} try { hub && hub.kill(); } catch {}
                        try { execFileSync(ADB, ["reverse", "--remove", `tcp:${PORT}`], { stdio: "ignore" }); } catch {} };
const STATE = path.join(OUT, ".agent-state");
let D = null;
try {
  chain = await startLeaseChain({ port: CHAINPORT, operatorAccount: operator, addressBook: true, blockTime: BLOCK_S });
  const endpoint = `https://api.enclave.host/t/${NAME}`, enclaveId = V.keccak256(V.stringToBytes(endpoint));
  D = await chain.createFunded(); const pins = chain.pins(D, enclaveId);
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ runId: RUN_ID, apk: path.basename(APK), code: CODE, app: APPID, endpoint, pins, accounts: chain.accounts,
    addresses: chain.addresses, chain: `anvil (local: no network, no funds), a block every ${BLOCK_S} s; lease time moved with evm_increaseTime`, googleRootPins: ROOTS, runtimeId: RID,
    authority: AUTH, policy: POLICY, labRegister: LAB_REGISTER, operatorKey: "a fresh random key for this run, held in memory only, never written" }, null, 1));
  log(`local chain ${chain.chainId}: book ${chain.addresses.addressBook}; deployment ${D}; runner ${enclaveId}; operator ${pins.operator} (fresh key); NOTHING registered or claimed`);
  const want = execFileSync("sha256sum", [APK], { encoding: "utf8" }).slice(0, 64), have = sh(`sha256sum $(pm path ${P} | sed s/package://)`).slice(0, 64);
  if (want !== have) { execFileSync(ADB, ["install", "-r", APK], { stdio: "ignore", timeout: 300000 }); log(`installed ${path.basename(APK)} over the previous build, data kept (${want})`); }
  else log(`installed APK is already ${path.basename(APK)} (${want})`);
  execFileSync(ADB, ["push", BUNDLE, "/data/local/tmp/app-stream-probe.wasm"], { stdio: "ignore" }); sh(`run-as ${P} cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm`);
  hub = spawn(process.execPath, ["cpu/local-hub.mjs", "--port", String(PORT), "--code-hash", CODE, "--authority", AUTH,
    "--model-sha", "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", "--selftest-sha", "9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f",
    "--min-tok-s", "10", "--app-id", APPID, "--app-port", String(APPPORT), "--evidence-port", String(EVPORT), "--sealed-port", String(SEALPORT), "--web-port", String(WEBPORT),
    "--app-name", NAME, "--seconds", String(SERVE_S + 900), "--record-evidence", path.join(OUT, "evidence")], { cwd: H, stdio: ["ignore", fs.openSync(path.join(OUT, "hub.jsonl"), "a"), fs.openSync(path.join(OUT, "hub.err"), "a")] });
  await sleep(2000);
  if (hub.exitCode !== null) fail(`the hub exited at startup: ${fs.readFileSync(path.join(OUT, "hub.err"), "utf8").slice(-300)}`);
  execFileSync(ADB, ["reverse", `tcp:${PORT}`, `tcp:${PORT}`], { stdio: "ignore" });
  let pn = 0;
  proxy = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (d) => (body += d));
      req.on("end", async () => {
        const t0 = new Date().toISOString(); let status = 0, answer = "";
        try { const r = await fetch(`http://127.0.0.1:${WEBPORT}/evidence`, { method: "POST", body }); status = r.status; answer = await r.text(); } catch { status = 502; }
        rec("proxy.jsonl", { n: ++pn, step: curStep, utcStart: t0, utcEnd: new Date().toISOString(), request: body.trim(), status, answer });
        res.writeHead(status || 502, { "content-type": "application/json" }); res.end(answer);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/evidence`, close: () => srv.close() }));
  });
  const hooks = { swallow: false };
  const client = new Proxy(chain.publicClient, { get(t, k) {
    if (k === "sendRawTransaction") return async (a) => {
      const h = V.keccak256(a.serializedTransaction);
      if (hooks.swallow) { rec("chain.jsonl", { label: "swallowed-send", step: curStep, hash: h }); return h; }
      return t.sendRawTransaction(a);
    };
    return t[k];
  } });
  const launch = async (phase) => {
    const l = `${RUN_ID}-${phase}`;
    sh(`am force-stop ${P}; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard`); await sleep(2000);
    if (!/mWakefulness=Awake/.test(sh("dumpsys power"))) fail("PHONE NOT AWAKE");
    const pinLine = [pins.chainId, pins.proofOfTime, pins.registry, pins.deployment, pins.enclaveId, pins.operator].join(" ");
    sh(`am start -S -n ${P}/.Main --es mode app --es vmname anchorlocal --es model ${F}/model.gguf --es app ${F}/app-stream-probe.wasm --es app_graph gemma-4-e2b-it-q4_0 --ei app_tls 1 --ei app_serve_s ${SERVE_S} --es relay ws://127.0.0.1:${PORT}/v1/fleet-tunnel --es name ${NAME} --es capture ${l} --es proof_pins '${pinLine}'`);
    const t0 = Date.now();
    while (Date.now() - t0 < 400000) {
      const c = sh(`run-as ${P} cat files/capture/${l}.log`);
      if (/APP evidence endpoint on vsock/.test(c)) { fs.writeFileSync(path.join(OUT, "vm", `${phase}.log`), c); log(`${phase}: the VM serves (${Math.round((Date.now() - t0) / 1000)} s)`); return; }
      if (/^CAPTURE END/m.test(c)) { fs.writeFileSync(path.join(OUT, "vm", `${phase}.log`), c); fail(`${phase}: the VM ended before serving`); }
      await sleep(5000);
    }
    fail(`${phase}: not serving within 400 s`);
  };
  const config = (instanceIds, over = {}) => ({ format: RUNNER_CONFIG_FORMAT, lifecycle: { register: LAB_REGISTER, claim: true },
    proof: { format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint,
      operator: operator.address.toLowerCase(), carrier: proxy.url, maxFeePerGasWei: "100000000000",
      evidence: { appId: APPID, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS, instanceIds }, policy: { ...POLICY, ...over } } });
  const newRunner = (instanceIds, over) => createRunnerAgent({ config: config(instanceIds, over), publicClient: client, account: operator, stateDir: STATE,
    log: (o) => { if (["done", "stuck", "recover", "attest", "renew-withheld", "refused", "broadcast-failed"].includes(o.ev)) log(`  agent ${o.ev}${o.op ? " " + o.op : ""}${o.kind ? " " + o.kind : ""}${o.reason ? ": " + o.reason : ""}`); } });
  const state = async () => { const d = await chain.deployment(D), now = await chain.now(); return { leaseUntil: Number(d.leaseUntil), now, remaining: Number(d.leaseUntil) - now, balance6: String(d.balance6), runner: d.runner }; };
  const step = async (label, outcome, expect) => {
    const s = await state();
    const lk = outcome.lifecycle ? outcome.lifecycle.kind : null, lop = outcome.lifecycle ? outcome.lifecycle.op || null : null, pk = outcome.proof ? outcome.proof.kind : null;
    const ok = expect({ lk, lop, pk, o: outcome });
    rec("steps.jsonl", { step: label, lifecycle: outcome.lifecycle || null, proof: outcome.proof || null, kind: outcome.kind, ok, lease: s, utc: new Date().toISOString() });
    log(`${label}: lifecycle ${lop || "-"} ${lk || ""} | proof ${pk || "-"} | kind ${outcome.kind} | lease ${s.remaining} s left${ok ? "" : "  -- UNEXPECTED"}`);
    if (!ok) fail(`${label}: ${JSON.stringify(outcome).slice(0, 400)}`);
  };
  const vmGap = () => sleep(62000);

  log("== the VM"); await launch("a");
  const c = fs.readFileSync(path.join(OUT, "vm", "a.log"), "utf8");
  const A = { instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1] };
  if (!A.instance || !A.proofKey) fail(`the VM did not log its instance and proof key (${JSON.stringify(A)})`);
  runner = await newRunner([A.instance]);
  curStep = "start"; const st = await runner.start();
  rec("steps.jsonl", { step: "start", attested: st.attested, ok: !!st.attested && st.attested.proofKey === A.proofKey, lease: await state() });
  if (!st.attested || st.attested.proofKey !== A.proofKey) fail("start: the attested key is not the one the VM logged");
  log(`start: attested ${st.attested.proofKey}; nothing registered yet`);
  curStep = "register"; await step("register", await runner.tick(), ({ lk, lop, pk }) => lk === "landed" && /^register/.test(lop) && pk === "not-our-lease");
  if ((await chain.registeredProofKey(enclaveId)) !== A.proofKey) fail("register: the registered key is not the attested one");
  await sleep(4000);
  curStep = "claim"; await step("claim", await runner.tick(), ({ lk, lop }) => lk === "landed" && lop === "claim");
  await vmGap(); await chain.advance(300);
  curStep = "prove-1"; await step("prove-1", await runner.tick(), ({ lk, pk }) => lk === null && pk === "landed");
  await vmGap();
  { const r = await chain.publicClient.readContract({ address: chain.addresses.registry, abi: chain.abis.EnclaveRegistry.abi, functionName: "get", args: [enclaveId] });
    const now = await chain.now(); await chain.advance(Math.max(0, Number(r.lastSeen) + 905 - now)); }
  curStep = "heartbeat"; await step("heartbeat", await runner.tick(), ({ lk, lop, pk }) => lk === "landed" && lop === "heartbeat" && pk === "landed");
  await vmGap();
  { const s = await state(); await chain.advance(Math.max(0, s.remaining - 560)); }
  curStep = "renew"; await step("renew", await runner.tick(), ({ lk, lop, pk }) => lk === "landed" && lop === "renew" && pk === "landed");
  // approach the margin again with proofs landing on the way (a renew needs a RECENT proof)
  for (let i = 0; i < 8; i++) {
    await vmGap();
    const s = await state();
    if (s.remaining <= 720) break;
    await chain.advance(Math.min(550, s.remaining - 660));
    curStep = `approach-${i}`; await step(curStep, await runner.tick(), ({ lk, lop, pk }) => (lk === null || (lk === "landed" && lop === "heartbeat")) && pk === "landed");
  }
  { const s = await state(); await chain.advance(Math.max(0, s.remaining - 560)); }
  // the renew is journaled, then never delivered, and the agent stops
  runner.close(); hooks.swallow = true;
  runner = await newRunner([A.instance], { maxReplacements: 0, receiptTimeoutMs: 5000 });
  await runner.start();
  curStep = "renew-interrupted";
  const balBefore = (await state()).balance6;
  await step("renew-interrupted", await runner.tick(), ({ o, lop }) => o.kind === "in-flight" && lop === "renew");
  runner.close(); hooks.swallow = false;
  log("renew-interrupted: the agent stopped with the renew journaled and never delivered");
  runner = await newRunner([A.instance]);
  curStep = "renew-recovered"; const re = await runner.start();
  const balAfter = (await state()).balance6;
  rec("steps.jsonl", { step: "renew-recovered", recovered: re.recovered, balBefore, balAfter, ok: !!re.recovered && re.recovered.op === "renew" && re.recovered.kind === "landed", lease: await state() });
  log(`renew-recovered: ${re.recovered && re.recovered.op} ${re.recovered && re.recovered.kind}; tenant balance ${balBefore} -> ${balAfter}`);
  if (!re.recovered || re.recovered.op !== "renew" || re.recovered.kind !== "landed") fail(`renew-recovered: ${JSON.stringify(re.recovered)}`);
  await vmGap();
  curStep = "after-renew"; await step("after-renew", await runner.tick(), ({ lop, pk }) => lop !== "renew" && pk === "landed");
  await chain.advance(120);
  curStep = "release"; const rl = await runner.stop({ release: true });
  rec("steps.jsonl", { step: "release", outcome: rl, ok: rl.kind === "released" && rl.proof && rl.proof.kind === "landed", lease: await state() });
  log(`release: ${rl.kind} (final proof ${rl.proof && rl.proof.kind})`);
  if (rl.kind !== "released" || !rl.proof || rl.proof.kind !== "landed") fail(`release: ${JSON.stringify(rl).slice(0, 300)}`);
  sh(`am force-stop ${P}`); log("the lab app was stopped by the script (the VM ends with it)");
} catch (e) { if (!stopped) log(`STOP: ${e.message}`); process.exitCode = 1; }
finally {
  try { if (runner) { runner.close(); runner = null; } } catch {}
  try {
    if (fs.existsSync(path.join(STATE, "journal.jsonl"))) fs.copyFileSync(path.join(STATE, "journal.jsonl"), path.join(OUT, "journal.jsonl"));
    const j = fs.existsSync(path.join(OUT, "journal.jsonl")) ? fs.readFileSync(path.join(OUT, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const t of j.filter((e) => e.ev === "tx")) {
      const r = chain ? await chain.publicClient.getTransactionReceipt({ hash: t.hash }).catch(() => null) : null;
      const blk = r ? await chain.publicClient.getBlock({ blockNumber: r.blockNumber }).catch(() => null) : null;
      rec("receipts.jsonl", { hash: t.hash, receipt: r ? { status: r.status, block: Number(r.blockNumber), blockHash: r.blockHash, canonical: !!blk && blk.hash === r.blockHash, from: r.from.toLowerCase(), to: r.to && r.to.toLowerCase() } : null });
    }
    if (chain) {
      const J = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "bigint" ? String(v) : v)));
      for (const [contract, names] of [["registry", ["Registered", "Updated", "ProofKeySet", "Heartbeat", "Deregistered"]], ["ledger", ["Claimed", "Renewed", "Released"]], ["prover", ["Checkpointed"]]])
        for (const n of names) for (const l of await chain.events(contract, n)) rec("chain-events.jsonl", J({ contract, event: n, block: l.blockNumber, tx: l.transactionHash, args: l.args }));
      if (D) { const d = await chain.deployment(D); rec("chain.jsonl", { label: "final", runner: d.runner, leaseUntil: String(d.leaseUntil), balance6: String(d.balance6), provenUntil: await chain.provenUntil(D) }); }
    }
  } catch (e) { log(`records: ${e.message}`); process.exitCode = 1; }
  cleanup();
  fs.rmSync(STATE, { recursive: true, force: true });
  const hex = OPKEY.slice(2); const found = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (fs.readFileSync(p).includes(hex)) found.push(p); } };
  walk(OUT); OPKEY = null;
  log(found.length ? `KEY FOUND in ${found.join(", ")}` : "the operator key appears nowhere in the results");
  if (found.length) process.exitCode = 1;
}
