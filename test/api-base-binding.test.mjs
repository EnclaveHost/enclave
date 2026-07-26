// site/js/core/api.js — a session travels only to the endpoint that issued it.
//
// The API base persists in localStorage because the Deploy page exposes the
// field. That persistence is the hazard: a stored base survives reloads, so
// anything that once managed to write localStorage for enclave.host would keep
// receiving the user's bearer token indefinitely — long after the way in was
// closed. Binding each session to its issuer turns that from a standing
// credential leak into a one-off. It also happens to be the truth about the
// tokens: each enclave signs with its own in-enclave key, the relay with its
// own, so a token is meaningless anywhere else.
//
//   run: node --test test/api-base-binding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// the module reads localStorage at import; give it one, plus a fetch we observe
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// emit() dispatches on `document`; the module graph only needs it to exist
globalThis.CustomEvent = class { constructor(t, o){ this.type = t; this.detail = (o||{}).detail; } };
globalThis.document = { dispatchEvent(){}, addEventListener(){} };

let seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url, headers: (init && init.headers) || {} });
  return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ ok: true }) };
};

const { Enclave, EnclaveError } = await import(path.join(REPO, "site/js/core/api.js"));
const { DEFAULT_API_BASE } = await import(path.join(REPO, "site/js/core/config.js"));

const EVIL = "https://relay.evil.example";
const authHeader = () => (seen.at(-1).headers || {}).Authorization;

test("a session minted at the default base is sent there", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.token = "enclave-jwt"; Enclave.tokenBase = DEFAULT_API_BASE;
  Enclave.accountToken = "account-jwt"; Enclave.accountTokenBase = DEFAULT_API_BASE;
  await Enclave.getAccount();
  assert.equal(authHeader(), "Bearer enclave-jwt");
  await Enclave.billingVault();
  assert.equal(authHeader(), "Bearer account-jwt");
});

test("repointing the base does NOT carry the token to the new endpoint", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.token = "enclave-jwt"; Enclave.tokenBase = DEFAULT_API_BASE;
  Enclave.accountToken = "account-jwt"; Enclave.accountTokenBase = DEFAULT_API_BASE;
  Enclave.setBase(EVIL);

  await assert.rejects(() => Enclave.getAccount(), (e) => e instanceof EnclaveError && e.status === 401 && /different endpoint/.test(e.message));
  await assert.rejects(() => Enclave.billingVault(), (e) => e instanceof EnclaveError && e.status === 401 && /different endpoint/.test(e.message));
  assert.equal(seen.length, 0, "not one request left the page carrying a credential");
});

test("an OPTIONAL account auth is simply omitted, not an error", async () => {
  seen = [];
  Enclave.setBase(EVIL);
  Enclave.accountToken = "account-jwt"; Enclave.accountTokenBase = DEFAULT_API_BASE;
  await Enclave.listApps?.().catch(() => {});          // may not exist; the direct check below is the assertion
  seen = [];
  await Enclave._req("GET", "/anything", { accountAuthOptional: true });
  assert.equal(authHeader(), undefined, "the call still goes out, without the credential");
  assert.match(seen.at(-1).url, /^https:\/\/relay\.evil\.example/);
});

test("signing in against the new endpoint binds to it, and the old one is refused", async () => {
  seen = [];
  Enclave.setBase(EVIL);
  Enclave.accountToken = "fresh"; Enclave.accountTokenBase = EVIL;
  await Enclave.billingVault();
  assert.equal(authHeader(), "Bearer fresh");
  Enclave.setBase(DEFAULT_API_BASE);
  await assert.rejects(() => Enclave.billingVault(), (e) => e.status === 401);
});

test("a session stored before this binding existed is honored only at the default", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.token = "legacy"; Enclave.tokenBase = null;      // no stamp on disk
  await Enclave.getAccount();
  assert.equal(authHeader(), "Bearer legacy");
  Enclave.setBase(EVIL);
  await assert.rejects(() => Enclave.getAccount(), (e) => e.status === 401);
});

test("clearing a session clears its binding too", () => {
  Enclave.accountToken = "x"; Enclave.accountTokenBase = EVIL;
  Enclave.clearAccountSession();
  assert.equal(Enclave.accountToken, null);
  assert.equal(Enclave.accountTokenBase, null);
});
