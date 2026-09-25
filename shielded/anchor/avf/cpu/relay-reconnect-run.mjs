#!/usr/bin/env node
// relay-reconnect-run.mjs <out_dir> <apk> <code_hash> <old_code_hash> -- RECONNECT IN PLACE through the REAL relay (RUNNER-AGENT.md
// "Reconnect in place"; design reviewed with the verifier session). LAB, not production, exactly as cpu/relay-route-run.mjs: an
// ISOLATED relay process (env -i plus an allowlist, recorded; a scratch cwd; PVM_SERVING in THIS process only), a LOCAL anvil
// chain with the real contracts, fresh random operator keys held in memory, the TEST APK authority (lab-only), the built client.
// ONE VM BOOT for the whole run: every re-attach is the running VM's (REATTACH <nonce> -> a new certificate over its own
// transcript), through the phone's one reconnector (host/app/RelayKeeper.java). The phone's co-signer URL points at a PROXY
// here, which answers each request as the phase says: the owner's co-signer, "down" (the connection is dropped), the WRONG
// operator's co-signer, or a STALE owner signature (an earlier nonce's, replayed).
// Phases (each step checked against its expectation; the run stops at the first that differs, never retried):
//   A   the phone attaches (unregistered, first-come); the row (tier pvm-cpu at boot); the runner bootstraps through /t,
//       registers, claims; /x; a proof; the client served as bound; the keeper armed
//   R1  three relay drops (stop, restart): each time the VM re-attaches IN PLACE, co-signed; the route returns; the client is
//       served as bound; a proof lands
//   R2  a FROZEN relay (SIGSTOP: half-open, no FIN): the phone's watchdog notices the silence; SIGCONT; the VM re-attaches in
//       place and the relay holds exactly ONE tunnel for the name
//   R3  one drop, then the co-signer proxy answers: down, the wrong operator, a stale owner signature, the owner -- the hub
//       refuses the first three and accepts the fourth; the harness replays the accepted attest frame (certificate for nonce
//       N, co-signature for N) on a fresh connection N': refused, the live tunnel undisturbed
//   R4  exactly once across a drop: a request cut by a drop sends nothing; a checkpoint journaled but never delivered, the
//       agent stopped, the relay dropped and restored, the VM re-attached in place, the restarted agent delivers the SAME bytes
//       once
//   R5  the relay restarted admitting only ANOTHER build refuses the in-place attach on its build; the right relay accepts it;
//       the in-place row carries NO tier and is not serving (routing only: the tier needs a self-test after the attach)
//   D   the agent's final proof, then release
// Records: run.json, relay-env.jsonl, tool-env.jsonl, run.log, steps.jsonl, exchanges.jsonl, attach.jsonl (every co-signer
// request, the proxy's mode and its answer), replay.jsonl, cosign-journal*.jsonl, client/*.jsonl, vm/a.log (the ONE boot's
// capture), relay-*.log, rows.jsonl, journal.jsonl, chain-events.jsonl, chain.jsonl, receipts.jsonl.
// runtime/conformance/check-relay-reconnect.mjs re-checks it offline.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const [OUT, APK, CODE, OLD_CODE] = process.argv.slice(2);
if (!OUT || !APK || !/^[0-9a-f]{64}$/.test(CODE || "") || !/^[0-9a-f]{64}$/.test(OLD_CODE || "")) { console.error("usage: relay-reconnect-run.mjs <out_dir> <apk> <code_hash> <old_code_hash>"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to mix runs`); process.exit(2); }
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), REPO = path.resolve(H, "../../..");
const ADB = process.env.ADB || path.join(process.env.HOME, "Android/Sdk/platform-tools/adb"), P = "host.enclave.anchor.avf", F = `/data/user/0/${P}/files`;
const NAME = "pixel10-pvm-cpu", RPORT = 18443, CHAINPORT = 18845, CSPORT = 18470, SERVE_S = 3600, BLOCK_S = 2;   // SERVE_S: the host allows 10..3600 (attempt 1 passed 7200 and the app refused the plan)
const ORIGIN = `https://127.0.0.1:${RPORT}`, ENDPOINT = `${ORIGIN}/t/${NAME}`, RELAY_HTTP = `http://127.0.0.1:${RPORT}`;
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate (LAB-ONLY pin)
const RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba", ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const OWNER_INSTANCE = "ccd79db14e9f3a22d21ee4969f38def76db21f53fa7503fba8cd20f97ec7a340";   // the owner's instance, known OUT OF BAND (enrolled 09-24; re-checked from the VM's own log)
const MODELS = [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "gemma-4-e2b-it-q4_0", selftestSha256: "9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f", minDecodeTokS: 10 }];
const BUNDLE = path.join(H, "runtime/conformance/bundles/stream-probe.wasm"), APPID = createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
const DIST = path.join(H, "client/dist/pvm-client.mjs"), SIGN = path.join(H, "client/tools/lab-sign.mjs"), DIST_SHA = "251dd8fa7ec0a14f2c3fc11aef03a85b78fb29f992b1ea42e99d1bbc977d58e9";
const POLICY = { confirmations: 2, receiptTimeoutMs: 10000, confirmTimeoutMs: 30000, pollMs: 1000, maxReplacements: 3, maxAnchorAgeBlocks: 20 };
const LAB_REGISTER = { repo: "lab/pvm-relay-reconnect", measurement: "0x" + CODE, cpuPricePerSec6: "834" };   // synthetic LAB values
const RUN_ID = "rc" + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
// relay cwd and state, lab keys: outside the repository, and one directory PER RUN (attempt 2 met attempt 1's lab keys)
const SCRATCH = path.join(process.env.HOME, "enclave-bench/pvm-reconnect", `${path.basename(OUT)}-${RUN_ID}-scratch`);
if (fs.existsSync(SCRATCH)) { console.error(`${SCRATCH} exists: refusing to reuse another run's scratch`); process.exit(2); }
fs.mkdirSync(path.join(OUT, "vm"), { recursive: true }); fs.mkdirSync(path.join(OUT, "client"), { recursive: true }); fs.mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
const log = (m) => { const l = `${new Date().toISOString().slice(11, 19)}Z ${m}`; console.log(l); fs.appendFileSync(path.join(OUT, "run.log"), l + "\n"); };
const rec = (f, o) => fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + "\n");
const sh = (cmd) => { try { return execFileSync(ADB, ["shell", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, ""); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false, curStep = "setup";
const fail = (m) => { log(`STOP: ${m}`); stopped = true; throw new Error(m); };
const step = (name, ok, facts) => { rec("steps.jsonl", { step: name, ok: !!ok, facts, utc: new Date().toISOString() }); log(`${name}: ${ok ? "ok" : "UNEXPECTED"} ${JSON.stringify(facts).slice(0, 300)}`); if (!ok) fail(`${name}: ${JSON.stringify(facts).slice(0, 500)}`); };

const { startLeaseChain } = await import(path.join(REPO, "test/fixtures/lease-chain.mjs"));
const { AGENT_CONFIG_FORMAT } = await import(path.join(H, "runner/proof-agent.mjs"));
const { createRunnerAgent, RUNNER_CONFIG_FORMAT } = await import(path.join(H, "runner/runner-agent.mjs"));
const { createAttachCosigner } = await import(path.join(H, "runner/attach-cosigner.mjs"));
const { WebSocket } = await import("ws");
const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
let OPKEY = generatePrivateKey(), WRONGKEY = generatePrivateKey();
const operator = privateKeyToAccount(OPKEY), wrongOperator = privateKeyToAccount(WRONGKEY);
let chain = null, relay = null, relayN = 0, runner = null, proxy = null, policySrv = null, ownerCs = null, wrongCs = null;
const cleanup = () => { for (const x of [runner, ownerCs, wrongCs]) try { x && x.close(); } catch {} for (const s of [proxy, policySrv]) try { s && s.close(); } catch {}
  try { relay && relay.kill("SIGCONT"); relay && relay.kill("SIGKILL"); } catch {} try { chain && chain.stop(); } catch {}
  try { execFileSync(ADB, ["reverse", "--remove", `tcp:${RPORT}`], { stdio: "ignore" }); } catch {} try { execFileSync(ADB, ["reverse", "--remove", `tcp:${CSPORT}`], { stdio: "ignore" }); } catch {} };
const STATE = path.join(OUT, ".agent-state");
let D = null;
try {
  // ================= setup: chain, relay (scrubbed), co-signers behind the proxy, phone =================
  chain = await startLeaseChain({ port: CHAINPORT, operatorAccount: operator, addressBook: true, blockTime: BLOCK_S });
  const enclaveId = V.keccak256(V.stringToBytes(ENDPOINT));
  D = await chain.createFunded(); const pins = chain.pins(D, enclaveId);
  const relayEnv = (codeHashes) => ({ PATH: process.env.PATH,   // env -i + the allowlist below: nothing inherited from this shell
    API_RELAY_PORT: String(RPORT), API_RELAY_BIND: "127.0.0.1", BASE_RPC: chain.rpc, RPC_FALLBACKS: "0", ADDRESS_BOOK_ADDRESS: chain.addresses.addressBook,
    REGISTRY_POLL_SEC: "5", AVAIL_POLL_SEC: "5", TUNNEL_PUBLIC_ORIGIN: ORIGIN,
    AUTH_DATA_DIR: path.join(SCRATCH, "auth"), STATE_DIRECTORY: path.join(SCRATCH, "state"), FEATURED_VIEWS_FILE: path.join(SCRATCH, "featured-views.json"),
    PVM_SERVING: "1", METAL_AVF_CODE_HASHES: codeHashes, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_CODE_HASHES: codeHashes, PVM_CPU_MODELS: JSON.stringify(MODELS),
    PVM_APP_IDS: APPID, PVM_APP_RUNTIME_IDS: RID });
  const startRelay = async (codeHashes, why) => {
    const env = relayEnv(codeHashes), n = ++relayN, lf = path.join(OUT, `relay-${n}.log`);
    rec("relay-env.jsonl", { n, why, names: Object.keys(env).sort(), values: Object.fromEntries(Object.entries(env).filter(([k]) => k !== "PATH")),
      defaultsReliedOn: { RELAY_HVNODE_ATTACH: "unset (off)", RELAY_REVERIFY: "unset", TRUSTED_OPERATORS: "unset (the default)", METAL_TUNNEL_TOKENS: "unset" }, labOnly: { METAL_AVF_AUTHORITY_HASHES: "the TEST APK certificate" } });
    fs.mkdirSync(env.AUTH_DATA_DIR, { recursive: true }); fs.mkdirSync(env.STATE_DIRECTORY, { recursive: true });
    relay = spawn(process.execPath, [path.join(REPO, "relay/api-relay.js")], { cwd: SCRATCH, env, stdio: ["ignore", fs.openSync(lf, "a"), fs.openSync(lf, "a")] });
    for (let i = 0; i < 60; i++) { await sleep(500); if (fs.readFileSync(lf, "utf8").includes(`[api-relay] :${RPORT}`)) break; if (relay.exitCode !== null) fail(`relay ${n} exited: ${fs.readFileSync(lf, "utf8").slice(-400)}`); }
    const ok = (await fetch(`${RELAY_HTTP}/health`).then((r) => r.status).catch(() => 0)) === 200;
    log(`relay ${n} (${why}): ${ok ? "up" : "NOT up"}; admits build ${codeHashes.slice(0, 16)}…`);
    if (!ok) fail("relay did not come up");
    return n;
  };
  const stopRelay = async () => { if (relay) { relay.kill("SIGCONT"); relay.kill("SIGTERM"); await sleep(1500); try { relay.kill("SIGKILL"); } catch {} relay = null; } };
  const relayLog = (n) => { try { return fs.readFileSync(path.join(OUT, `relay-${n}.log`), "utf8"); } catch { return ""; } };
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ runId: RUN_ID, apk: path.basename(APK), code: CODE, oldCode: OLD_CODE, app: APPID, endpoint: ENDPOINT, pins, accounts: chain.accounts,
    addresses: chain.addresses, chain: `anvil (local: no network, no funds), a block every ${BLOCK_S} s`, googleRootPins: ROOTS, runtimeId: RID, authority: AUTH, ownerInstanceOutOfBand: OWNER_INSTANCE,
    wrongOperator: wrongOperator.address.toLowerCase(), policy: POLICY, labRegister: LAB_REGISTER, relay: { origin: ORIGIN, port: RPORT, scratch: "outside the repository" },
    operatorKey: "fresh random keys for this run (operator, wrong operator), held in memory only, never written" }, null, 1));
  // the owner's and a WRONG operator's co-signer (the same checks), in process; the phone reaches them only through the PROXY
  const mkCs = (account, file) => createAttachCosigner({ account, name: NAME, relay: RELAY_HTTP, codeHashes: [CODE], authorityHashes: [AUTH], rootPins: ROOTS, instanceIds: [OWNER_INSTANCE],
                                                         journalFile: path.join(OUT, file), rate: { max: 30, ms: 60000 } });
  ownerCs = mkCs(operator, "cosign-journal.jsonl"); wrongCs = mkCs(wrongOperator, "cosign-journal-wrong.jsonl");
  const px = { modes: ["owner"], lastOwnerSig: null };   // the queue of answers; the last one repeats
  proxy = await new Promise((resolve) => {
    const s = http.createServer((q, res) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", async () => {
      const mode = px.modes.length > 1 ? px.modes.shift() : px.modes[0], utc = new Date().toISOString();
      let reqJ = null; try { reqJ = JSON.parse(b); } catch {}
      if (mode === "down") { rec("attach.jsonl", { signer: "proxy-down", step: curStep, utc, request: reqJ, verdict: null }); return q.socket.destroy(); }
      if (mode === "stale") { rec("attach.jsonl", { signer: "proxy-stale", step: curStep, utc, request: reqJ, verdict: { ok: true, operatorSig: px.lastOwnerSig, stale: true } });
        res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ operatorSig: px.lastOwnerSig })); }
      const cs = mode === "wrong" ? wrongCs : ownerCs, v = reqJ ? await cs.sign(reqJ) : { ok: false, reason: "not JSON" };
      rec("attach.jsonl", { signer: mode === "wrong" ? "wrong-operator" : "owner", step: curStep, utc, request: reqJ, verdict: v });
      if (v.ok && mode === "owner") px.lastOwnerSig = v.operatorSig;
      res.writeHead(v.ok ? 200 : 403, { "content-type": "application/json" }); res.end(JSON.stringify(v.ok ? { operatorSig: v.operatorSig } : { error: v.reason }));
    }); });
    s.listen(CSPORT, "127.0.0.1", () => resolve({ close: () => s.close() }));
  });
  const want = execFileSync("sha256sum", [APK], { encoding: "utf8" }).slice(0, 64), have = sh(`sha256sum $(pm path ${P} | sed s/package://)`).slice(0, 64);
  if (want !== have) { execFileSync(ADB, ["install", "-r", APK], { stdio: "ignore", timeout: 300000 }); log(`installed ${path.basename(APK)} over the previous build, data kept (${want})`); }
  else log(`installed APK is already ${path.basename(APK)} (${want})`);
  execFileSync(ADB, ["push", BUNDLE, "/data/local/tmp/app-stream-probe.wasm"], { stdio: "ignore" }); sh(`run-as ${P} cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm`);
  for (const p of [RPORT, CSPORT]) execFileSync(ADB, ["reverse", `tcp:${p}`, `tcp:${p}`], { stdio: "ignore" });
  const CAP = `${RUN_ID}-a`;
  const vmLog = () => { const c = sh(`run-as ${P} cat files/capture/${CAP}.log`); if (c) fs.writeFileSync(path.join(OUT, "vm", "a.log"), c); return c || (fs.existsSync(path.join(OUT, "vm", "a.log")) ? fs.readFileSync(path.join(OUT, "vm", "a.log"), "utf8") : ""); };
  const count = (c, re) => (c.match(new RegExp(re.source, "gm")) || []).length;
  const accepted = (c) => count(c, /RELAY re-attach \d+: ACCEPTED in place/);
  // wait until the VM log satisfies pred (polled every 3 s), or fail after ms
  const vmUntil = async (pred, ms, what) => { const t0 = Date.now(); for (;;) { const c = vmLog(); if (pred(c)) return c; if (Date.now() - t0 > ms) fail(`${what}: not within ${ms / 1000} s`); await sleep(3000); } };
  const row = async () => { const j = await fetch(`${RELAY_HTTP}/enclaves`).then((r) => r.json()).catch(() => null); const rows = Array.isArray(j) ? j : (j && (j.enclaves || j.rows)) || [];
    const mine = rows.filter((e) => e.endpoint === `tunnel://${NAME}`); rec("rows.jsonl", { step: curStep, utc: new Date().toISOString(), rows: mine }); return mine; };
  // the route is up when /x answers; then wait out the VM's 2 s evidence budget this probe spent (the agent must not meet it)
  const routeUp = async (ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fetch(`${RELAY_HTTP}/x/${D}/pvm/evidence`, { method: "POST", body: `EVIDENCE ${randomBytes(32).toString("hex")}\n` }).catch(() => null);
    if (r && r.status === 200) { await r.text(); await sleep(2500); return true; } if (r) await r.text().catch(() => {}); await sleep(3000); } return false; };
  // the agents' carrier, recorded (request and answer, for offline re-verification)
  const recordingFetch = async (url, init) => { const t0 = new Date().toISOString(), body = String(init && init.body || "").trim();
    const r = await fetch(url, init); const text = await r.text(); rec("exchanges.jsonl", { step: curStep, url: url.replace(RELAY_HTTP, ""), utcStart: t0, utcEnd: new Date().toISOString(), request: body, status: r.status, answer: text });
    return new Response(text, { status: r.status, headers: r.headers }); };
  const hooks = { swallow: false };
  const client = new Proxy(chain.publicClient, { get(t, k) {
    if (k === "sendRawTransaction") return async (a) => { const h = V.keccak256(a.serializedTransaction); if (hooks.swallow) { rec("chain.jsonl", { label: "swallowed-send", step: curStep, hash: h }); return h; } return t.sendRawTransaction(a); };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
  const cfg = (carrier, over = {}) => ({ format: RUNNER_CONFIG_FORMAT, lifecycle: { register: LAB_REGISTER, claim: true },
    proof: { format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint: ENDPOINT,
      operator: operator.address.toLowerCase(), carrier, maxFeePerGasWei: "100000000000",
      evidence: { appId: APPID, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS, instanceIds: [OWNER_INSTANCE] }, policy: { ...POLICY, ...over } } });
  const BOOT = `${RELAY_HTTP}/t/${NAME}/pvm/evidence`, XROUTE = `${RELAY_HTTP}/x/${D}/pvm/evidence`;
  const newRunner = (carrier, over) => createRunnerAgent({ config: cfg(carrier, over), publicClient: client, account: operator, stateDir: STATE, fetchImpl: recordingFetch,
    log: (o) => { if (["done", "stuck", "recover", "attest", "refused", "broadcast-failed", "rate-retry"].includes(o.ev)) log(`  agent ${o.ev}${o.op ? " " + o.op : ""}${o.kind ? " " + o.kind : ""}${o.reason ? ": " + String(o.reason).slice(0, 140) : ""}`); } });
  // the built client, isolated state and lab keys outside the repository; policies served locally
  if (execFileSync("sha256sum", [DIST], { encoding: "utf8" }).slice(0, 64) !== DIST_SHA) fail("client/dist/pvm-client.mjs is not the pinned 0.5.0 dist");
  const KEYS = path.join(SCRATCH, "lab-keys"); fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const CLI = path.join(SCRATCH, "pvm-client.mjs"); fs.copyFileSync(DIST, CLI);
  const TOOL_ENV = { PATH: process.env.PATH }; rec("tool-env.jsonl", { names: Object.keys(TOOL_ENV), note: "the built client and lab-sign: PATH only; keys and state in the scratch dir" });
  const node = (args, label) => new Promise((resolve) => { const c = spawn(process.execPath, args, { env: TOOL_ENV, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("exit", (code) => { if (label) fs.writeFileSync(path.join(OUT, "client", `${label}.jsonl`), o); resolve({ code, out: o, err: e }); }); });
  const keygen = async (name) => { const r = await node([SIGN, "keygen", "--keys", KEYS, "--name", name]); if (r.code !== 0) fail(`lab-sign keygen ${name}: ${r.err.trim().slice(0, 200)}`); return JSON.parse(r.out); };
  const pkey = await keygen("policy"), rkey = await keygen("release");
  let current = null;
  policySrv = await new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(current ? 200 : 404, { "content-type": "application/json" }); res.end(current || ""); }); s.listen(0, "127.0.0.1", () => r({ port: s.address().port, close: () => s.close() })); });
  let serial = 0;
  const signPolicy = async (deployments, codeHashes = [CODE]) => {
    const t = (s) => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), body = path.join(KEYS, `policy-${++serial}.body.json`), outp = path.join(OUT, "client", `policy-${serial}.json`);
    fs.writeFileSync(body, JSON.stringify({ type: "enclave-pvm-client-policy/2", key: "", serial, notBefore: t(-3600), notAfter: t(6 * 3600), codeHashes, authorityHashes: [AUTH], runtimeIds: [RID], appIds: [APPID],
      googleRootPins: ROOTS, formats: ["enclave-pvm-app-evidence/v3"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.5.0", nextPolicyKey: null, deployments }));
    const r = await node([SIGN, "policy", "--keys", KEYS, "--body", body, "--out", outp]); if (r.code !== 0) fail(`policy signing: ${r.err}`); current = fs.readFileSync(outp, "utf8"); };
  const CSTATE = path.join(OUT, "client", "state.d");
  if ((await node([CLI, "install", "--state", CSTATE, "--policy-key-fp", pkey.fingerprint, "--serial-floor", "1", "--release-key-fp", rkey.fingerprint], "install")).code !== 0) fail("client install failed");
  const turn = async (label) => { await sleep(3000);
    const r = await node([CLI, "run", "--state", CSTATE, "--policy", `http://127.0.0.1:${policySrv.port}/`, "--relay-base", RELAY_HTTP, "--deployment", D, "--path", "/?graph=gemma-4-e2b-it-q4_0&steps=8"], label);
    const lines = r.out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)); return (lines.reverse().find((x) => x.result) || {}).result || { refused: r.err.slice(-300) }; };
  const bound = (c) => c.complete === true && c.deployment && c.deployment.instance === OWNER_INSTANCE;
  const prove = async (label) => { await sleep(62000); await chain.advance(30); curStep = label; const t = await runner.tick(); return t.proof && t.proof.kind === "landed" ? t : { failed: true, t }; };
  // one drop: the relay stops, the phone's tunnel ends, the relay comes back; resolves once the VM re-attached in place
  const dropAndBack = async (label, downMs = 8000, codeHashes = CODE, why = "back after a drop") => {
    const before = accepted(vmLog());
    curStep = label; await stopRelay(); await sleep(downMs);
    const n = await startRelay(codeHashes, why);
    return { before, n };
  };
  const reattached = async (before, ms = 240000, what = "an in-place re-attach") => { const c = await vmUntil((x) => accepted(x) > before, ms, what); return c; };
  const bootCount = (c) => ({ starts: count(c, /ANCHOR start in pVM/), spki: [...new Set((c.match(/^VSOCK SPKI [0-9a-f]+$/gm) || []))].length, instances: count(c, /INSTANCE id=/) });

  // ================= A: one boot =================
  curStep = "A-relay"; await startRelay(CODE, "the lab build");
  curStep = "A-attach";
  sh(`am force-stop ${P}; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard`); await sleep(2000);
  if (!/mWakefulness=Awake/.test(sh("dumpsys power"))) fail("PHONE NOT AWAKE");
  const pinLine = [pins.chainId, pins.proofOfTime, pins.registry, pins.deployment, pins.enclaveId, pins.operator].join(" ");
  sh(`am start -S -n ${P}/.Main --es mode app --es vmname anchorlocal --es model ${F}/model.gguf --es app ${F}/app-stream-probe.wasm --es app_graph gemma-4-e2b-it-q4_0 --ei app_tls 1 --ei app_serve_s ${SERVE_S} --es relay ws://127.0.0.1:${RPORT}/v1/fleet-tunnel --es name ${NAME} --es capture ${CAP} --es proof_pins '${pinLine}' --es attach_signer http://127.0.0.1:${CSPORT}/attach-sign`);
  const t0 = Date.now();
  const a0 = await vmUntil((c) => (/RELAY attest ACCEPTED/.test(c) && /RELAY keeper armed/.test(c)) || /RELAY attest REJECTED|RELAY closed without a verdict|RELAY dial failed|^CAPTURE END/m.test(c), 400000, "the boot attach");
  const a = { accepted: /RELAY attest ACCEPTED/.test(a0), instance: (/INSTANCE id=([0-9a-f]{64})/.exec(a0) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(a0) || [])[1], spki: (/^VSOCK SPKI ([0-9a-f]+)$/m.exec(a0) || [])[1] };
  step("A-attach", a.accepted && a.instance === OWNER_INSTANCE && /RELAY keeper armed/.test(a0), { accepted: a.accepted, instance: a.instance, proofKey: a.proofKey, spki: a.spki && a.spki.slice(0, 24) + "…", bootMs: Date.now() - t0 });
  let r0 = []; for (let i = 0; i < 20 && !(r0[0] && r0[0].tier); i++) { await sleep(3000); r0 = await row(); }
  step("A-row", r0.length === 1 && r0[0].mode === "avf" && r0[0].tier === "pvm-cpu" && r0[0].eligible === false && r0[0].serving === false && r0[0].publicUrl === ENDPOINT, { rows: r0.length, tier: r0[0] && r0[0].tier, eligible: r0[0] && r0[0].eligible });
  curStep = "A-bootstrap"; runner = await newRunner(BOOT);
  const st = await runner.start();
  step("A-bootstrap-attest", st.attested && st.attested.proofKey === a.proofKey && st.attested.instanceId === OWNER_INSTANCE, { proofKey: st.attested && st.attested.proofKey, reason: st.attestReason });
  curStep = "A-register"; const t1 = await runner.tick();
  step("A-register", t1.lifecycle && t1.lifecycle.kind === "landed" && /^register/.test(t1.lifecycle.op) && (await chain.registeredProofKey(enclaveId)) === a.proofKey, { lifecycle: t1.lifecycle });
  await sleep(4000);
  curStep = "A-claim"; const t2 = await runner.tick();
  step("A-claim", t2.lifecycle && t2.lifecycle.kind === "landed" && t2.lifecycle.op === "claim", { lifecycle: t2.lifecycle });
  runner.close(); runner = null;
  curStep = "A-route"; step("A-route", await routeUp(), { route: `/x/${D}/pvm/evidence` });
  runner = await newRunner(XROUTE); await runner.start();
  const p0 = await prove("A-prove"); step("A-prove", !p0.failed, { proof: p0.proof ? p0.proof.kind : JSON.stringify(p0.t).slice(0, 200) });
  await signPolicy([{ id: D, app: APPID, instances: [OWNER_INSTANCE] }]);
  curStep = "A-client"; const c0 = await turn("a-bound");
  step("A-client", bound(c0), { complete: c0.complete, instance: c0.deployment && c0.deployment.instance, refused: c0.refused });

  // ================= R1: three drops, each re-attached in place =================
  for (const i of [1, 2, 3]) {
    const { before } = await dropAndBack(`R1-drop-${i}`, 6000 + i * 4000);
    const c = await reattached(before);
    const bc = bootCount(c);
    step(`R1-back-${i}`, accepted(c) === before + 1 && bc.starts === 1 && bc.spki === 1 && bc.instances === 1, { reattached: accepted(c), boots: bc });
    curStep = `R1-route-${i}`; step(`R1-route-${i}`, await routeUp(), { route: "back" });
    const rr = await row(); step(`R1-row-${i}`, rr.length === 1 && rr[0].publicUrl === ENDPOINT && !rr[0].tier && rr[0].serving === false, { rows: rr.length, tier: rr[0] && rr[0].tier || null });
    curStep = `R1-client-${i}`; const cc = await turn(`r1-bound-${i}`);
    step(`R1-client-${i}`, bound(cc), { complete: cc.complete, refused: cc.refused });
    const pp = await prove(`R1-prove-${i}`); step(`R1-prove-${i}`, !pp.failed, { proof: pp.proof ? pp.proof.kind : JSON.stringify(pp.t).slice(0, 200) });
  }

  // ================= R2: a FROZEN relay (half-open), then thawed =================
  {
    curStep = "R2-freeze"; const c0 = vmLog(), before = accepted(c0), n = relayN;
    const gone = (x) => count(x, /RELAY keeper: the tunnel is gone/), silent = (x) => count(x, /RELAY serve error .*(SocketTimeout|timed out)/);
    const gone0 = gone(c0), silent0 = silent(c0), tf = Date.now();
    relay.kill("SIGSTOP"); log(`relay ${n} FROZEN (SIGSTOP): no FIN reaches the phone`);
    const c1 = await vmUntil((x) => gone(x) > gone0 && silent(x) > silent0, 200000, "the phone's silence watchdog");
    step("R2-watchdog", accepted(c1) === before, { note: "the phone gave up on a silent tunnel (no frame for RelayAttach.SILENT_MS = 95 s)", afterMs: Date.now() - tf });
    await sleep(20000);
    curStep = "R2-thaw"; relay.kill("SIGCONT"); log(`relay ${n} THAWED (SIGCONT)`);
    const c = await reattached(before, 300000, "the re-attach after the thaw");
    await sleep(6000);
    const rr = await row(), rl = relayLog(n);
    const lastAttach = rl.lastIndexOf(`[tunnel] ${NAME} attached via`), liveAfter = rl.slice(lastAttach);
    step("R2-one-tunnel", rr.length === 1 && accepted(c) === before + 1 && lastAttach > 0 && /\(1 enclave\)/.test(liveAfter.split("\n")[0]) && bootCount(c).starts === 1,
         { rows: rr.length, reattached: accepted(c), relayLine: liveAfter.split("\n")[0].slice(0, 120) });
    curStep = "R2-route"; step("R2-route", await routeUp(), { route: "back" });
    await sleep(62000);   // up for 60 s: the phone's backoff resets, as designed, before the next drop
  }

  // ================= R3: the co-signer down, wrong, stale; then the owner; then a replayed attest frame =================
  {
    px.modes = ["down", "wrong", "stale", "owner"];
    const { before, n } = await dropAndBack("R3-drop", 4000);
    const c = await reattached(before, 400000, "the re-attach once the owner's co-signer answers");
    const rl = relayLog(n), rej = [...rl.matchAll(/\[tunnel\] pixel10-pvm-cpu attest REJECTED: (.*)/g)].map((m) => m[1]);
    const ownerA = operator.address.toLowerCase(), wrongA = wrongOperator.address.toLowerCase();
    const want = [/must carry operatorSig/, new RegExp(`registered on chain to ${ownerA}, not ${wrongA}`), new RegExp(`registered on chain to ${ownerA}, not 0x(?!${wrongA.slice(2)})[0-9a-f]{40}`)];
    step("R3-refusals", rej.length >= 3 && want.every((re, i) => re.test(rej[i] || "")) && accepted(c) === before + 1, { refusals: rej.map((r) => r.slice(0, 90)), reattached: accepted(c) });
    curStep = "R3-route"; step("R3-route", await routeUp(), { route: "back" });
    // the harness replays the accepted attest frame (its rad over nonce N, the owner's co-signature for N) on a fresh connection N'
    const last = fs.readFileSync(path.join(OUT, "attach.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.signer === "owner" && x.verdict && x.verdict.ok).at(-1);
    curStep = "R3-replay";
    const ws = new WebSocket(`ws://127.0.0.1:${RPORT}/v1/fleet-tunnel`, { headers: { "x-metal-name": NAME, "x-metal-attest": "1" } }); const frames = [];
    ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    for (let i = 0; i < 100 && !frames.some((f) => f.t === "challenge"); i++) await sleep(50);
    const ch = frames.find((f) => f.t === "challenge");
    ws.send(JSON.stringify({ t: "attest", rad: last.request.rad, operatorSig: last.verdict.operatorSig }));
    for (let i = 0; i < 200 && !frames.some((f) => f.t === "attest-result"); i++) await sleep(50);
    const res = frames.find((f) => f.t === "attest-result"); try { ws.close(); } catch {}
    rec("replay.jsonl", { step: curStep, utc: new Date().toISOString(), replayedNonce: last.request.nonce, connectionNonce: ch && ch.nonce, frame: { rad: last.request.rad, operatorSig: last.verdict.operatorSig }, result: res || null });
    await sleep(3000);
    const rr = await row();
    step("R3-replay", res && res.ok === false && /attestationChallenge does not match/.test(res.reason || "") && ch && ch.nonce !== last.request.nonce && rr.length === 1, { reason: res && res.reason, rows: rr.length });
    curStep = "R3-client"; const cc = await turn("r3-bound");
    step("R3-client", bound(cc), { complete: cc.complete, refused: cc.refused });
    await sleep(62000);
  }

  // ================= R4: exactly once across a drop =================
  {
    // a request cut by a drop signs and sends no checkpoint (an owner-side lifecycle call -- a heartbeat -- needs no VM and may go out)
    const signedN = () => { try { return fs.readFileSync(path.join(STATE, "journal.jsonl"), "utf8").split("\n").filter((l) => l.includes('"ev":"signed"')).length; } catch { return 0; } };
    const s0 = signedN();
    curStep = "R4-cut"; await stopRelay(); await sleep(62000); await chain.advance(30);
    const t = await runner.tick(), s1 = signedN();
    step("R4-cut", s1 === s0 && ((t.proof && ["carrier-failed", "attest-failed"].includes(t.proof.kind)) || ["carrier-failed", "attest-failed"].includes(t.kind)), { kind: t.kind, proof: t.proof && t.proof.kind, lifecycle: t.lifecycle && t.lifecycle.op || null, checkpointsSigned: s1 - s0 });
    let before = accepted(vmLog()); await startRelay(CODE, "back after the cut"); await reattached(before);
    curStep = "R4-route"; step("R4-route", await routeUp(), { route: "back" });
    // a normal tick first, so any lifecycle call that is due (a heartbeat, a renew) goes out now and the crash below is the proof's
    const pre = await prove("R4-pre"); step("R4-pre", !pre.failed, { proof: pre.proof ? pre.proof.kind : JSON.stringify(pre.t).slice(0, 200), lifecycle: pre.lifecycle && pre.lifecycle.op || null });
    // a checkpoint journaled and signed but never delivered; the agent stops; the relay drops and returns; the VM re-attaches
    runner.close(); runner = null; await sleep(62000); await chain.advance(30); hooks.swallow = true;
    runner = await newRunner(XROUTE, { maxReplacements: 0, receiptTimeoutMs: 5000 }); await runner.start();
    curStep = "R4-crash"; const t4 = await runner.tick();
    step("R4-crash", !t4.lifecycle && (t4.kind === "in-flight" || (t4.proof && t4.proof.kind === "stuck")), { kind: t4.kind, proof: t4.proof && t4.proof.kind, lifecycle: t4.lifecycle || null });
    runner.close(); runner = null; hooks.swallow = false;
    ({ before } = await dropAndBack("R4-drop", 8000)); const c = await reattached(before);
    step("R4-back", accepted(c) === before + 1 && bootCount(c).starts === 1, { reattached: accepted(c) });
    curStep = "R4-route-2"; step("R4-route-2", await routeUp(), { route: "back" });
    runner = await newRunner(XROUTE); curStep = "R4-recover"; const re = await runner.start();
    step("R4-recover", re.recovered && re.recovered.kind === "landed", { recovered: re.recovered && { kind: re.recovered.kind, hash: re.recovered.hash } });
    await sleep(62000);
  }

  // ================= R5: a relay pinning ANOTHER build; the right one; no tier in place =================
  {
    const before = accepted(vmLog());
    curStep = "R5-old-build"; await stopRelay(); const n = await startRelay(OLD_CODE, "admits only the OLD build");
    const t0r = Date.now(); let rl = ""; while (Date.now() - t0r < 120000 && !/attest REJECTED: .*codeHash/.test(rl = relayLog(n))) await sleep(3000);
    const c = vmLog();
    step("R5-old-build", /attest REJECTED: no APK component with an allowlisted codeHash/.test(rl) && accepted(c) === before, { rejected: ((/attest REJECTED: (.*)/.exec(rl) || [])[1] || "").slice(0, 100), reattached: accepted(c) });
    curStep = "R5-right"; await stopRelay(); await startRelay(CODE, "the lab build again");
    const c2 = await reattached(before);
    step("R5-right", accepted(c2) === before + 1 && bootCount(c2).starts === 1, { reattached: accepted(c2) });
    curStep = "R5-route"; step("R5-route", await routeUp(), { route: "back" });
    await sleep(12000);
    curStep = "R5-no-tier"; const rr = await row(), serving = await fetch(`${RELAY_HTTP}/v1/enclaves`).then(async (r) => ({ status: r.status, body: await r.text() })).catch(() => ({ status: 0, body: "" }));
    step("R5-no-tier", rr.length === 1 && !rr[0].tier && rr[0].eligible === false && rr[0].serving === false && !serving.body.includes(`tunnel://${NAME}`) && !serving.body.includes(ENDPOINT),
         { tier: rr[0] && rr[0].tier || null, eligible: rr[0] && rr[0].eligible, serving: rr[0] && rr[0].serving, servingEnclaves: serving.status });
  }

  // ================= D: the final proof, then release =================
  await sleep(62000); await chain.advance(60);
  curStep = "D-release"; const rl = await runner.stop({ release: true });
  step("D-release", rl.kind === "released" && rl.proof && rl.proof.kind === "landed", { kind: rl.kind, proof: rl.proof && rl.proof.kind });
  const cz = vmLog(); step("D-one-boot", bootCount(cz).starts === 1 && bootCount(cz).spki === 1 && accepted(cz) >= 8, { boots: bootCount(cz), reattached: accepted(cz) });
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
      for (const [contract, names] of [["registry", ["Registered", "Updated", "ProofKeySet", "Heartbeat", "Deregistered"]], ["ledger", ["Claimed", "Renewed", "Released", "EarningsWithdrawn"]], ["prover", ["Checkpointed"]]])
        for (const n of names) for (const l of await chain.events(contract, n)) rec("chain-events.jsonl", J({ contract, event: n, block: l.blockNumber, tx: l.transactionHash, args: l.args }));
      if (D) { const dd = await chain.deployment(D); rec("chain.jsonl", { label: "final", runner: dd.runner, leaseUntil: String(dd.leaseUntil), provenUntil: await chain.provenUntil(D) }); }
    }
  } catch (e) { log(`records: ${e.message}`); process.exitCode = 1; }
  cleanup();
  fs.rmSync(STATE, { recursive: true, force: true });
  const found = []; const hexes = [OPKEY.slice(2), WRONGKEY.slice(2)];
  const walk = (dd) => { for (const f of fs.readdirSync(dd)) { const p = path.join(dd, f); if (fs.statSync(p).isDirectory()) walk(p); else { const b = fs.readFileSync(p); if (hexes.some((h) => b.includes(h))) found.push(p); } } };
  walk(OUT); OPKEY = null; WRONGKEY = null;
  log(found.length ? `KEY FOUND in ${found.join(", ")}` : "the operator keys appear nowhere in the results");
  if (found.length) process.exitCode = 1;
}
