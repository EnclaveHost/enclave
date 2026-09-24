// Black-box persistence tests against the BUILT installed pVM client (the CLI bundle resolved from the pin pvm-client-dist,
// ENCLAVE_PVM_CLIENT_CLI), written from the client's design text and the audit finding, not from its code. The rule they
// assert: a policy the client ACCEPTS (a newer serial) must be committed durably and monotonically BEFORE the client acts on
// it (before any evidence request, and so before any private request); a commit that cannot be made durable means nothing
// is sent; concurrent clients sharing one state never lose a newer serial to an older completion; the same serial with other
// bytes is refused; a corrupt state is fatal. Against client 0.1.0 (4e55879b) these FAIL by design: that is the reproduction.
//
// Determinism: a fake carrier serves policies this test signs under its own lab key (generated here; the client is installed
// with that key's fingerprint as its anchor), and a fake relay whose /evidence endpoint HOLDS each client's request until the
// test releases it (or kills the client). The arrival of a client's evidence request is the barrier "the client acted on the
// policy". No evidence can verify offline, so releasing answers 503 and the client refuses at the evidence step; what the
// tests observe is what was persisted, and whether any request was made, at each barrier.
//   run: ENCLAVE_PVM_CLIENT_CLI=<built pvm-client.mjs> node --test test/verifier-pvm-client-persistence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const CLI = process.env.ENCLAVE_PVM_CLIENT_CLI || "";
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !(CLI && fs.existsSync(CLI))) throw new Error("strict integration: ENCLAVE_PVM_CLIENT_CLI (the built client, pinned as pvm-client-dist) is missing");
const skip = !(CLI && fs.existsSync(CLI)) && !STRICT && "built client absent (set ENCLAVE_PVM_CLIENT_CLI via verifier/integration/resolve.mjs --pin pvm-client-dist)";

// ---- the test's own lab keys and policy signing (DESIGN.md: Ed25519 over "enclave-pvm-client-policy-v1\n" || exact bytes) ----
const rawPub = (pub) => pub.export({ type: "spki", format: "der" }).subarray(-32);
const policyKey = generateKeyPairSync("ed25519"), otherKey = generateKeyPairSync("ed25519"), releaseKey = generateKeyPairSync("ed25519");
const fpOf = (k) => createHash("sha256").update(rawPub(k.publicKey)).digest("hex");
const APP = "29e8942369846359b5936dbef1268c28f7097cccb3101b86345dc4dd8f4c1373", RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba";
const ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
function signedPolicy(serial, { key = policyKey, appIds = [APP], codeHash = "43".repeat(32), minClientVersion = "0.1.0", nextPolicyKey = null, tag = "" } = {}) {
  const now = Date.now();
  const body = { type: "enclave-pvm-client-policy", key: rawPub(key.publicKey).toString("hex"), serial, notBefore: new Date(now - 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"), notAfter: new Date(now + 6 * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"),
    codeHashes: [codeHash], authorityHashes: ["cd".repeat(64)], runtimeIds: [RID], appIds, googleRootPins: ROOTS, formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion, nextPolicyKey };
  if (tag) body.codeHashes = [createHash("sha256").update(tag).digest("hex")];   // the same serial with other bytes
  const bytes = Buffer.from(JSON.stringify(body));
  const sig = edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), bytes]), key.privateKey).toString("hex");
  return { policy: bytes.toString("base64"), sig, digest: createHash("sha256").update(bytes).digest("hex") };
}

