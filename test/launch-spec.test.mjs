// Launch inputs (supervisor.js) — what a launch hands the guest, and the
// invariant that EVERY launch hands it the same things. Driven through the
// LAUNCH_SPEC_SELFTEST seam, same contract as CFG_EDIT_SELFTEST et al.
//
// Why this exists (2026-08-11, kryptos): a risc-box deployment served
// "endpoint":"" with three secrets correctly stored, correctly sealed, and
// correctly served — the relay logged `fetch OK … rev 1, 3 name(s)` for it.
// Per-deployment secrets and custom-domain hostnames had been wired into
// provisionTenant only, and respawnTenant — the billing ticker's 15s recovery
// for a died app or a restarted wasm-manager — carried its own literal spawn
// argument object with neither. The claim loop's 60s crash recovery goes
// through provisionTenant, so the two race and only one strips the guest:
// the same app would come back configured or unconfigured by timing alone.
// The relay could not see it either: a respawn never fetches, and a missing
// fetch line was being read as "the enclave couldn't reach us".
//
// Two guards, because the defect was a missing CALL and not a wrong value:
// the spec carries what a launch owes the guest, AND launchSpec is the only
// place a spec is built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function specs(cases) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", LAUNCH_SPEC_SELFTEST: JSON.stringify({ cases }),
           SWEEP_SELFTEST: "", LEDGER_MOVE_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const REC = {
  id: "0x16f99ddb", _onchain: true, status: "running",
  resources: { cpuShare: 0.07, gpuShare: 0 },
  image: { reference: "catalog://0xa856a26b/15" },
  network: { port: 8000 }, firewall: ["http:8000", "tcp:2222"],
  config: '{"endpoint":"$S3_ENDPOINT"}',
};
const SEC = { rev: 1, env: { S3_ENDPOINT: "https://r2.example", S3_ACCESS_KEY_ID: "ak", S3_SECRET_ACCESS_KEY: "sk" } };

test("a launch carries the owner's secrets and the deployment's hostnames", async () => {
  const [spec] = await specs([{ rec: REC, sec: SEC, hosts: ["16f99ddb.app.enclave.host", "box.customer.example"] }]);
  assert.deepEqual(spec.secrets, ["S3_ACCESS_KEY_ID", "S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"]);
  assert.deepEqual(spec.hosts, ["16f99ddb.app.enclave.host", "box.customer.example"]);
  // and the rest of the envelope the manager needs to launch at all
  assert.equal(spec.deploymentId, REC.id);
  assert.equal(spec.config, REC.config);
  assert.equal(spec.appPort, 8000);
  assert.equal(spec.cpuShare, 0.07);
  assert.deepEqual(spec.image, { reference: "catalog://0xa856a26b/15" });
});

test("nothing staged is nothing injected, and that is not the same as absent", async () => {
  // rev 0 / no names: the guest gets `secrets: null`, so the manager adds no
  // --env at all rather than an empty one. `hosts` degrades to [] the same way.
  const [none, empty] = await specs([
    { rec: REC, sec: null, hosts: [] },
    { rec: REC, sec: { rev: 0, env: {} }, hosts: null },
  ]);
  assert.equal(none.secrets, null);
  assert.deepEqual(none.hosts, []);
  assert.equal(empty.secrets, null);
  assert.deepEqual(empty.hosts, []);
});

test("a version's configCid rides along instead of an inline config", async () => {
  const [spec] = await specs([
    { rec: { ...REC, config: "", appConfigCid: "bafkreiabc" }, sec: SEC, hosts: [] },
  ]);
  assert.equal(spec.config, "");
  assert.equal(spec.configCid, "bafkreiabc");
  assert.deepEqual(spec.secrets, ["S3_ACCESS_KEY_ID", "S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"]);
});

test("a wasm override beats the catalog reference", async () => {
  const [spec] = await specs([{ rec: { ...REC, appWasm: "ipfs://bafyfoo" }, sec: SEC, hosts: [] }]);
  assert.deepEqual(spec.image, { reference: "ipfs://bafyfoo" });
});

// THE regression. The bug was not a bad spec, it was a second launch site that
// built its own — so pin that there is exactly one builder and that every
// spawn goes through it. A new launch path must join them, not fork them.
test("every launch site builds its spec through launchSpec", () => {
  const src = fs.readFileSync(SUPERVISOR, "utf8");
  const calls = [...src.matchAll(/await spawnContainer\((.*?)\);\s*$/gm)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, "expected the provision and respawn launch sites");
  for (const arg of calls)
    assert.equal(arg, "await launchSpec(rec)", `a launch site builds its own spawn spec: ${arg}`);
  // and launchSpec is the only production caller of the pure builder (the
  // other hit in the file is the LAUNCH_SPEC_SELFTEST seam this test drives)
  const builders = [...src.matchAll(/^\s*return launchSpecFrom\(/gm)];
  assert.equal(builders.length, 1, "a spec is built somewhere other than launchSpec");
});
