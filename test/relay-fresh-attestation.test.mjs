// The relay's two public endpoints for client-side verification (relay/api-relay.js), on the REAL api-relay process:
//   GET /v1/enclaves/<name>/attestation?nonce=<64 hex>  a FRESH document from an attached SEV-SNP box over the caller's nonce
//                                                      (relay/tunnel.js freshAttestation; the success path is test/tunnel.test.mjs)
//   GET /v1/amd-kds/vcek/v1/<product>/<cert_chain|crl|hwid>  AMD KDS mirrored for browsers (bytes only)
// Here: every refusal a client can hit without a box or AMD on the line, and that only KDS's own paths are ever forwarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { bootApiRelay } from "./helpers/daemon.mjs";

const RELAY_DIR = path.resolve(import.meta.dirname, "../relay");

test("fresh attestation + KDS mirror: refusals are explicit, CORS-open, and nothing outside KDS's paths is forwarded", { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-att-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_BIND: "127.0.0.1", BASE_RPC: "http://127.0.0.1:1", RPC_FALLBACKS: "0",
                REGISTRY_ADDRESS: "0x" + "11".repeat(20), DEPLOYMENTS_ADDRESS: "0x" + "22".repeat(20), FEATURED_VIEWS_FILE: path.join(dir, "views.json"),
                AVAIL_POLL_SEC: "3600", RELEASE_PREWARM_SEC: "0" };
  const boot = await bootApiRelay((port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], { env: { ...env, API_RELAY_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] }));
  t.after(() => boot.child.kill("SIGKILL"));
  const base = `http://127.0.0.1:${boot.port}`;
  const get = async (p) => { const r = await fetch(base + p, { headers: { origin: "https://enclave.host" } }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body, cors: r.headers.get("access-control-allow-origin") }; };
  const N = "ab".repeat(32);

  let r = await get("/v1/enclaves/metal0/attestation");
  assert.equal(r.status, 422); assert.equal(r.body.error, "bad_nonce");
  r = await get("/v1/enclaves/metal0/attestation?nonce=" + N.toUpperCase());
  assert.equal(r.status, 422, "the nonce is lowercase hex only");
  r = await get("/v1/enclaves/metal0/attestation?nonce=" + N.slice(2));
  assert.equal(r.status, 422, "exactly 32 bytes");
  r = await get("/v1/enclaves/metal0/attestation?nonce=" + N);
  assert.equal(r.status, 404); assert.equal(r.body.error, "no_box"); assert.ok(r.cors, "CORS-open: a browser page reads the answer");
  r = await get("/v1/enclaves/" + "x".repeat(65) + "/attestation?nonce=" + N);
  assert.notEqual(r.body?.error, "no_box", "an over-long name is not even routed to the hub");

  r = await get("/v1/amd-kds/vcek/v1/Turin/crl?evil=1");
  assert.equal(r.status, 422); assert.equal(r.body.error, "bad_query");
  r = await get("/v1/amd-kds/vcek/v1/Turin/" + "ab".repeat(8) + "?blSPL=3&teeSPL=x");
  assert.equal(r.status, 422, "a TCB parameter must be a number");
  for (const p of ["/v1/amd-kds/vcek/v1/Turin/../../etc", "/v1/amd-kds/vcek/v1/Venice/crl", "/v1/amd-kds/vcek/v2/Turin/crl", "/v1/amd-kds/https:/evil.example/x"]) {
    r = await get(p);
    assert.notEqual(r.status, 200, `${p} is not a KDS path this mirror forwards`);
    assert.notEqual(r.body?.error, "kds_unreachable", `${p} never reached the upstream fetch`);
  }
});