// ---- the fake carrier (policies) and relay (evidence held per client label until released) ----
const held = new Map();      // label -> { res, arrivedAt }
const arrivals = [];         // labels in arrival order
const waiters = new Map();   // label -> resolve
const policies = new Map();  // name -> envelope
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/policy/")) { const p = policies.get(u.pathname.slice(8)); if (!p) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ policy: p.policy, sig: p.sig })); }
  const m = /^\/r\/([^/]+)\/(evidence|sealed)$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  const [, label, ep] = m;
  if (ep === "sealed") { arrivals.push(`${label}:sealed`); res.writeHead(503); return res.end(); }   // a private request reached the relay: recorded, never answered
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { arrivals.push(label); held.set(label, { res, body }); const w = waiters.get(label); if (w) { waiters.delete(label); w(); } });
});
let base = "";
test.before(async () => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { for (const h of held.values()) { try { h.res.writeHead(503); h.res.end(); } catch {} } server.close(); });
const evidenceRequested = (label) => held.has(label) ? Promise.resolve() : new Promise((r) => waiters.set(label, r));
const release = (label) => { const h = held.get(label); if (h) { h.res.writeHead(503); h.res.end(); held.delete(label); } };
const requestedEver = (label) => arrivals.includes(label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the client under test ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-client-persist-"));
test.after(() => { try { fs.chmodSync(tmp, 0o755); for (const d of fs.readdirSync(tmp)) { try { fs.chmodSync(path.join(tmp, d), 0o755); } catch {} } } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const cliEnv = () => { const e = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, "xdg-unused") }; delete e.NODE_TEST_CONTEXT; return e; };
function install(stateFile, { serialFloor = 1 } = {}) {
  const r = spawnSync(process.execPath, [CLI, "install", "--policy-key-fp", fpOf(policyKey), "--serial-floor", String(serialFloor), "--release-key-fp", fpOf(releaseKey), "--state", stateFile], { encoding: "utf8", env: cliEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r;
}
// a client run: { child, done (exit), settled (exit OR its evidence request arrived: the client acted on the policy) }
const children = new Set();
test.after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });
function run(stateFile, policyName, label, extra = []) {
  const child = spawn(process.execPath, [CLI, "run", "--policy", `${base}/policy/${policyName}`, "--relay", `${base}/r/${label}`, "--app", APP, "--state", stateFile, "--label", label, ...extra], { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
  const parse = () => { try { return JSON.parse(out.trim().split("\n").filter((l) => l.includes('"result"')).pop() || "{}").result; } catch { return null; } };
  const done = new Promise((resolve) => child.on("exit", (status, signal) => { children.delete(child); resolve({ exited: true, status, signal, out, err, result: parse() }); }));
  const settled = Promise.race([done, evidenceRequested(label).then(() => ({ exited: false, requested: true, status: null, out, err, result: null }))]);
  return { child, done, settled };
}
// the committed state, read the way the client defines it (0.2.0: `pvm-client state --state DIR` prints { state, gen, dir });
// a 0.1.0 client has no such command, so its state.json is read directly (the fallback exists only for the reproduction)
function committed(stateLoc) {
  const r = spawnSync(process.execPath, [CLI, "state", "--state", stateLoc], { encoding: "utf8", env: cliEnv() });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  try { const j = JSON.parse(line); if (j.state && Number.isInteger(j.state.serial)) return { ...j.state, gen: j.gen, dir: j.dir }; if (j.error) return { error: j.error }; } catch {}
  try { const d = JSON.parse(fs.readFileSync(stateLoc, "utf8")); if (Number.isInteger(d.serial)) return d; } catch {}
  return null;
}
// where a client keeps its state: 0.2.0 takes a DIRECTORY; the name below is a directory that does not exist before install
const stateLoc = (name) => path.join(tmp, name, "state.d");
// the client's own version (0.2.0 introduced the generation log, the state command and the 0.1.0 import): cases that
// exercise those semantics must not pass vacuously on such a client
const clientVersion = (() => { if (!CLI || !fs.existsSync(CLI)) return null; const r = spawnSync(process.execPath, [CLI, "version"], { encoding: "utf8", env: cliEnv() }); try { return JSON.parse(r.stdout.trim().split("\n").pop()).version; } catch { return null; } })();
const hasLog = clientVersion ? clientVersion.split(".").map(Number) >= [0, 2, 0] && !(clientVersion.split(".").map(Number)[0] === 0 && clientVersion.split(".").map(Number)[1] < 2) : false;

test("1. stall after acceptance, then kill: the accepted serial is committed BEFORE the client acts, and a later rollback is refused", { skip }, async () => {
  const state = stateLoc("s1"); install(state);
  assert.equal(committed(state).serial, 1, "the install floor");
  policies.set("p2", signedPolicy(2)); policies.set("p1", signedPolicy(1));
  const a = run(state, "p2", "s1-a");
  await evidenceRequested("s1-a");   // barrier: the client accepted policy 2 and is acting on it (its evidence request arrived)
  const atBarrier = committed(state);
  assert.equal(atBarrier?.serial, 2, `serial 2 must be committed before the client acts on the policy (committed: ${JSON.stringify(atBarrier)})`);
  a.child.kill("SIGKILL"); await a.done;   // the hostile carrier never answered; the client died
  assert.equal(committed(state)?.serial, 2, "the commit survives the kill");
  const b = run(state, "p1", "s1-b"); const rb = await b.settled;
  assert.equal(rb.exited, true, "the older policy must be refused without acting on it (its evidence request arrived instead)");
  assert.equal(rb.result?.step, "policy", `the older policy must be refused as a rollback, not acted on (got ${JSON.stringify(rb.result)})`);
  assert.match(rb.result?.refused || "", /rollback/); assert.equal(requestedEver("s1-b"), false, "no evidence request under a rolled-back policy");
});
test("2. concurrent old and new serials, new commits first: the old one is refused, never acted on, and the state stays new", { skip }, async () => {
  const state = stateLoc("s2"); install(state);
  policies.set("p5", signedPolicy(5)); policies.set("p6", signedPolicy(6));
  const nu = run(state, "p6", "s2-new"); await evidenceRequested("s2-new");
  assert.equal(committed(state)?.serial, 6, "the newer serial committed before acting");
  const old = run(state, "p5", "s2-old"); const ro = await old.settled;   // must be refused against the committed 6
  assert.equal(ro.exited, true, "the old policy must be refused without acting on it (its evidence request arrived instead)");
  assert.equal(ro.result?.step, "policy", `the old policy must be refused (got ${JSON.stringify(ro.result)})`); assert.match(ro.result?.refused || "", /rollback/);
  assert.equal(requestedEver("s2-old"), false, "the old policy's client made no request");
  release("s2-new"); await nu.done;
  assert.equal(committed(state)?.serial, 6);
});
test("3. concurrent old and new serials, old starts first and finishes last: the newer serial is never overwritten by the older completion", { skip }, async () => {
  const state = stateLoc("s3"); install(state);
  policies.set("q5", signedPolicy(5)); policies.set("q6", signedPolicy(6));
  const old = run(state, "q5", "s3-old"); await evidenceRequested("s3-old");
  const nu = run(state, "q6", "s3-new"); await evidenceRequested("s3-new");
  assert.equal(committed(state)?.serial, 6, "both accepted in order; the state is the newer");
  release("s3-new"); await nu.done;
  release("s3-old"); await old.done;   // the older run completes last
  assert.equal(committed(state)?.serial, 6, `the older completion must not overwrite the newer serial (committed: ${JSON.stringify(committed(state))})`);
});
test("3b. lost update: two clients hold old and new serials; the NEWER completes first, the OLDER last; the state must still be the newer", { skip }, async () => {
  const state = stateLoc("s3b"); install(state);
  policies.set("z5", signedPolicy(5)); policies.set("z6", signedPolicy(6));
  const old = run(state, "z5", "s3b-old"), nu = run(state, "z6", "s3b-new");
  // whichever of the two acts (on a fixed client the second is refused as a rollback if the newer committed first; on a client
  // that commits after the exchange both act): wait until neither can progress further, then finish the newer, then the older
  const [ro, rn] = await Promise.all([old.settled, nu.settled]);
  if (!rn.exited) { release("s3b-new"); await nu.done; }
  const afterNew = committed(state)?.serial;
  if (!ro.exited) { release("s3b-old"); await old.done; }
  const final = committed(state)?.serial;
  assert.equal(afterNew, 6, `after the newer client finished the state must be 6 (got ${afterNew})`);
  assert.equal(final, 6, `the older client's completion must not overwrite the newer serial (final ${final})`);
});
test("4. the same serial with other bytes, concurrently: the second is refused as equivocation and makes no request", { skip }, async () => {
  const state = stateLoc("s4"); install(state);
  policies.set("x6", signedPolicy(6)); policies.set("y6", signedPolicy(6, { tag: "other bytes" }));
  assert.notEqual(policies.get("x6").digest, policies.get("y6").digest);
  const a = run(state, "x6", "s4-a"); await evidenceRequested("s4-a");
  const b = run(state, "y6", "s4-b"); const rb = await b.settled;
  assert.equal(rb.exited, true, "equivocation must be refused without acting on it (its evidence request arrived instead)");
  assert.equal(rb.result?.step, "policy", `equivocation must be refused (got ${JSON.stringify(rb.result)})`); assert.match(rb.result?.refused || "", /equivocation/);
  assert.equal(requestedEver("s4-b"), false);
  release("s4-a"); await a.done;
  assert.equal(committed(state)?.digest, policies.get("x6").digest, "the first policy's bytes are the committed ones");
  // the same policy again is idempotent, not equivocation
  const c = run(state, "x6", "s4-c"); const rc0 = await c.settled; assert.equal(rc0.exited, false, "the same policy again is accepted (idempotent), so the client acts on it"); release("s4-c"); const rc = await c.done; assert.notEqual(rc.result?.step, "policy", rc.out);
});
test("5. failed persistence: when the commit cannot be made durable, nothing is sent (no evidence request, no private request)", { skip }, async () => {
  const state = stateLoc("s5"); install(state);
  policies.set("r2", signedPolicy(2));
  const dirs = [state, path.dirname(state)].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  for (const d of dirs) fs.chmodSync(d, 0o555);                  // the store (and its parent) cannot be written
  try {
    const a = run(state, "r2", "s5-a"); const ra = await a.settled;
    assert.equal(ra.exited, true, "the client must refuse before acting when its store is not writable (its evidence request arrived instead)");
    assert.equal(requestedEver("s5-a"), false, `no request may leave the client when its commit failed (result: ${JSON.stringify(ra.result)})`);
    assert.equal(requestedEver("s5-a:sealed"), false);
    assert.notEqual(ra.status, 0, "a failed commit is a refusal, not success");
    assert.equal(committed(state)?.serial, 1, "the floor is unchanged");
  } finally { for (const d of dirs) fs.chmodSync(d, 0o755); }
});
test("6. a corrupt state is fatal: no fallback, no request", { skip }, async () => {
  const state = stateLoc("s6"); install(state);
  policies.set("t2", signedPolicy(2));
  const c = committed(state);   // the newest generation, located through the client's own report of gen and dir (fault injection touches the layout; reading never does)
  const target = c && c.dir ? path.join(c.dir, `${c.gen}.json`) : state;
  fs.writeFileSync(target, "{ this is not the state");
  const a = run(state, "t2", "s6-a"); const ra = await a.settled;
  assert.equal(ra.exited, true, "a corrupt state is fatal before acting"); assert.notEqual(ra.status, 0); assert.equal(requestedEver("s6-a"), false, "a client with a corrupt state makes no request");
});
test("7. an attacker's policy and a stalled carrier leave no trace in the state, and a later genuine policy is accepted", { skip }, async () => {
  const state = stateLoc("s7"); install(state);
  policies.set("evil3", signedPolicy(3, { key: otherKey })); policies.set("g2", signedPolicy(2));
  const e = run(state, "evil3", "s7-e"); const re = await e.settled;
  assert.equal(re.exited, true); assert.equal(re.result?.step, "policy"); assert.match(re.result?.refused || "", /anchor does not name/); assert.equal(requestedEver("s7-e"), false);
  assert.equal(committed(state)?.serial, 1);
  const g = run(state, "g2", "s7-g"); const rg = await g.settled; assert.equal(rg.exited, false, "a genuine newer policy is accepted and acted on"); assert.equal(committed(state)?.serial, 2, "committed before acting"); release("s7-g"); await g.done;
});

test("8. three concurrent writers (serials 5, 6, 7) started in that order: the state ends at 7 and every client either committed monotonically or was refused before acting", { skip }, async () => {
  const state = stateLoc("s8"); install(state);
  for (const n of [5, 6, 7]) policies.set(`w${n}`, signedPolicy(n));
  const runs = [5, 6, 7].map((n) => run(state, `w${n}`, `s8-${n}`));
  const settled = await Promise.all(runs.map((r) => r.settled));
  for (const n of [5, 6, 7]) release(`s8-${n}`);
  const results = await Promise.all(runs.map((r) => r.done));
  assert.equal(committed(state)?.serial, 7, `the highest serial is the state (${JSON.stringify(committed(state))})`);
  results.forEach((r, i) => { const acted = settled[i].exited === false; if (!acted) { assert.equal(r.result?.step, "policy", `s8-${[5, 6, 7][i]}: a client that did not act was refused at policy`); assert.match(r.result?.refused || "", /rollback|superseded|equivocation/); } });
  assert.ok(settled[2].exited === false, "the highest serial's client acted");
  if (hasLog) assert.equal(results.filter((r) => /"committed"/.test(r.out)).length >= 1, true, "at least one commit line was printed before acting");
});
test("9. a hostile local process plants a truncated newest generation: fatal, no fallback to the older one, no request", { skip }, async () => {
  const state = stateLoc("s9"); install(state);
  policies.set("v2", signedPolicy(2)); policies.set("v3", signedPolicy(3));
  const a = run(state, "v2", "s9-a"); await a.settled; release("s9-a"); await a.done;
  const c = committed(state); assert.equal(c?.serial, 2);
  if (hasLog) assert.ok(typeof c.dir === "string" && Number.isInteger(c.gen), `a ${clientVersion} client reports its generation log (${JSON.stringify(c)})`);
  if (!c?.dir) return;   // a client without a generation log (0.1.0) has no newest generation to plant
  fs.writeFileSync(path.join(c.dir, `${c.gen + 1}.json`), '{"gen":' + (c.gen + 1) + ',"state":{"policyFp":"');   // truncated
  const b = run(state, "v3", "s9-b"); const rb = await b.settled;
  assert.equal(rb.exited, true, "a truncated newest generation must be fatal before acting"); assert.notEqual(rb.status, 0); assert.equal(requestedEver("s9-b"), false);
  assert.ok(committed(state)?.error, "the state command reports the fatal store, not the older generation");
});
test("10. a 0.1.0 state file is imported once; the stale file cannot roll the log back afterwards", { skip }, async () => {
  const dir = path.join(tmp, "s10"); fs.mkdirSync(dir, { recursive: true }); const legacy = path.join(dir, "state.json");
  fs.writeFileSync(legacy, JSON.stringify({ policyFp: fpOf(policyKey), nextPolicyFp: null, serial: 4, digest: null, releaseFp: fpOf(releaseKey), nextReleaseFp: null }) + "\n");
  policies.set("u5", signedPolicy(5)); policies.set("u3", signedPolicy(3));
  const a = run(legacy, "u5", "s10-a"); const ra = await a.settled;
  if (hasLog) assert.match(ra.out, /"imported"/, `a ${clientVersion} client imports the 0.1.0 file once and says so (${ra.out.slice(0, 200)})`);
  if (ra.exited && /already installed|no client installed/.test(ra.out)) return;   // not an importing client
  assert.equal(ra.exited, false, `the imported floor 4 admits serial 5 (${ra.out})`); assert.equal(committed(legacy)?.serial, 5, "committed before acting, into the log"); release("s10-a"); await a.done;
  fs.writeFileSync(legacy, JSON.stringify({ policyFp: fpOf(policyKey), nextPolicyFp: null, serial: 1, digest: null, releaseFp: fpOf(releaseKey), nextReleaseFp: null }) + "\n");   // the legacy file rewritten by a hostile local process
  const b = run(legacy, "u3", "s10-b"); const rb = await b.settled;
  assert.equal(rb.exited, true, "serial 3 is below the log's 5: refused, the stale legacy file is not consulted again"); assert.match(rb.result?.refused || "", /rollback/); assert.equal(committed(legacy)?.serial, 5);
});
