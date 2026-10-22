// Fixtures only: no real key, no real signature (the fake account returns a canary string), no CA, no network beyond
// one loopback fake relay. The REAL createHvCertPass/issuer/requestCert (canonical hvcert.mjs = live 91b9f2db) run with an
// _ensure stand-in for the partition round trip.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, narrowSigner, verifyPins, parseArgs, MODULE_PINS } from "../sia-cert-oneoff.mjs";
import { createHash } from "node:crypto";
// the LIVE production hvcert.mjs (91b9f2db, captured from minipc), not canonical work/enclave (now the 3a87d9b8 fix):
// a byte-identical copy whose relative imports resolve through symlinks to the (live-identical) supporting modules
const LIVE_HV = new URL("../../fix/basetree/windows/node/hvcert.mjs", import.meta.url);
assert.equal(createHash("sha256").update(fs.readFileSync(LIVE_HV)).digest("hex"), "91b9f2db7eb3be98efec1594dfe95245475a0cf234d9ce6843657b37bc2b1557");
const realHv = await import(LIVE_HV.href);

const DEPID = "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238";
const INST = "hv3f742170c660948e2bf61cc04370db94", APPID = "ea9d47738f079748b7e3fd29e18c496e2b9e88cd861473671cd9535888654ac3";
const OWNER = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", EP = "https://api.enclave.host/t/nucbox-k11-4";
const RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", PIN = "c".repeat(64), SPKI = "d".repeat(64);
const NAME = "ef514ed3.app.enclave.host";
const SIG = "0xSIGNATURE_CANARY_NEVER_PRINTED", KEYC = "OPERATOR_KEY_CANARY", CSRC = "CSR_CANARY_NEVER_PRINTED", ENVC = "ENV_VALUE_CANARY";
const ARGS = ["--deployment", DEPID, "--instance", INST, "--app-id", APPID, "--version", "0.1.8", "--cid", "bafybeib7at4", "--owner", OWNER,
  "--expect-endpoint", EP, "--expect-runner", RUNNER, "--expect-runtime", PIN, "--timeout-sec", "10"];
const rec = (over = {}, iso = {}) => ({ id: DEPID, status: "running", isPublic: true, owner: OWNER, version: "0.1.8", cid: "bafybeib7at4", gpuShare: 0,
  partitionGpuShare: 0, ...over, isolation: { instance: INST, appId: APPID, tier: "T0-hv", transportKeySha256: SPKI, ...iso } });

// the fake relay: checks the request the way relay/certs.js parses it, answers per test
let relayReply = null, relaySeen = [];
const relay = http.createServer((q, s) => { let b = ""; q.on("data", (c) => b += c); q.on("end", () => { const j = JSON.parse(b); relaySeen.push(j);
  const [code, body] = relayReply(j); s.writeHead(code, { "content-type": "application/json" }); s.end(JSON.stringify(body)); }); });
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;
after(() => relay.close());

function deps({ ensure, state = { deployments: [rec()] }, env = {}, idOver = {}, spy = {} } = {}) {
  spy.loadOperator = 0; spy.create = 0; spy.signed = []; spy.getState = 0;
  const account = { address: "0x1a01194c34fe3577c6d0a54feb78af6253e494e0", signMessage: async ({ message }) => { spy.signed.push(message); return SIG; }, _k: KEYC };
  return {
    env: { ENCLAVE_ISOLATION_MANAGER: "http://127.0.0.1:1/" + ENVC, ENCLAVE_ISOLATION_DATA_ADDR: "127.0.0.1:2", ENCLAVE_ISOLATION_RUNTIME_ID: PIN, NODE_DIR: "C:/x/" + ENVC, ...env },
    verify: () => {}, getState: async () => { spy.getState++; return state; },
    load: async () => ({
      resolveIdentity: () => ({ mode: "independent", publicUrl: EP, relayBase: RELAY, ...idOver }),
      enclaveIdOf: (e) => (e === EP ? RUNNER : "0x" + "0".repeat(64)),
      loadOperator: () => { spy.loadOperator++; return account; },
      IsolationManagerClient: class { constructor() {} async get() { return null; } },
      createHvCertPass: (opts) => { spy.create++; spy.opts = opts; return realHv.createHvCertPass({ ...opts, _ensure: ensure || (async ({ issue, name }) => {
        const chain = await issue(name, CSRC, SPKI);   // the real issuer -> real requestCert -> our signer -> the fake relay
        return { key: SPKI, serial: "0A", notAfter: Date.now() + 90 * 864e5, renewAt: Date.now() + 60 * 864e5, issuer: "CN=Test CA", verdict: "monitor-signed", chain };
      }) }); },
    }),
  };
}
const out = (r) => JSON.stringify(r.report);
const clean = (r) => { for (const c of [SIG, KEYC, CSRC, ENVC]) assert.ok(!out(r).includes(c), `report leaks ${c}`); };

