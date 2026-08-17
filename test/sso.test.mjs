// Sign in with Enclave (relay/sso.js): EST1 token minting for tenant apps.
// The mint side of enclave-apps/eyesoff-ai's PLATFORM-sso.md; the verifier is
// that repo's sso.rs. The spec-vector test pins the two implementations to the
// SAME BYTES: deterministic ECDSA (RFC 6979) means the fixed key + fixed
// claims must reproduce the exact token string the app's test suite carries -
// if either side changes serialization, hashing, or the v-byte spelling, this
// fails before any deployment does.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { bootApiRelay } from "./helpers/daemon.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known test key
const signer = privateKeyToAccount(PK);

// the app repo's fixed throwaway signer: 32 bytes of 0x42
const SSO_KEY = "0x" + "42".repeat(32);
const SSO_ADDR = "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025";

// the spec vector quoted in PLATFORM-sso.md and pinned by sso.rs spec_vector
const VEC_SUB = "0x00a329c0648769a73afac7f9381e08fb43dbea72";
const VEC_AUD = "0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa";
const VEC_TOKEN =
  "EST1.eyJhdWQiOiIweGNjMWY0ZjNmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwYWEiLCJleHAiOjE3NTUwODY0MDAsImlhdCI6MTc1NTAwMDAwMCwic3ViIjoiMHgwMGEzMjljMDY0ODc2OWE3M2FmYWM3ZjkzODFlMDhmYjQzZGJlYTcyIiwidiI6MX0.yk7Y_U0V-3ZyKhLJptbXZB3_Id-bEay1FtUTLFWjGgdyYQRL3xUJfKR5WTawlUSttKpUO0_H-x960Vn5-82NvRw";

async function startRelay(t, { dataDir }) {
  const { child, port } = await bootApiRelay((port) =>
    spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env,
        ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
        AUTH_DATA_DIR: dataDir,
        SSO_SIGNER_KEY: SSO_KEY,
        OFAC_SDN_URLS: "http://127.0.0.1:1/x",            // no live fetches in tests
        BASE_RPC: "http://127.0.0.1:1/rpc", RPC_FALLBACKS: "0",
        SIWE_DOMAIN: "enclave.host", SIWE_URI: "https://enclave.host",
        FEATURED_VIEWS_FILE: path.join(dataDir, "feat.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  t.after(() => child.kill("SIGKILL"));
  return { origin: `http://127.0.0.1:${port}`, child };
}

const api = async (origin, method, p, { body, token } = {}) => {
  const r = await fetch(origin + p, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function siweLogin(origin, account) {
  const n = await api(origin, "GET", `/v1/account/siwe/nonce?address=${account.address}`);
  assert.equal(n.status, 200);
  const signature = await account.signMessage({ message: n.body.message });
  return api(origin, "POST", "/v1/account/siwe/verify", { body: { message: n.body.message, signature } });
}

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("mintEst1 reproduces the app repo's spec vector byte for byte", async () => {
  process.env.SSO_SIGNER_KEY = SSO_KEY;
  const sso = await import("../relay/sso.js");
  const st = await sso.initSso();
  assert.equal(st.enabled, true);
  assert.equal(sso.ssoSignerAddress().toLowerCase(), SSO_ADDR);
  const token = await sso.mintEst1({ sub: VEC_SUB, aud: VEC_AUD, iat: 1_755_000_000, exp: 1_755_086_400 });
  assert.equal(token, VEC_TOKEN);
});

test("sso endpoints: signer, mint, and every refusal", async (t) => {
  const { origin } = await startRelay(t, { dataDir: tmp(t) });

  // the pin is public
  const s = await api(origin, "GET", "/v1/sso/signer");
  assert.equal(s.status, 200);
  assert.equal(String(s.body.signer).toLowerCase(), SSO_ADDR);

  // no session -> 401; the endpoint asserts identity, it never invents one
  const anon = await api(origin, "POST", "/v1/sso/token", { body: { aud: VEC_AUD, address: signer.address } });
  assert.equal(anon.status, 401);

  const login = await siweLogin(origin, signer);
  assert.equal(login.status, 200);
  const tok = login.body.token;

  // malformed audience and address are named, not signed
  assert.equal((await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: "0x1234", address: signer.address } })).status, 400);
  assert.equal((await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: VEC_AUD, address: "0xnope" } })).status, 400);

  // a wallet the account never linked cannot be asserted, however valid the session
  const stranger = privateKeyToAccount("0x" + "43".repeat(32));
  const not = await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: VEC_AUD, address: stranger.address } });
  assert.equal(not.status, 403);
  assert.equal(not.body.error, "wallet_not_linked");

  // the real mint: shape, claims, and a signature that recovers to the signer
  const out = await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: VEC_AUD, address: signer.address } });
  assert.equal(out.status, 200);
  const token = out.body.token;
  const [tag, payloadB64, sigB64] = token.split(".");
  assert.equal(tag, "EST1");
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  assert.equal(claims.v, 1);
  assert.equal(claims.sub, signer.address.toLowerCase());
  assert.equal(claims.aud, VEC_AUD.toLowerCase());
  assert.equal(claims.exp - claims.iat, 86400);              // default TTL
  const sig = Buffer.from(sigB64, "base64url");
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28, "v spelled the wallet way");
  const rec = await recoverMessageAddress({ message: "EST1." + payloadB64, signature: "0x" + sig.toString("hex") });
  assert.equal(rec.toLowerCase(), SSO_ADDR);

  // ttl clamps: floor 300, ceiling 604800
  const lo = await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: VEC_AUD, address: signer.address, ttl: 10 } });
  const loClaims = JSON.parse(Buffer.from(lo.body.token.split(".")[1], "base64url").toString());
  assert.equal(loClaims.exp - loClaims.iat, 300);
  const hi = await api(origin, "POST", "/v1/sso/token", { token: tok, body: { aud: VEC_AUD, address: signer.address, ttl: 99999999 } });
  const hiClaims = JSON.parse(Buffer.from(hi.body.token.split(".")[1], "base64url").toString());
  assert.equal(hiClaims.exp - hiClaims.iat, 604800);
});
