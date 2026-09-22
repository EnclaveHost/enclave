// An owner's edit and an owner's resize reaching a deployment that is ALREADY RUNNING.
//
// Both land on-chain and both start billing at once, so a box that only read them when it claimed
// the lease was serving one thing and charging for another. The relay AND-folds `configEdit` and
// `shareResize` across the fleet before a client will even send the transaction, which is why the
// verdict below is checked against the platform runner's own seam rather than against my reading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../windows/node/host.mjs";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-edit-"));
const box = (cfg = {}) => new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                                     appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                                     enclaveGb: 64, engineHeldMb: 1879, appSlots: 8, ramGb: 112,
                                     enclaveAppAbi: 5, enclaveAppWorlds: 7, ...cfg });

const CASES = [
  [{ status: "running", envelope: null }, '{"waf":{"rps":5}}'],
  [{ status: "running", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"rps":5}}'],
  [{ status: "running", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"rps":9}}'],
  [{ status: "running", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"rps":5},"config":{"A":1}}'],
  [{ status: "running", envelope: '{"config":{"A":1}}' }, '{"config":{"A":2}}'],
  [{ status: "running", envelope: '{"config":{"A":1}}' }, '{"config":{"A":1}}'],
  [{ status: "running", envelope: '{"config":{"A":1}}' }, "{}"],
  [{ status: "running", envelope: "{}" }, '{"config":{}}'],
  [{ status: "running", envelope: '{"configCid":"bafyaaa"}' }, '{"configCid":"bafybbb"}'],
  [{ status: "running", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"nope":1}}'],
  [{ status: "running", envelope: '{"waf":{"rps":5}}' }, "not json"],
  [{ status: "provisioning", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"rps":9}}'],
  [{ status: "running", envelope: "" }, ""],
];

test("the edit verdict is the platform runner's, case for case", async () => {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret",
           CFG_EDIT_SELFTEST: JSON.stringify({ records: CASES.map(([rec, cid]) =>
             ({ rec: { ...rec, _onchain: true, _envelope: rec.envelope }, chainCid: cid })) }),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" }, maxBuffer: 8 << 20 });
  const lines = stdout.trim().split("\n").filter(Boolean);
  const plat = JSON.parse(lines[lines.length - 1]).map((r) => r.verdict);
  const h = box();
  CASES.forEach(([rec, cid], i) =>
    assert.equal(h.envelopeVerdict(rec, cid), plat[i], `case ${i}: ${JSON.stringify(CASES[i])}`));
});

test("the verdicts are the ones the behaviour depends on", () => {
  const h = box();
  // A record from before the watch adopts the current value WITHOUT a restart: rolling this out
  // must not restart every tenant on the box.
  assert.equal(h.envelopeVerdict({ status: "running", envelope: null }, '{"waf":{"rps":5}}'), "stamp");
  // Rules only: swap live.
  assert.equal(h.envelopeVerdict({ status: "running", envelope: '{"waf":{"rps":5}}' }, '{"waf":{"rps":9}}'), "waf");
  // The app's own configuration: relaunch it.
  assert.equal(h.envelopeVerdict({ status: "running", envelope: "{}" }, '{"config":{"A":1}}'), "restart");
  // "absent" and "explicitly empty" are different owner intents and stay distinct.
  assert.equal(h.envelopeVerdict({ status: "running", envelope: "{}" }, '{"config":{}}'), "restart");
  // An edit that does not parse leaves the RUNNING app alone: the claim gate's fail-closed refusal
  // cannot apply to something already serving, or a typo would take a tenant down.
  assert.equal(h.envelopeVerdict({ status: "running", envelope: "{}" }, '{"waf":{"nope":1}}'), "error");
  // Nothing that is not running is touched at all.
  assert.equal(h.envelopeVerdict({ status: "failed", envelope: "{}" }, '{"config":{"A":1}}'), "skip");
});

test("a resize that no longer fits hands the lease back rather than billing for it", () => {
  // The arithmetic the refusal is made of: its OWN old share is excluded, or a tenant growing from
  // 10% to 20% is measured against a box that still counts their first 10%.
  const h = box();
  h.records.set("0xaa", { id: "0xaa", status: "running", cpuShare: 0.1, gpuShare: 0, memMb: 128 });
  h.records.set("0xbb", { id: "0xbb", status: "running", cpuShare: 0.5, gpuShare: 0, memMb: 128 });
  // 25% is reserved for the enclave, the worker and the owner; 0.6 is sold; so 0.15 is left.
  assert.ok(Math.abs(h.capacity().cpuShareFree - 0.15) < 1e-9);
  // Beside the OTHER tenant only, this one could grow to 0.25.
  assert.ok(Math.abs(h.capacity({ exclude: "0xaa" }).cpuShareFree - 0.25) < 1e-9);
});