test("argument and pin refusals happen before anything is loaded or asked", async () => {
  for (const bad of [[], ["--check", "--run"], ARGS.filter((a, i) => i !== 1 && a !== "--deployment"), [...ARGS.slice(0, -2), "--timeout-sec", "999"]]) {
    const spy = {}; const r = await main(["--run", ...bad.filter((x) => x !== "--run")], deps({ spy }));
    assert.equal(r.exit, 1); assert.equal(spy.loadOperator, 0); assert.equal(spy.getState, 0);
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pins-")); fs.mkdirSync(path.join(d, "a"), { recursive: true }); fs.writeFileSync(path.join(d, "a/x.mjs"), "x");
  assert.throws(() => verifyPins({ control: d, pins: { "a/x.mjs": "0".repeat(64) } }), /differ from the reviewed pins: a\/x\.mjs/);
  assert.throws(() => verifyPins({ control: d, pins: { "a/missing.mjs": "0".repeat(64) } }), /a\/missing\.mjs/);
  const spy = {}; const r = await main(["--run", ...ARGS], { ...deps({ spy }), verify: () => { throw new (class extends Error {})("x"); } });
  assert.notEqual(r.exit, 0); assert.equal(spy.loadOperator, 0);
});

test("identity, runner id, runtime pin and environment must all hold; nothing is loaded or signed otherwise", async () => {
  const cases = [{ idOver: { publicUrl: EP + "/" } }, { idOver: { publicUrl: "https://other.example" } }, { env: { ENCLAVE_ISOLATION_RUNTIME_ID: "e".repeat(64) } },
    { env: { ENCLAVE_ISOLATION_RUNTIME_ID: "" } }, { env: { ENCLAVE_ISOLATION_MANAGER: "" } }, { idOver: { mode: "independent", relayBase: "" } }];
  for (const c of cases) { const spy = {}; const r = await main(["--run", ...ARGS], deps({ ...c, spy }));
    assert.equal(r.exit, 1, JSON.stringify(c)); assert.equal(spy.loadOperator, 0); assert.equal(spy.create, 0); clean(r); }
});

test("exactly one record, every pin holding: anything else refuses before the operator credential is loaded", async () => {
  const states = [{ deployments: [] }, { deployments: [rec(), rec()] }, { deployments: [rec({ status: "held" })] }, { deployments: [rec({ isPublic: false })] },
    { deployments: [rec({ owner: "0x" + "9".repeat(40) })] }, { deployments: [rec({ version: "0.1.9" })] }, { deployments: [rec({ cid: "other" })] },
    { deployments: [rec({ gpuShare: 0.5 })] }, { deployments: [rec({}, { instance: "hv" + "0".repeat(32) })] }, { deployments: [rec({}, { appId: "f".repeat(64) })] },
    { deployments: [rec({}, { tier: "snp" })] }, { deployments: [rec({}, { transportKeySha256: null })] }];
  for (const state of states) { const spy = {}; const r = await main(["--run", ...ARGS], deps({ state, spy }));
    assert.equal(r.exit, 1, out(r)); assert.equal(spy.loadOperator, 0); assert.equal(spy.create, 0); }
});

test("--check loads the operator through loadOperator and stops: no pass, no signature, no request", async () => {
  const spy = {}; relaySeen = []; const r = await main(["--check", ...ARGS], deps({ spy }));
  assert.equal(r.exit, 0); assert.equal(spy.loadOperator, 1); assert.equal(spy.create, 0); assert.equal(spy.signed.length, 0); assert.equal(relaySeen.length, 0);
  assert.match(r.report.result, /nothing signed or requested/); clean(r);
});

test("--run, relay answers 202: one exact signature, nothing installed, the relay's retry reported; no secret in the report", async () => {
  const spy = {}; relaySeen = []; relayReply = () => [202, { name: NAME, retryAfterSec: 240 }];
  const r = await main(["--run", ...ARGS], deps({ spy }));
  assert.equal(r.exit, 2); assert.equal(spy.signed.length, 1);
  assert.match(spy.signed[0], new RegExp(`^enclave-certs-issue:${NAME.replace(/\./g, "\\.")}:${EP.replace(/[./]/g, "\\$&")}:${SPKI}:\\d+$`));
  assert.equal(relaySeen.length, 1); assert.equal(relaySeen[0].name, NAME); assert.equal(relaySeen[0].endpoint, EP); assert.equal(relaySeen[0].opSig, SIG);
  assert.equal(r.report.retryAfterSec, 240); assert.match(r.report.why, /in flight/);
  assert.equal(spy.opts.endpoint, EP); assert.equal(spy.opts.runtimeId, PIN); assert.equal(spy.opts.base, RELAY);
  assert.equal(spy.opts.served(OWNER), true); assert.equal(spy.opts.served("0x" + "9".repeat(40)), false);
  clean(r);
});

test("--run, relay issues: installed; a refusal: nothing installed with the backoff; a reuse never signs", async () => {
  relayReply = () => [200, { certPem: "-----BEGIN CERTIFICATE-----", notAfter: "2027-01-01T00:00:00Z", ca: "test" }];
  let spy = {}; let r = await main(["--run", ...ARGS], deps({ spy })); assert.equal(r.exit, 0); assert.equal(r.report.result, "installed"); clean(r);
  relayReply = () => [502, { error: "issue_failed", message: "No CA issued x: ACME 429" }];
  spy = {}; r = await main(["--run", ...ARGS], deps({ spy })); assert.equal(r.exit, 2); assert.match(r.report.why, /issue_failed/); assert.equal(r.report.retryAfterSec, 30); clean(r);
  spy = {}; relaySeen = [];
  r = await main(["--run", ...ARGS], deps({ spy, ensure: async () => ({ key: SPKI, serial: "0B", notAfter: Date.now() + 864e5, issuer: "CN=x", reused: true }) }));
  assert.equal(r.exit, 0); assert.match(r.report.result, /^reused/); assert.equal(spy.signed.length, 0); assert.equal(relaySeen.length, 0); clean(r);
});

test("--expect-operator: a different loaded operator refuses before any pass or signature", async () => {
  const spy = {}; const r = await main(["--run", ...ARGS, "--expect-operator", "0x" + "7".repeat(40)], deps({ spy }));
  assert.equal(r.exit, 1); assert.equal(spy.create, 0); assert.equal(spy.signed.length, 0); assert.match(r.report.why, /expected runner operator/);
  const ok = await main(["--check", ...ARGS, "--expect-operator", "0x1A01194c34Fe3577C6d0a54feB78af6253e494e0"], deps({}));
  assert.equal(ok.exit, 0);
});

test("every in-tree module the runner can load is pinned (the computed import closure of its four roots)", () => {
  const closure = JSON.parse(fs.readFileSync(new URL("../closure.json", import.meta.url), "utf8"));
  const missing = closure.filter((f) => !(f in MODULE_PINS));
  assert.deepEqual(missing, []);
  assert.equal(closure.length, 17);
});

test("the narrow signer: only this name, endpoint and key, a fresh timestamp, once", async () => {
  const signed = []; const account = { signMessage: async ({ message }) => { signed.push(message); return SIG; } };
  const t = 1_800_000_000_000, now = () => t, s = Math.floor(t / 1000);
  const mk = () => narrowSigner({ account, name: NAME, endpoint: EP, spki: SPKI, now });
  for (const m of [`enclave-certs-issue:other.app.enclave.host:${EP}:${SPKI}:${s}`, `enclave-certs-issue:${NAME}:${EP}/:${SPKI}:${s}`,
    `enclave-certs-issue:${NAME}:${EP}:${"e".repeat(64)}:${s}`, `enclave-certs-issue:${NAME}:${EP}:${SPKI}:${s - 61}`, `enclave-certs-issue:${NAME}:${EP}:${SPKI}:${s + 61}`,
    `enclave-certs-issue:${NAME}:${EP}:${SPKI}:${s}:extra`, `enclave-secrets:${NAME}`, `anything`])
    await assert.rejects(mk()(m));
  const one = mk(); assert.equal(await one(`enclave-certs-issue:${NAME}:${EP}:${SPKI}:${s}`), SIG);
  await assert.rejects(one(`enclave-certs-issue:${NAME}:${EP}:${SPKI}:${s}`), /already signed once/);
  assert.equal(signed.length, 1);
});

test("a pass that never finishes is cut at --timeout-sec and reported as unknown (exit 3), nothing claimed", async () => {
  const spy = {}; const t0 = Date.now();
  const r = await main(["--run", ...ARGS], deps({ spy, ensure: () => new Promise(() => {}) }));
  assert.equal(r.exit, 3); assert.match(r.report.result, /^timeout/); assert.ok(Date.now() - t0 < 12_000); clean(r);
});
