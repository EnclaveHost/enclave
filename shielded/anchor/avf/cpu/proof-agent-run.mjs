#!/usr/bin/env node
// proof-agent-run.mjs <out_dir> <apk> <code_hash> -- the DEVICE check of the owner-side posting agent
// (runner/proof-agent.mjs; PROOF-KEY.md "Activation, exactly" step 5; LAB, not production): the Pixel 10's real VM signs, the
// AGENT does everything else -- it reads the lease, picks the anchor, asks the VM through the real hub and web carrier, verifies
// the answer itself, simulates, signs each transaction locally, journals it, sends it and follows it to a confirmed receipt --
// against the REAL EnclaveRegistry / EnclaveDeployments / EnclaveProofOfTime / EnclaveAddressBook on a LOCAL anvil chain that
// mines a block every 2 s like Base (test/fixtures/lease-chain.mjs: no network, no funds, nothing public). The operator is a
// FRESH random key made for this run, held in memory only and never written; the results are scanned for it before the run ends.
//
// The steps (PLAN below), each with the outcome it must have; the run stops at the first that differs (exit 1), never retried:
//   start-a         the agent resolves the contracts through the address book, cross-checks their bindings, attests the VM
//   unclaimed       before the owner registers and claims: not-our-lease, and the VM is NOT asked for a proof
//   (the owner's steps: the operator registers exactly the attested key and claims the lease)
//   a1              a proof lands
//   replay          the carrier (a recording proxy in front of the hub's web carrier) hands back the previous, genuinely
//                   signed answer: refused before any chain sees it
//   replace         block production paused: the send does not mine; the agent replaces it at the same nonce with bumped
//                   fees; production resumes; exactly one lands
//   reorg           the block holding the proof is reorganized away during the confirmation wait; the agent notices,
//                   rebroadcasts the same bytes, and it lands in another block
//   crash, recover  an agent whose sends never reach the chain is stopped with a transaction in flight; the next agent, from
//                   the same journal, rebroadcasts the SAME bytes and they land -- without asking the VM for anything new
//   stuck, fresh    a send that never reaches the chain outlives its anchor (> maxAnchorAgeBlocks): the next tick asks the VM
//                   for a FRESH proof and puts it in the SAME nonce, outbidding the stuck one
//   (VM restart: the same pins, a new boot)
//   start-b, b1     the agent re-attests: the same proof key, vouched for by a new transport key; a proof lands
// Records: run.json, run.log, steps.jsonl, proxy.jsonl (every agent<->carrier exchange as the agent saw it), evidence/ (the
// hub's own record of every exchange with the VM), journal.jsonl (the agent's), chain.jsonl (the owner's transactions),
// receipts.jsonl (every journaled transaction's receipt, read before the chain stops), vm/*.log.
// runtime/conformance/check-proof-agent.mjs re-checks all of it offline.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const [OUT, APK, CODE] = process.argv.slice(2);
if (!OUT || !APK || !/^[0-9a-f]{64}$/.test(CODE || "")) { console.error("usage: proof-agent-run.mjs <out_dir> <apk> <code_hash>"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to mix runs`); process.exit(2); }
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), REPO = path.resolve(H, "../../..");
const ADB = process.env.ADB || path.join(process.env.HOME, "Android/Sdk/platform-tools/adb"), P = "host.enclave.anchor.avf", F = `/data/user/0/${P}/files`;
const NAME = "pixel10-pvm-cpu", PORT = 18443, APPPORT = 18445, EVPORT = 18446, WEBPORT = 18447, SEALPORT = 18448, CHAINPORT = 18845, SERVE_S = 1800, BLOCK_S = 2;
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate
const RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba", ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const BUNDLE = path.join(H, "runtime/conformance/bundles/stream-probe.wasm");
const POLICY = { confirmations: 2, receiptTimeoutMs: 10000, confirmTimeoutMs: 30000, pollMs: 1000, maxReplacements: 3, maxAnchorAgeBlocks: 20 };
const PLAN = [
  ["start-a", ["attested"]], ["unclaimed", ["not-our-lease"]], ["a1", ["landed"]], ["replay", ["checkpoint-refused"]], ["replace", ["landed"]],
  ["reorg", ["landed"]], ["crash", ["stuck"]], ["recover", ["landed"]], ["stuck", ["stuck"]], ["fresh", ["landed"]], ["start-b", ["attested"]], ["b1", ["landed"]],
];
fs.mkdirSync(path.join(OUT, "vm"), { recursive: true });
const RUN_ID = "pa" + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
const log = (m) => { const l = `${new Date().toISOString().slice(11, 19)}Z ${m}`; console.log(l); fs.appendFileSync(path.join(OUT, "run.log"), l + "\n"); };
const rec = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + "\n");
const sh = (cmd) => { try { return execFileSync(ADB, ["shell", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, ""); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false;
const fail = (m) => { log(`STOP: ${m}`); stopped = true; throw new Error(m); };

const { startLeaseChain } = await import(path.join(REPO, "test/fixtures/lease-chain.mjs"));
const { createProofAgent, AGENT_CONFIG_FORMAT } = await import(path.join(H, "runner/proof-agent.mjs"));
const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const APPID = createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
let OPKEY = generatePrivateKey();   // this run's operator: a fresh key, in memory only
const operator = privateKeyToAccount(OPKEY);
let chain = null, hub = null, proxy = null, agent = null, stepN = 0;
const cleanup = () => { try { agent && agent.close(); } catch {} try { proxy && proxy.close(); } catch {} try { chain && chain.stop(); } catch {} try { hub && hub.kill(); } catch {}
                        try { execFileSync(ADB, ["reverse", "--remove", `tcp:${PORT}`], { stdio: "ignore" }); } catch {} };
const STATE = path.join(OUT, ".agent-state");
try {
  // ---- the local chain (a block every 2 s) and the lease the VM will prove ----
  chain = await startLeaseChain({ port: CHAINPORT, operatorAccount: operator, addressBook: true, blockTime: BLOCK_S });
  const endpoint = `https://api.enclave.host/t/${NAME}`, enclaveId = V.keccak256(V.stringToBytes(endpoint));
  const D = await chain.createFunded(), pins = chain.pins(D, enclaveId);
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ runId: RUN_ID, apk: path.basename(APK), code: CODE, app: APPID, endpoint, pins, accounts: chain.accounts,
    addresses: chain.addresses, chain: `anvil (local: no network, no funds), a block every ${BLOCK_S} s`, googleRootPins: ROOTS, runtimeId: RID, authority: AUTH, policy: POLICY,
    plan: PLAN, operatorKey: "a fresh random key for this run, held in memory only, never written" }, null, 1));
  log(`local chain ${chain.chainId}: book ${chain.addresses.addressBook}, prover ${chain.addresses.proofOfTime}; deployment ${D}; runner ${enclaveId}; operator ${pins.operator} (fresh key)`);
  // ---- the phone, the hub (recording every evidence-port exchange), the carrier, and a recording proxy for the agent ----
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
  const hooks = { replay: false, lastCheckpointAnswer: null, swallow: false, reorgArm: false, snap: null, reorgHash: null, agentSawReceipt: false, reorged: false, pausedForReplace: false };
  let pn = 0;
  proxy = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (d) => (body += d));
      req.on("end", async () => {
        const t0 = new Date().toISOString(), line = body.trim();
        let status = 0, answer = "";
        try { const r = await fetch(`http://127.0.0.1:${WEBPORT}/evidence`, { method: "POST", body }); status = r.status; answer = await r.text(); } catch (e) { answer = ""; status = 502; }
        let handed = answer, mode = "honest";
        if (line.startsWith("CHECKPOINT") && status === 200 && !/"error"/.test(answer)) {
          if (hooks.replay && hooks.lastCheckpointAnswer) { handed = hooks.lastCheckpointAnswer; mode = "replayed-previous-answer"; }
          else hooks.lastCheckpointAnswer = answer;
        }
        rec("proxy.jsonl", { n: ++pn, step: PLAN[stepN] ? PLAN[stepN][0] : null, utcStart: t0, utcEnd: new Date().toISOString(), request: line, status, answer, ...(mode !== "honest" ? { mode, handed } : {}) });
        res.writeHead(status || 502, { "content-type": "application/json" }); res.end(handed);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/evidence`, close: () => srv.close() }));
  });
  // the agent's view of the chain: the real client, with the run's hooks (a node that swallows sends; a reorganization)
  const client = new Proxy(chain.publicClient, { get(t, k) {
    if (k === "sendRawTransaction") return async (args) => {
      const h = V.keccak256(args.serializedTransaction);
      if (hooks.swallow) { rec("chain.jsonl", { label: "swallowed-send", step: PLAN[stepN][0], hash: h }); return h; }
      if (hooks.reorgArm && !hooks.snap) { hooks.snap = await chain.snapshot(); hooks.reorgHash = h; }
      return t.sendRawTransaction(args);
    };
    // the reorganization must happen AFTER the agent has seen the receipt (run 1 reverted before its first poll, so the agent
    // saw a transaction that never mined -- and correctly replaced it -- which is not the confirmation-wait path this step is for)
    if (k === "getTransactionReceipt") return async (args) => {
      const r = await t.getTransactionReceipt(args);
      if (r && hooks.snap && args.hash === hooks.reorgHash) hooks.agentSawReceipt = true;
      return r;
    };
    return t[k];
  } });
  const onSleep = async () => {
    if (hooks.pausedForReplace && agent && agent.pending && agent.pending.txs.length >= 2) { hooks.pausedForReplace = false; await chain.setIntervalMining(BLOCK_S); log("replace: a replacement was sent; block production resumed"); }
    if (hooks.snap && hooks.agentSawReceipt && !hooks.reorged) {
      const r = await chain.publicClient.getTransactionReceipt({ hash: hooks.reorgHash }).catch(() => null);
      if (r) {
        hooks.reorged = true;
        await chain.setIntervalMining(0); await chain.revert(hooks.snap); await chain.dropAll(); await chain.mine(2); await chain.setIntervalMining(BLOCK_S);
        rec("chain.jsonl", { label: "reorganized", step: "reorg", hash: hooks.reorgHash, removedBlock: Number(r.blockNumber), removedBlockHash: r.blockHash });
        log(`reorg: block ${r.blockNumber} (${r.blockHash.slice(0, 18)}…) holding the proof was reorganized away`);
      }
    }
  };
  const config = (instanceIds, over = {}) => ({ format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint,
    operator: operator.address.toLowerCase(), carrier: proxy.url, maxFeePerGasWei: "100000000000",
    evidence: { appId: APPID, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS, instanceIds },
    policy: { ...POLICY, ...over } });
  const newAgent = (instanceIds, over) => createProofAgent({ config: config(instanceIds, over), publicClient: client, account: operator, stateDir: STATE,
    log: (o) => { if (["done", "reorg", "stuck", "recover", "attest", "broadcast-failed"].includes(o.ev)) log(`  agent ${o.ev}${o.kind ? " " + o.kind : ""}${o.reason ? ": " + o.reason : ""}`); },
    sleep: async (ms) => { await sleep(ms); await onSleep(); } });
  const step = (label, outcome) => {
    const [want, kinds] = PLAN[stepN];
    if (want !== label) fail(`internal: step ${label} out of plan order (expected ${want})`);
    const ok = kinds.includes(outcome.kind);
    rec("steps.jsonl", { n: stepN + 1, step: label, expect: kinds, outcome, ok, utc: new Date().toISOString() });
    log(`${label}: ${outcome.kind}${ok ? "" : ` -- EXPECTED ${kinds.join("|")}`}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    stepN++;
    if (!ok) fail(`${label}: ${JSON.stringify(outcome).slice(0, 300)}`);
    return outcome;
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
  const vmGap = () => sleep(62000);   // the VM signs at most one checkpoint per 60 s

  // ================= A. the first boot =================
  log("== A: first boot"); await launch("a");
  const A = vmfacts("a");
  if (!A.pinsAccepted || !A.proofKey || !A.instance) fail(`the VM did not take its pins or log its proof key (${JSON.stringify(A)})`);
  log(`A: the VM logged INSTANCE ${A.instance} and PROOF key ${A.proofKey}`);
  agent = await newAgent([A.instance]);
  const sa = await agent.start();
  step("start-a", sa.attested ? { kind: "attested", proofKey: sa.attested.proofKey, instanceId: sa.attested.instanceId, addresses: sa.addresses } : { kind: "attest-failed", reason: sa.attestReason });
  if (sa.attested.proofKey !== A.proofKey) fail("the attested proof key is not the one the VM logged");
  step("unclaimed", await agent.tick());
  // the OWNER's steps (not the agent's): register exactly the attested key, claim the lease
  await chain.register({ endpoint, proofKey: sa.attested.proofKey });
  rec("chain.jsonl", { label: "register", endpoint, enclaveId, proofKey: await chain.registeredProofKey(enclaveId), operator: pins.operator });
  await chain.claim(D, enclaveId); rec("chain.jsonl", { label: "claim", deployment: D, enclaveId, provenUntil: await chain.provenUntil(D) });
  log(`owner: registered ${sa.attested.proofKey} and claimed ${D.slice(0, 18)}…`);
  await sleep(4000);
  step("a1", await agent.tick());
  await vmGap(); hooks.replay = true;
  step("replay", await agent.tick()); hooks.replay = false;
  await vmGap(); hooks.pausedForReplace = true; await chain.setIntervalMining(0); log("replace: block production paused");
  const rp = step("replace", await agent.tick());
  if (hooks.pausedForReplace) { await chain.setIntervalMining(BLOCK_S); fail("replace: landed without a replacement"); }
  await vmGap(); hooks.reorgArm = true;
  step("reorg", await agent.tick()); hooks.reorgArm = false;
  if (!hooks.reorged) fail("reorg: the reorganization did not happen");
  agent.close(); agent = null;
  // crash: an agent whose sends never reach the chain, stopped with a transaction in flight
  await vmGap(); hooks.swallow = true;
  agent = await newAgent([A.instance], { maxReplacements: 0, receiptTimeoutMs: 5000 });
  await agent.start();
  const cr = step("crash", await agent.tick());
  agent.close(); agent = null; hooks.swallow = false;
  log(`crash: the agent stopped with nonce ${cr.nonce} in flight`);
  agent = await newAgent([A.instance]);
  const re = await agent.start();
  step("recover", re.recovered || { kind: "nothing-recovered" });
  // stuck past the anchor's age -> a FRESH proof in the same nonce
  await vmGap(); hooks.swallow = true;
  const sk = step("stuck", await agent.tick());
  hooks.swallow = false; await vmGap();
  const fr = step("fresh", await agent.tick());
  if (fr.nonce !== sk.nonce) fail(`fresh: landed at nonce ${fr.nonce}, not the stuck ${sk.nonce}`);
  // ================= B. restart: the same pins, a new boot =================
  log("== B: restart (the same pins, a new boot)"); await launch("b");
  const B = vmfacts("b");
  log(`B: the VM logged INSTANCE ${B.instance} and PROOF key ${B.proofKey} (${B.proofKey === A.proofKey ? "SAME" : "DIFFERENT"})`);
  const ab = await agent.attest();
  step("start-b", ab.ok ? { kind: "attested", proofKey: ab.claims.proofKey, instanceId: ab.claims.instanceId } : { kind: "attest-failed", reason: ab.reason });
  await sleep(4000);
  step("b1", await agent.tick());
  sh(`am force-stop ${P}`); log("the lab app was stopped by the script (the VM ends with it)");
  log(`done: provenUntil ${await chain.provenUntil(D)}`);
} catch (e) { if (!stopped) log(`STOP: ${e.message}`); process.exitCode = 1; }
finally {
  try { if (agent) { agent.close(); agent = null; } } catch {}
  try {   // the records the checker needs, read before the chain stops
    if (fs.existsSync(path.join(STATE, "journal.jsonl"))) fs.copyFileSync(path.join(STATE, "journal.jsonl"), path.join(OUT, "journal.jsonl"));
    const j = fs.existsSync(path.join(OUT, "journal.jsonl")) ? fs.readFileSync(path.join(OUT, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const pot = chain && chain.addresses.proofOfTime;
    for (const t of j.filter((e) => e.ev === "tx")) {
      const r = chain ? await chain.publicClient.getTransactionReceipt({ hash: t.hash }).catch(() => null) : null;
      const cps = r ? V.parseEventLogs({ abi: chain.abis.EnclaveProofOfTime.abi, logs: r.logs, eventName: "Checkpointed", strict: false })
        .filter((l) => l.address.toLowerCase() === pot.toLowerCase()).map((l) => ({ id: l.args.id, enclaveId: l.args.enclaveId, operator: l.args.operator.toLowerCase(),
          provenUntil: String(l.args.provenUntil), secondsProven: String(l.args.secondsProven), anchorBlock: String(l.args.anchorBlock) })) : [];
      const blk = r ? await chain.publicClient.getBlock({ blockNumber: r.blockNumber }).catch(() => null) : null;
      rec("receipts.jsonl", { hash: t.hash, receipt: r ? { status: r.status, block: Number(r.blockNumber), blockHash: r.blockHash, canonical: !!blk && blk.hash === r.blockHash, from: r.from.toLowerCase(),
        to: r.to && r.to.toLowerCase(), gasUsed: String(r.gasUsed) } : null, checkpointed: cps });
    }
    if (chain) rec("chain.jsonl", { label: "final", provenUntil: await chain.provenUntil(JSON.parse(fs.readFileSync(path.join(OUT, "run.json"), "utf8")).pins.deployment) });
  } catch (e) { log(`records: ${e.message}`); process.exitCode = 1; }
  cleanup();
  fs.rmSync(STATE, { recursive: true, force: true });
  // the operator key must appear nowhere in the results
  const hex = OPKEY.slice(2); let found = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (fs.readFileSync(p).includes(hex)) found.push(p); } };
  walk(OUT); OPKEY = null;
  log(found.length ? `KEY FOUND in ${found.join(", ")}` : "the operator key appears nowhere in the results");
  if (found.length) process.exitCode = 1;
}
