// relay/tuna-funding.mjs: who may ask the platform to fund TUNA wallets, for what, and how much.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { tunaFunding, fundingMessage, fundingLabel, LIMITS } from "../relay/tuna-funding.mjs";

const EK = "ab".repeat(32), RUNNER = "0x" + "22".repeat(32), OP = "0x" + "11".repeat(20);
const addrs = (n, seed = "A") => Array.from({ length: n }, (_, i) => "NKN" + (seed + String.fromCharCode(66 + i)).padEnd(33, "x"));
const dep = (c) => "0x" + c.repeat(64);
function world({ info = {}, rows = {}, limits } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tuna-fund-")), file = path.join(dir, "q.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const tunnels = { box: { mode: "hv-node", spki, hvNode: { boot: { ekCertSha256: EK } }, hvOperator: OP, ...info } };
  let clock = Date.parse("2026-10-11T12:00:00Z"), n = 0;
  const lease = BigInt(Math.floor(clock / 1000) + 3600);
  const ledger = { [dep("a")]: { active: true, isPublic: true, runner: RUNNER, leaseUntil: lease }, ...rows };
  const make = () => tunaFunding({ hub: { info: (name) => tunnels[name] || null }, file, now: () => clock, limits,
    confirmRow: async (id) => { if (!ledger[id]) throw Object.assign(new Error("none"), { code: "no_deployment" }); return ledger[id]; },
    runnerOf: async () => RUNNER });
  const f = make();
  const ask = (b, key = privateKey) => {
    const nonce = (b.nonce ?? (++n).toString(16).padStart(32, "0"));
    const body = { name: "box", ...b, nonce };
    body.sig ??= sign(null, Buffer.from(fundingMessage(body.name, body.purpose, String(body.deploymentId || "").toLowerCase(), body.addresses, nonce)), key).toString("hex");
    return f.request(body);
  };
  return { f, ask, file, tunnels, ledger, make, tick: (ms) => (clock += ms), lease };
}

test("a registered, TPM-attested box gets its control wallets and each leased app's wallets recorded, once", async () => {
  const w = world();
  const c = await w.ask({ purpose: "control", addresses: addrs(2) });
  assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(c.body.label, fundingLabel("control", EK)); assert.equal(c.body.nkn, "0.05");
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2) })).body.already, true, "the same wallets again: already recorded");
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2, "Z") })).status, 409, "other control wallets for this TPM: refused");
  const a = await w.ask({ purpose: "app", deploymentId: dep("a"), addresses: addrs(6) });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.nkn, "0.25");
  const q = JSON.parse(fs.readFileSync(w.file, "utf8"));
  assert.deepEqual(Object.keys(q.targets).sort(), [fundingLabel("control", EK), fundingLabel("app", dep("a"))].sort());
  assert.equal(q.targets[fundingLabel("app", dep("a"))].host, "box");
  assert.equal(Object.keys(w.make().entries()).length, 2, "the queue survives a restart");
  w.tick(LIMITS.controlRenewDays * 86_400_000 + 1);
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2, "Z") })).status, 201, "a TPM may re-fund new control wallets after the renewal period");
});

test("refusals: not attested, not registered, bad signature, replay, wrong shapes, a deployment not leased here", async () => {
  for (const [label, info, code] of [["not hv-node", { mode: "snp" }, "not_hardware_attested"], ["no EK", { hvNode: {} }, "not_hardware_attested"],
                                     ["unregistered", { hvOperator: undefined }, "not_registered"]]) {
    const w = world({ info });
    assert.equal((await w.ask({ purpose: "control", addresses: addrs(2) })).body.error, code, label);
  }
  const w = world({ rows: { [dep("b")]: { active: true, isPublic: false, runner: RUNNER, leaseUntil: 9999999999n },
                            [dep("c")]: { active: true, isPublic: true, runner: "0x" + "33".repeat(32), leaseUntil: 9999999999n },
                            [dep("d")]: { active: true, isPublic: true, runner: RUNNER, leaseUntil: 1n } } });
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2), sig: "00".repeat(64) })).body.error, "bad_signature");
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2), deploymentId: dep("a") }, generateKeyPairSync("ed25519").privateKey)).body.error, "bad_signature");
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2), nonce: "ff".repeat(16) })).status, 201);
  assert.equal((await w.ask({ purpose: "control", addresses: addrs(2), nonce: "ff".repeat(16) })).body.error, "replayed");
  assert.equal((await w.ask({ name: "nobody", purpose: "control", addresses: addrs(2) })).body.error, "unknown_tunnel");
  for (const b of [{ purpose: "constructor", addresses: addrs(2) }, { purpose: "control", addresses: addrs(3) }, { purpose: "control", addresses: [addrs(1)[0], addrs(1)[0]] },
                   { purpose: "control", addresses: ["NKNshort", addrs(1)[0]] }, { purpose: "app", addresses: addrs(6), deploymentId: "0x12" }])
    assert.equal((await w.ask(b)).status, 400, JSON.stringify(b));
  for (const id of [dep("b"), dep("c"), dep("d"), dep("e")])
    assert.equal((await w.ask({ purpose: "app", deploymentId: id, addresses: addrs(6) })).body.error, "not_leased_here", id);
});

test("caps: per host per day, then the platform's day; a moved deployment may re-fund from its new host", async () => {
  const rows = {}; for (let i = 0; i < 12; i++) rows[dep(i.toString(16))] = { active: true, isPublic: true, runner: RUNNER, leaseUntil: 9999999999n };
  const w = world({ rows, limits: { ...LIMITS, appsPerHostPerDay: 3, appsPerDay: 4 } });
  for (let i = 0; i < 3; i++) assert.equal((await w.ask({ purpose: "app", deploymentId: dep(i.toString(16)), addresses: addrs(6, String.fromCharCode(80 + i)) })).status, 201);
  assert.equal((await w.ask({ purpose: "app", deploymentId: dep("3"), addresses: addrs(6, "M") })).body.error, "host_daily_cap");
  w.tunnels.other = { ...w.tunnels.box };
  assert.equal((await w.ask({ name: "other", purpose: "app", deploymentId: dep("4"), addresses: addrs(6, "N") })).status, 201);
  assert.equal((await w.ask({ name: "other", purpose: "app", deploymentId: dep("5"), addresses: addrs(6, "W") })).body.error, "daily_cap");
  assert.equal((await w.ask({ name: "box", purpose: "app", deploymentId: dep("0"), addresses: addrs(6, "X") })).body.error, "already_funded", "same host, other wallets");
  w.tick(86_400_001);
  assert.equal((await w.ask({ name: "other", purpose: "app", deploymentId: dep("0"), addresses: addrs(6, "Y") })).status, 201, "moved to another host: new wallets");
});
