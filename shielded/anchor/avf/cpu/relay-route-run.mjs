#!/usr/bin/env node
// relay-route-run.mjs <out_dir> <apk> <code_hash> <old_code_hash> -- the pVM CPU runner through the REAL relay (relay/api-relay.js)
// instead of the lab hub (RUNNER-AGENT.md "Before the lease, and attaching once registered"; design reviewed with the verifier
// session). LAB, not production: an ISOLATED relay process (a scrubbed environment: env -i plus an allowlist, recorded; a
// scratch cwd; every state path in it; PVM_SERVING on in THIS process only), a LOCAL anvil chain mining a block every 2 s with
// the real contracts, a fresh random operator key held in memory, the TEST APK authority (lab-only), the built client.
// Nothing here touches the production relay, its env, Base, or funds.
// Phases (every step checked against its expectation; the run stops at the first that differs, never retried):
//   A  relay up; the phone attaches UNREGISTERED (first-come: no co-signature needed); the relay's /enclaves row (mode avf,
//      tier pvm-cpu, not eligible, the inference-lane reason, never serving); the runner agent BOOTSTRAPS through
//      /t/<name>/pvm/evidence (the attested key over its own nonce), registers, claims; the /x/<D>/pvm route comes up; the
//      agent proves through /x; the built client verifies and is served (sealed) through /x; the client refuses another
//      instance, another build, and a stale (replayed) answer; a checkpoint journaled but never delivered lands ONCE after a
//      restart
//   B  disconnect: the relay stops (proofs fail at the carrier), comes back; the phone is gone (no in-place re-attach: gap B);
//      the VM restarts WITHOUT the co-signer -> refused (a registered name); with a WRONG operator's co-signer -> refused;
//      with the owner's co-signer -> attached (the same instance, a new transport key); the client and the proofs resume
//   C  the relay admits only ANOTHER build -> the attach is refused on the build; the right relay again -> attached
//   D  the agent's final proof, then release
// Records: run.json, relay-env.json (the allowlisted names and values: none secret), run.log, steps.jsonl, exchanges.jsonl
// (every agent<->relay exchange, request and answer, for offline re-verification), attach.jsonl (every co-signer request,
// verdict and signature), client/*.jsonl, vm/*.log, relay-*.log, journal.jsonl, cosign-journal.jsonl, chain-events.jsonl,
// receipts.jsonl. runtime/conformance/check-relay-route.mjs re-checks it offline.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const [OUT, APK, CODE, OLD_CODE] = process.argv.slice(2);
if (!OUT || !APK || !/^[0-9a-f]{64}$/.test(CODE || "") || !/^[0-9a-f]{64}$/.test(OLD_CODE || "")) { console.error("usage: relay-route-run.mjs <out_dir> <apk> <code_hash> <old_code_hash>"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`${OUT} exists: refusing to mix runs`); process.exit(2); }
const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), REPO = path.resolve(H, "../../..");
const ADB = process.env.ADB || path.join(process.env.HOME, "Android/Sdk/platform-tools/adb"), P = "host.enclave.anchor.avf", F = `/data/user/0/${P}/files`;
const NAME = "pixel10-pvm-cpu", RPORT = 18443, CHAINPORT = 18845, CSPORT = 18470, WRONGPORT = 18471, SERVE_S = 3600, BLOCK_S = 2;
const ORIGIN = `https://127.0.0.1:${RPORT}`, ENDPOINT = `${ORIGIN}/t/${NAME}`, RELAY_HTTP = `http://127.0.0.1:${RPORT}`;
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate (LAB-ONLY pin)
const RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba", ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const OWNER_INSTANCE = "ccd79db14e9f3a22d21ee4969f38def76db21f53fa7503fba8cd20f97ec7a340";   // the owner's instance, known OUT OF BAND (enrolled 09-24; re-checked below from the VM's own log)
const MODELS = [{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "gemma-4-e2b-it-q4_0", selftestSha256: "9c4c7f764bf657c708cb19c6493a0be303db49093fd7df1432664cfd3801ce2f", minDecodeTokS: 10 }];
const BUNDLE = path.join(H, "runtime/conformance/bundles/stream-probe.wasm"), APPID = createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
const DIST = path.join(H, "client/dist/pvm-client.mjs"), SIGN = path.join(H, "client/tools/lab-sign.mjs"), DIST_SHA = "251dd8fa7ec0a14f2c3fc11aef03a85b78fb29f992b1ea42e99d1bbc977d58e9";
const POLICY = { confirmations: 2, receiptTimeoutMs: 10000, confirmTimeoutMs: 30000, pollMs: 1000, maxReplacements: 3, maxAnchorAgeBlocks: 20 };
const LAB_REGISTER = { repo: "lab/pvm-relay-route", measurement: "0x" + CODE, cpuPricePerSec6: "834" };   // synthetic LAB values
const SCRATCH = path.join(process.env.HOME, "enclave-bench/pvm-relay-route", path.basename(OUT) + "-scratch");   // relay cwd and state, lab keys: outside the repository
fs.mkdirSync(path.join(OUT, "vm"), { recursive: true }); fs.mkdirSync(path.join(OUT, "client"), { recursive: true }); fs.mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
const RUN_ID = "rr" + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
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
const { createAttachCosigner, serveAttachCosigner } = await import(path.join(H, "runner/attach-cosigner.mjs"));
const V = await import("viem"), { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
let OPKEY = generatePrivateKey(), WRONGKEY = generatePrivateKey();
const operator = privateKeyToAccount(OPKEY), wrongOperator = privateKeyToAccount(WRONGKEY);
let chain = null, relay = null, relayN = 0, runner = null, csServe = null, wrongServe = null, policySrv = null, replaySrv = null;
const cleanup = () => { for (const x of [runner]) try { x && x.close(); } catch {} for (const s of [csServe, wrongServe, policySrv, replaySrv]) try { s && s.close(); } catch {}
  try { relay && relay.kill("SIGKILL"); } catch {} try { chain && chain.stop(); } catch {}
  for (const p of [RPORT, CSPORT, WRONGPORT]) try { execFileSync(ADB, ["reverse", "--remove", `tcp:${p}`], { stdio: "ignore" }); } catch {} };
const STATE = path.join(OUT, ".agent-state");
let D = null;
try {
  // ================= setup: chain, relay (scrubbed), co-signers, phone =================
  chain = await startLeaseChain({ port: CHAINPORT, operatorAccount: operator, addressBook: true, blockTime: BLOCK_S });
  const enclaveId = V.keccak256(V.stringToBytes(ENDPOINT));
  D = await chain.createFunded(); const pins = chain.pins(D, enclaveId);
  const relayEnv = (codeHashes) => ({ PATH: process.env.PATH,   // env -i + the allowlist below: nothing inherited from this shell
    API_RELAY_PORT: String(RPORT), API_RELAY_BIND: "127.0.0.1", BASE_RPC: chain.rpc, RPC_FALLBACKS: "0", ADDRESS_BOOK_ADDRESS: chain.addresses.addressBook,
    REGISTRY_POLL_SEC: "5", AVAIL_POLL_SEC: "5", TUNNEL_PUBLIC_ORIGIN: ORIGIN,
    AUTH_DATA_DIR: path.join(SCRATCH, "auth"), STATE_DIRECTORY: path.join(SCRATCH, "state"), FEATURED_VIEWS_FILE: path.join(SCRATCH, "featured-views.json"),
    PVM_SERVING: "1", METAL_AVF_CODE_HASHES: codeHashes, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_CODE_HASHES: codeHashes, PVM_CPU_MODELS: JSON.stringify(MODELS),
    PVM_APP_IDS: APPID, PVM_APP_RUNTIME_IDS: RID });
  const relayOut = { log: "" };
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
  };
  const stopRelay = async () => { if (relay) { relay.kill("SIGTERM"); await sleep(1500); try { relay.kill("SIGKILL"); } catch {} relay = null; } };
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify({ runId: RUN_ID, apk: path.basename(APK), code: CODE, oldCode: OLD_CODE, app: APPID, endpoint: ENDPOINT, pins, accounts: chain.accounts,
    addresses: chain.addresses, chain: `anvil (local: no network, no funds), a block every ${BLOCK_S} s`, googleRootPins: ROOTS, runtimeId: RID, authority: AUTH, ownerInstanceOutOfBand: OWNER_INSTANCE,
    wrongOperator: wrongOperator.address.toLowerCase(), policy: POLICY, labRegister: LAB_REGISTER, relay: { origin: ORIGIN, port: RPORT, scratch: "outside the repository" },
    operatorKey: "fresh random keys for this run (operator, wrong operator), held in memory only, never written" }, null, 1));
  // the owner's co-signer (and a WRONG operator's, with the same checks): every request, verdict and signature recorded
  const mkCosigner = (account, port, label) => {
    const c = createAttachCosigner({ account, name: NAME, relay: RELAY_HTTP, codeHashes: [CODE], authorityHashes: [AUTH], rootPins: ROOTS, instanceIds: [OWNER_INSTANCE],
                                     journalFile: path.join(OUT, label === "owner" ? "cosign-journal.jsonl" : "cosign-journal-wrong.jsonl") });
    const orig = c.sign;
    c.sign = async (req) => { const r = await orig(req); rec("attach.jsonl", { signer: label, step: curStep, utc: new Date().toISOString(), request: req, verdict: r }); return r; };
    return serveAttachCosigner(c, { port });
  };
  csServe = await mkCosigner(operator, CSPORT, "owner"); wrongServe = await mkCosigner(wrongOperator, WRONGPORT, "wrong-operator");
  const want = execFileSync("sha256sum", [APK], { encoding: "utf8" }).slice(0, 64), have = sh(`sha256sum $(pm path ${P} | sed s/package://)`).slice(0, 64);
  if (want !== have) { execFileSync(ADB, ["install", "-r", APK], { stdio: "ignore", timeout: 300000 }); log(`installed ${path.basename(APK)} over the previous build, data kept (${want})`); }
  else log(`installed APK is already ${path.basename(APK)} (${want})`);
  execFileSync(ADB, ["push", BUNDLE, "/data/local/tmp/app-stream-probe.wasm"], { stdio: "ignore" }); sh(`run-as ${P} cp /data/local/tmp/app-stream-probe.wasm files/app-stream-probe.wasm`);
  for (const p of [RPORT, CSPORT, WRONGPORT]) execFileSync(ADB, ["reverse", `tcp:${p}`, `tcp:${p}`], { stdio: "ignore" });
  const launch = async (phase, signerPort) => {
    const l = `${RUN_ID}-${phase}`;
    sh(`am force-stop ${P}; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard`); await sleep(2000);
    if (!/mWakefulness=Awake/.test(sh("dumpsys power"))) fail("PHONE NOT AWAKE");
    const pinLine = [pins.chainId, pins.proofOfTime, pins.registry, pins.deployment, pins.enclaveId, pins.operator].join(" ");
    sh(`am start -S -n ${P}/.Main --es mode app --es vmname anchorlocal --es model ${F}/model.gguf --es app ${F}/app-stream-probe.wasm --es app_graph gemma-4-e2b-it-q4_0 --ei app_tls 1 --ei app_serve_s ${SERVE_S} --es relay ws://127.0.0.1:${RPORT}/v1/fleet-tunnel --es name ${NAME} --es capture ${l} --es proof_pins '${pinLine}'` +
       (signerPort ? ` --es attach_signer http://127.0.0.1:${signerPort}/attach-sign` : ""));
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 400000) {   // until: attached AND serving, or the relay's verdict was a refusal, or the capture ended
      const c = sh(`run-as ${P} cat files/capture/${l}.log`);
      done = (/RELAY attest ACCEPTED/.test(c) && /APP evidence endpoint on vsock/.test(c)) || /RELAY attest REJECTED|RELAY closed without a verdict|RELAY dial failed/.test(c) || /^CAPTURE END/m.test(c);
      fs.writeFileSync(path.join(OUT, "vm", `${phase}.log`), c);
      if (!done) await sleep(5000);
    }
    if (!done) fail(`${phase}: no verdict and not serving within 400 s`);
    const c = fs.readFileSync(path.join(OUT, "vm", `${phase}.log`), "utf8");
    return { log: c, accepted: /RELAY attest ACCEPTED/.test(c), rejected: (/RELAY attest REJECTED: (.*)/.exec(c) || [])[1] || null, instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1],
             proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1], cosigned: /RELAY attach co-signed by the owner/.test(c), notCosigned: (/RELAY attach NOT co-signed: (.*)/.exec(c) || [])[1] || null,
             ms: Date.now() - t0 };
  };
  const row = async () => { const j = await fetch(`${RELAY_HTTP}/enclaves`).then((r) => r.json()).catch(() => null); const rows = Array.isArray(j) ? j : (j && (j.enclaves || j.rows)) || [];
    return rows.find((e) => e.endpoint === `tunnel://${NAME}`) || null; };
  const routeUp = async (ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fetch(`${RELAY_HTTP}/x/${D}/pvm/evidence`, { method: "POST", body: `EVIDENCE ${randomBytes(32).toString("hex")}\n` }).catch(() => null);
    if (r && r.status === 200) { await r.text(); return true; } if (r) await r.text().catch(() => {}); await sleep(3000); } return false; };
  // the agents' carrier, recorded (request and answer, for offline re-verification)
  const recordingFetch = async (url, init) => { const t0 = new Date().toISOString(), body = String(init && init.body || "").trim();
    const r = await fetch(url, init); const text = await r.text(); rec("exchanges.jsonl", { step: curStep, url: url.replace(RELAY_HTTP, ""), utcStart: t0, utcEnd: new Date().toISOString(), request: body, status: r.status, answer: text });
    return new Response(text, { status: r.status, headers: r.headers }); };
  const hooks = { swallow: false };
  const client = new Proxy(chain.publicClient, { get(t, k) {
    if (k === "sendRawTransaction") return async (a) => { const h = V.keccak256(a.serializedTransaction); if (hooks.swallow) { rec("chain.jsonl", { label: "swallowed-send", step: curStep, hash: h }); return h; } return t.sendRawTransaction(a); };
    return t[k]; } });
  const cfg = (carrier, over = {}) => ({ format: RUNNER_CONFIG_FORMAT, lifecycle: { register: LAB_REGISTER, claim: true },
    proof: { format: AGENT_CONFIG_FORMAT, chainId: String(chain.chainId), addressBook: chain.addresses.addressBook.toLowerCase(), deployment: D, endpoint: ENDPOINT,
      operator: operator.address.toLowerCase(), carrier, maxFeePerGasWei: "100000000000",
      evidence: { appId: APPID, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS, instanceIds: [OWNER_INSTANCE] }, policy: { ...POLICY, ...over } } });
  const BOOT = `${RELAY_HTTP}/t/${NAME}/pvm/evidence`, XROUTE = `${RELAY_HTTP}/x/${D}/pvm/evidence`;
  const newRunner = (carrier, over) => createRunnerAgent({ config: cfg(carrier, over), publicClient: client, account: operator, stateDir: STATE, fetchImpl: recordingFetch,
    log: (o) => { if (["done", "stuck", "recover", "attest", "refused", "broadcast-failed"].includes(o.ev)) log(`  agent ${o.ev}${o.op ? " " + o.op : ""}${o.kind ? " " + o.kind : ""}${o.reason ? ": " + String(o.reason).slice(0, 140) : ""}`); } });
  // the built client, isolated state and lab keys outside the repository; policies served locally
  if (execFileSync("sha256sum", [DIST], { encoding: "utf8" }).slice(0, 64) !== DIST_SHA) fail("client/dist/pvm-client.mjs is not the pinned 0.5.0 dist");
  const KEYS = path.join(SCRATCH, "lab-keys"); fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const CLI = path.join(SCRATCH, "pvm-client.mjs"); fs.copyFileSync(DIST, CLI);
  const node = (args, label) => new Promise((resolve) => { const c = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("exit", (code) => { if (label) fs.writeFileSync(path.join(OUT, "client", `${label}.jsonl`), o); resolve({ code, out: o, err: e }); }); });
  const pkey = JSON.parse((await node([SIGN, "keygen", "--keys", KEYS, "--name", "policy"])).out), rkey = JSON.parse((await node([SIGN, "keygen", "--keys", KEYS, "--name", "release"])).out);
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
  const turn = async (label, relayBase = RELAY_HTTP) => { await sleep(3000);
    const r = await node([CLI, "run", "--state", CSTATE, "--policy", `http://127.0.0.1:${policySrv.port}/`, "--relay-base", relayBase, "--deployment", D, "--path", "/?graph=gemma-4-e2b-it-q4_0&steps=8"], label);
    const lines = r.out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)); return (lines.reverse().find((x) => x.result) || {}).result || { refused: r.err.slice(-300) }; };

  // ================= A =================
  curStep = "A-relay"; await startRelay(CODE, "the lab build");
  curStep = "A-attach"; const a = await launch("a", null);
  step("A-attach", a.accepted && a.instance === OWNER_INSTANCE, { accepted: a.accepted, rejected: a.rejected, instance: a.instance, outOfBand: OWNER_INSTANCE, proofKey: a.proofKey, bootMs: a.ms });
  let r0 = null; for (let i = 0; i < 20 && !(r0 && r0.tier); i++) { await sleep(3000); r0 = await row(); }
  step("A-row", r0 && r0.mode === "avf" && r0.tier === "pvm-cpu" && r0.eligible === false && /inference lane/.test(r0.ineligible || "") && r0.serving === false && r0.publicUrl === ENDPOINT,
       { mode: r0 && r0.mode, tier: r0 && r0.tier, eligible: r0 && r0.eligible, ineligible: r0 && r0.ineligible, serving: r0 && r0.serving, publicUrl: r0 && r0.publicUrl, lane: r0 && r0.lane });
  curStep = "A-bootstrap"; runner = await newRunner(BOOT);
  const st = await runner.start();
  step("A-bootstrap-attest", st.attested && st.attested.proofKey === a.proofKey && st.attested.instanceId === OWNER_INSTANCE, { via: "/t/<name>/pvm/evidence", proofKey: st.attested && st.attested.proofKey, reason: st.attestReason });
  curStep = "A-register"; const t1 = await runner.tick();
  step("A-register", t1.lifecycle && t1.lifecycle.kind === "landed" && /^register/.test(t1.lifecycle.op) && (await chain.registeredProofKey(enclaveId)) === a.proofKey, { lifecycle: t1.lifecycle });
  await sleep(4000);
  curStep = "A-claim"; const t2 = await runner.tick();
  step("A-claim", t2.lifecycle && t2.lifecycle.kind === "landed" && t2.lifecycle.op === "claim", { lifecycle: t2.lifecycle });
  runner.close(); runner = null;
  curStep = "A-route"; step("A-route", await routeUp(), { route: `/x/${D}/pvm/evidence` });
  runner = await newRunner(XROUTE); await runner.start();
  await sleep(62000); await chain.advance(30);
  curStep = "A-prove"; const t3 = await runner.tick();
  step("A-prove", t3.proof && t3.proof.kind === "landed", { via: "/x", proof: t3.proof && { kind: t3.proof.kind, provenUntil: t3.proof.provenUntil } });
  // the built client, through the relay route
  await signPolicy([{ id: D, app: APPID, instances: [OWNER_INSTANCE] }]);
  curStep = "A-client"; const c1 = await turn("a-bound");
  step("A-client", c1.complete === true && c1.deployment && c1.deployment.instance === OWNER_INSTANCE && /\/v3$/.test((c1.verified || {}).format || ""), { step: c1.step, complete: c1.complete, instance: c1.deployment && c1.deployment.instance, refused: c1.refused });
  await signPolicy([{ id: D, app: APPID, instances: [createHash("sha256").update("not the owner's instance").digest("hex")] }]);
  curStep = "A-client-wrong-instance"; const c2 = await turn("a-wrong-instance");
  step("A-client-wrong-instance", !c2.complete && /instance/i.test(c2.refused || "") && !c2.sent, { step: c2.step, refused: c2.refused, sent: c2.sent });
  await signPolicy([{ id: D, app: APPID, instances: [OWNER_INSTANCE] }], [OLD_CODE]);
  curStep = "A-client-wrong-build"; const c3 = await turn("a-wrong-build");
  step("A-client-wrong-build", !c3.complete && /code/i.test(c3.refused || "") && !c3.sent, { step: c3.step, refused: c3.refused, sent: c3.sent });
  // a stale answer: a proxy in front of the REAL relay replays the previous evidence answer to a fresh nonce
  await signPolicy([{ id: D, app: APPID, instances: [OWNER_INSTANCE] }]);
  let lastEvidence = null;
  replaySrv = await new Promise((r) => { const s = http.createServer((q, res) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", async () => {
    const up = await fetch(`${RELAY_HTTP}${q.url}`, { method: q.method, body: q.method === "POST" ? b : undefined }); let ans = Buffer.from(await up.arrayBuffer());
    if (/\/pvm\/evidence$/.test(q.url)) { if (lastEvidence) ans = lastEvidence; else lastEvidence = ans; }
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/octet-stream" }); res.end(ans); }); }); s.listen(0, "127.0.0.1", () => r({ port: s.address().port, close: () => s.close() })); });
  curStep = "A-client-stale"; await turn("a-stale-prime", `http://127.0.0.1:${replaySrv.port}`); const c4 = await turn("a-stale", `http://127.0.0.1:${replaySrv.port}`);
  step("A-client-stale", !c4.complete && /nonce/i.test(c4.refused || "") && !c4.sent, { step: c4.step, refused: c4.refused, sent: c4.sent });
  replaySrv.close(); replaySrv = null;
  // exactly once: a checkpoint journaled, never delivered, the agent stops; the next agent delivers the SAME bytes once
  runner.close(); runner = null; await sleep(62000); await chain.advance(30); hooks.swallow = true;
  runner = await newRunner(XROUTE, { maxReplacements: 0, receiptTimeoutMs: 5000 }); await runner.start();
  curStep = "A-crash"; const t4 = await runner.tick();
  step("A-crash", t4.kind === "in-flight" || (t4.proof && t4.proof.kind === "stuck"), { kind: t4.kind, proof: t4.proof && t4.proof.kind });
  runner.close(); runner = null; hooks.swallow = false;
  runner = await newRunner(XROUTE); curStep = "A-recover"; const re = await runner.start();
  step("A-recover", re.recovered && re.recovered.kind === "landed", { recovered: re.recovered && { kind: re.recovered.kind, hash: re.recovered.hash } });

  // ================= B: disconnect, reconnect =================
  curStep = "B-disconnect"; await stopRelay(); await sleep(62000); await chain.advance(30);
  const t5 = await runner.tick();
  step("B-disconnect", t5.proof && ["carrier-failed", "attest-failed"].includes(t5.proof.kind) || ["carrier-failed", "attest-failed"].includes(t5.kind), { kind: t5.kind, proof: t5.proof && t5.proof.kind, reason: t5.proof && t5.proof.reason });
  await startRelay(CODE, "back after a stop");
  await sleep(12000);
  step("B-gone", !(await row()) && !(await routeUp(8000)), { note: "no in-place re-attach (gap B): the tunnel is gone until the VM restarts" });
  curStep = "B1-no-cosigner"; const b1 = await launch("b1", null);
  step("B1-no-cosigner", !b1.accepted && /registered on chain; attach must carry operatorSig/.test(b1.rejected || ""), { rejected: b1.rejected });
  curStep = "B2-wrong-operator"; const b2 = await launch("b2", WRONGPORT);
  step("B2-wrong-operator", !b2.accepted && /registered on chain to /.test(b2.rejected || ""), { rejected: b2.rejected, cosigned: b2.cosigned, notCosigned: b2.notCosigned });
  curStep = "B3-owner-cosigner"; const b3 = await launch("b3", CSPORT);
  step("B3-owner-cosigner", b3.accepted && b3.cosigned && b3.instance === OWNER_INSTANCE && b3.proofKey === a.proofKey, { accepted: b3.accepted, cosigned: b3.cosigned, instance: b3.instance, proofKey: b3.proofKey });
  step("B-route", await routeUp(), { route: "back" });
  curStep = "B-client"; const c5 = await turn("b-bound");
  step("B-client", c5.complete === true && c5.deployment && c5.deployment.instance === OWNER_INSTANCE, { step: c5.step, complete: c5.complete, refused: c5.refused });
  await sleep(62000); await chain.advance(30);
  curStep = "B-prove"; const t6 = await runner.tick();
  step("B-prove", t6.proof && t6.proof.kind === "landed", { proof: t6.proof && t6.proof.kind });

  // ================= C: the relay admits only ANOTHER build =================
  curStep = "C-wrong-build-relay"; await stopRelay(); await startRelay(OLD_CODE, "admits only the OLD build");
  const c = await launch("c", CSPORT);
  step("C-wrong-build-relay", !c.accepted && /codeHash|code hash|allowlisted/i.test(c.rejected || ""), { rejected: c.rejected, cosigned: c.cosigned });
  await stopRelay(); await startRelay(CODE, "the lab build again");
  curStep = "C-right-relay"; const d = await launch("d", CSPORT);
  step("C-right-relay", d.accepted && d.cosigned, { accepted: d.accepted, cosigned: d.cosigned });
  step("C-route", await routeUp(), { route: "back" });

  // ================= D: the final proof, then release =================
  await sleep(62000); await chain.advance(60);
  curStep = "D-release"; const rl = await runner.stop({ release: true });
  step("D-release", rl.kind === "released" && rl.proof && rl.proof.kind === "landed", { kind: rl.kind, proof: rl.proof && rl.proof.kind });
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
