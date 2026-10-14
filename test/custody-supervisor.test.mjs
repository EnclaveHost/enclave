// The legacy (non-attested) launch path and custody (supervisor.js fetchDepSecrets): a deployment whose secrets custodians
// hold must NEVER launch here, on a cached pre-move snapshot or without its values - whether the relay says so (409
// custody_held) or cannot confirm it (503 custody_unconfirmed, review L1). An ordinary 503 keeps the old behaviour.
//   run: node --test test/custody-supervisor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
const QUIET = { INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", CFG_EDIT_SELFTEST: "",
  ISOLATION_SELFTEST: "", GUEST_POOL_SELFTEST: "", GUESTD_TRANSPORT_SELFTEST: "", RELEASE_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "",
  CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "", ISOLATION_RELEASE: "", REGISTRY_PRIVATE_KEY: "", ENABLE_MPS: "0", MOCK_SPAWN: "" };
const ID = "0x" + "c9".repeat(32);

async function withRelay(status, body, fn) {
  const server = http.createServer((req, res) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const run = async (api) => {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], { env: { ...process.env, SECRET: "test-secret", ...QUIET, SECRETS_API: api,
    SECRETS_FETCH_SELFTEST: JSON.stringify({ id: ID, endpoint: "https://box.example", cached: { OLD: "pre-move-value" } }) } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
};

test("custody_held (409) and custody_unconfirmed (503) both refuse the launch and drop the cached snapshot", async () => {
  for (const [status, error] of [[409, "custody_held"], [503, "custody_unconfirmed"]]) {
    const r = await withRelay(status, { error, message: "x" }, run);
    assert.match(r.error || "", /held by custodians/, `${status} ${error}`);
    assert.equal(r.cached, false, "the pre-move snapshot is gone");
    assert.ok(!JSON.stringify(r).includes("pre-move-value"));
  }
});

test("an ordinary 503 (secrets off on that relay) keeps the old behaviour: the cached snapshot", async () => {
  const r = await withRelay(503, { error: "secrets_disabled", message: "x" }, run);
  assert.deepEqual(r.result, { rev: 1, env: { OLD: "pre-move-value" } });
});
