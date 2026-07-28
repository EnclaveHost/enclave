// The attach signer is scoped, not an oracle.
//
// POST /v1/internal/tunnel-attach-sig lets the metal agent get this box's
// REGISTRY OPERATOR key to sign a tunnel attach challenge — the identity that
// survives a reboot, which a quote (image only) and the per-boot transport key
// cannot supply. That key also sends claim/renew, so the endpoint has to be
// narrow in three ways at once, and each is asserted here against a REAL boot:
//   1. gated by a token DERIVED from the fleet SECRET (the untrusted relay, and
//      any tenant that reaches loopback, holds neither);
//   2. the signed message is BUILT here from a validated name + nonce, never
//      taken from the caller — so it cannot be pointed at arbitrary bytes;
//   3. personal_sign, whose EIP-191 prefix means the result can never be
//      replayed as a transaction.
//
//   run: node --test test/opsign.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootDaemon } from "./helpers/daemon.mjs";

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");
const SECRET = "test-secret";
const TOKEN = createHmac("sha256", SECRET).update("enclave opsign v1").digest("hex");
// anvil account 0 — a well-known test key, never funded anywhere real
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const ENV = {
  SECRET, REGISTRY_PRIVATE_KEY: PK, ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
  ACME_SELFTEST: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "",
  SWEEP_SELFTEST: "", REACH_SELFTEST: "", WAF_SELFTEST: "",
};

async function boot() {
  return bootDaemon({
    start: (p) => spawn(process.execPath, [SUPERVISOR], {
      env: { ...process.env, ...ENV, PORT: String(p) }, stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (out, p) => out.includes(`enclave supervisor on :${p}`),
  });
}

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/internal/tunnel-attach-sig`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("it signs an attach challenge for the agent, and only with the derived token", async () => {
  const { child, port } = await boot();
  try {
    const nonce = Buffer.alloc(32, 7).toString("base64");

    // no token / wrong token: 404, not 401 — an unauthenticated caller learns
    // nothing about whether this route exists
    assert.equal((await post(port, { name: "metal0", nonce })).status, 404);
    assert.equal((await post(port, { name: "metal0", nonce }, { "x-opsign-token": "nope" })).status, 404);

    const r = await post(port, { name: "metal0", nonce }, { "x-opsign-token": TOKEN });
    assert.equal(r.status, 200);
    const { signature, operator } = await r.json();
    assert.equal(operator.toLowerCase(), ADDR.toLowerCase(), "it signs with the registry operator key");

    // it signed EXACTLY the message the hub will recover, and nothing else
    const { recoverMessageAddress } = await import("viem");
    const got = await recoverMessageAddress({
      message: `enclave-tunnel-attach:metal0:${nonce}`, signature });
    assert.equal(got.toLowerCase(), ADDR.toLowerCase());
  } finally { child.kill("SIGKILL"); }
});

test("the caller cannot choose the bytes that get signed", async () => {
  const { child, port } = await boot();
  try {
    const nonce = Buffer.alloc(32, 7).toString("base64");
    // a name is a plain label; a nonce is base64. Anything that could smuggle
    // structure into the message is refused before the key is touched.
    for (const bad of [
      { name: "metal0/../x", nonce },
      { name: "metal0:extra", nonce },
      { name: "", nonce },
      { name: "a".repeat(65), nonce },
      { name: "metal0", nonce: "not base64!" },
      { name: "metal0", nonce: "" },
      { name: "metal0", nonce: "A".repeat(129) },
    ]) {
      const r = await post(port, bad, { "x-opsign-token": TOKEN });
      assert.equal(r.status, 422, `must refuse ${JSON.stringify(bad)}`);
    }
    // and the message is built here: a caller-supplied "message" field is ignored
    const r = await post(port, { name: "metal0", nonce, message: "transfer everything" },
                         { "x-opsign-token": TOKEN });
    const { recoverMessageAddress } = await import("viem");
    assert.equal((await recoverMessageAddress({
      message: `enclave-tunnel-attach:metal0:${nonce}`, signature: (await r.json()).signature })).toLowerCase(),
      ADDR.toLowerCase(), "the signed message is ours, not the caller's");
  } finally { child.kill("SIGKILL"); }
});

test("a box with no registry key has nothing to prove and says so", async () => {
  const { child, port } = await bootDaemon({
    start: (p) => spawn(process.execPath, [SUPERVISOR], {
      env: { ...process.env, ...ENV, REGISTRY_PRIVATE_KEY: "", PORT: String(p) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (out, p) => out.includes(`enclave supervisor on :${p}`),
  });
  try {
    const r = await post(port, { name: "metal0", nonce: Buffer.alloc(32, 7).toString("base64") },
                         { "x-opsign-token": TOKEN });
    assert.equal(r.status, 409);
    // such a box does not sell, so its name is unregistered and stays first-come
    assert.match((await r.json()).code, /no_operator_key/);
  } finally { child.kill("SIGKILL"); }
});
