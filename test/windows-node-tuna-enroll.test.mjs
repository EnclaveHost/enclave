// windows/node/tuna-enroll.mjs: an open-market Windows host enrolls its own TUNA privacy agent - control wallets, then the
// config, then each leased app - asking the relay (relay/tuna-funding.mjs, verified for real here) to fund the wallets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createTunaEnroll, fundingMessage, MIN_FUNDED } from "../windows/node/tuna-enroll.mjs";
import { tunaFunding, fundingMessage as relayMessage } from "../relay/tuna-funding.mjs";
import { rawDigest } from "../network/shield-expectation.mjs";

const RID = "ab".repeat(32), APP = "0x" + "5a".repeat(32), RUNNER = "0x" + "22".repeat(32), D = "0x" + "11".repeat(32);
const CID = "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addrOf = (seed) => "NKN" + [...createHash("sha512").update(seed).digest()].slice(0, 33).map((b) => B58[b % 58]).join("");

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuna-enroll-")), agentDir = path.join(dir, "agent"), policyFile = path.join(dir, "policy.json");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: RID }, gpu: {} }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const balances = new Map(), logs = [];
  const relay = tunaFunding({ file: path.join(dir, "queue.json"), runnerOf: async () => RUNNER,
    hub: { info: () => ({ mode: "hv-node", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"), hvNode: { boot: { ekCertSha256: "ee".repeat(32) } }, hvOperator: "0x" + "33".repeat(20) }) },
    confirmRow: async (id) => ({ active: true, isPublic: true, runner: RUNNER, leaseUntil: 9999999999n }) });
  const rows = [{ id: D, appRef: `catalog://${APP}/4`, configCid: "{}", runner: RUNNER, active: true, isPublic: true, leaseUntil: 9999999999n }];
  const vm = { name: D, status: "running", appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: "ef".repeat(32), runtimeId: RID,
               componentSha256: rawDigest(CID), derivation: "enclave-catalog-bundle/1", gpuMilli: 0, startedAt: 1 };
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith("/v1/hosts/tuna-funding")) { const r = await relay.request(JSON.parse(init.body)); return { ok: r.status < 300, status: r.status, json: async () => r.body }; }
    if (url.endsWith("/v1/domains/map")) return { ok: true, json: async () => ({ domains: { "shop.example": D } }) };
    throw new Error("unexpected fetch " + url);
  };
  const run = async (cmd, args) => {
    const seed = args[1];
    if (args[0] === "--init-wallet") fs.writeFileSync(seed, "seed:" + seed);
    else if (!fs.existsSync(seed)) throw Object.assign(new Error("no seed"), { code: 1 });
    return JSON.stringify({ address: addrOf(seed) });
  };
  const enroll = createTunaEnroll({ agentDir, binDir: path.join(dir, "bin"), name: "box", endpoint: "https://api.enclave.host/t/box", runner: RUNNER,
    relayBase: "https://api.enclave.host", transportKey: privateKey, fetch: fetchFn, run, balanceOf: async (a) => balances.get(a) ?? 0n, log: (m) => logs.push(m),
    config: { agentDir, binDir: path.join(dir, "bin"), nodeBinary: "node.exe", operatorKeyFile: "op.key", runner: RUNNER, endpoint: "https://api.enclave.host/t/box",
              relayBase: "https://api.enclave.host", policyFile, tpmBinary: "tpmattest.exe", tpmSha256: "aa".repeat(32), addressBook: "0x" + "44".repeat(20), chainRpc: ["https://rpc"] },
    rows: async () => rows, version: async () => ({ cid: CID }), vms: async () => [vm] });
  const fundAll = () => { for (const e of Object.values(relay.entries())) for (const a of e.addresses) balances.set(a, MIN_FUNDED); };
  return { enroll, relay, agentDir, fundAll, logs, vm };
}

test("the box's funding message is byte-identical to the relay's", () => {
  assert.equal(fundingMessage("box", "app", D, ["NKNa", "NKNb"], "00ff"), relayMessage("box", "app", D, ["NKNa", "NKNb"], "00ff"));
});
test("control wallets, then the config, then each leased app - each step only once the platform funded its wallets", async () => {
  const w = world();
  assert.deepEqual(await w.enroll.pass(), { ready: false }, "control wallets unfunded: nothing else yet");
  assert.equal(fs.existsSync(path.join(w.agentDir, "privacy-config.json")), false, "the \\Enclave\\Tuna task keeps waiting");
  const q1 = w.relay.entries(); assert.equal(Object.keys(q1).length, 1); assert.equal(Object.values(q1)[0].purpose, "control");
  const ctl = JSON.parse(fs.readFileSync(path.join(w.agentDir, "control-wallets.json"), "utf8"));
  assert.deepEqual(ctl.map((c) => c.address), Object.values(q1)[0].addresses, "the relay recorded exactly the box's own wallets");
  w.fundAll();
  let r = await w.enroll.pass();
  assert.equal(r.ready, true); assert.equal(r.apps, 0, "the app's wallets are not funded yet");
  const cfg0 = JSON.parse(fs.readFileSync(path.join(w.agentDir, "privacy-config.json"), "utf8"));
  assert.equal(cfg0.version, 2); assert.equal(cfg0.runner, RUNNER); assert.equal(cfg0.shield.tpmSha256, "aa".repeat(32));
  const app = Object.values(w.relay.entries()).find((e) => e.purpose === "app");
  assert.equal(app.deploymentId, D); assert.equal(app.addresses.length, 6);
  assert.deepEqual((await w.enroll.pass()).apps, 0, "a second pass asks again (idempotent at the relay) and waits");
  assert.equal(Object.values(w.relay.entries()).filter((e) => e.purpose === "app").length, 1);
  w.fundAll();
  r = await w.enroll.pass();
  assert.equal(r.apps, 1);
  const cfg = JSON.parse(fs.readFileSync(path.join(w.agentDir, "privacy-config.json"), "utf8"));
  assert.deepEqual(cfg.apps[0].names, [D.slice(2, 10) + ".app.enclave.host", "shop.example"]);
  assert.equal(cfg.apps[0].internetMode, "tuna");
  const exp = JSON.parse(fs.readFileSync(cfg.apps[0].expectedFile, "utf8"));
  assert.equal(exp.appSha256, "ef".repeat(32)); assert.equal(exp.runtimeId, RID);
  const wallets = JSON.parse(fs.readFileSync(cfg.apps[0].walletsFile, "utf8"));
  assert.deepEqual(wallets.flatMap((x) => ["guard", "public", "egress"].map((k) => x[k].address)), app.addresses);
  assert.equal((await w.enroll.pass()).changed, false, "steady state: nothing rewritten");
  w.vm.appId = "cd".repeat(32);
  assert.equal((await w.enroll.pass()).changed, true, "an upgraded partition rewrites the expectation and touches the config");
  assert.equal(JSON.parse(fs.readFileSync(cfg.apps[0].expectedFile, "utf8")).appSha256, "cd".repeat(32));
});
test("a partition outside the admitted policy is never enrolled or funded", async () => {
  const w = world(); w.fundAll(); await w.enroll.pass(); w.fundAll();
  w.vm.runtimeId = "00".repeat(32);
  const r = await w.enroll.pass();
  assert.equal(r.apps, 0); assert.equal(Object.values(w.relay.entries()).filter((e) => e.purpose === "app").length, 0);
  assert.ok(w.logs.some((l) => /outside the admitted Shield policy/.test(l)));
});
