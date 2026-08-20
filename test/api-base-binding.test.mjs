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

// ---- the sign-in challenge is checked before a wallet sees it ------------------
// The endpoint hands the page a string and the user's key signs it. A browser
// wallet does render the text — a real backstop the CLI lacks — but "the user
// might read it" is not a control. The same key authorizes `enclave-upload:…`,
// `enclave-secrets:put:…` (a secrets WRITE) and the encrypted-volume message
// whose signature IS the volume key. Mirrors cli/enclave.mjs assertSiweLogin.
const { assertSiweLogin } = await import(path.join(REPO, "site/js/core/wallet.js"));
const { BASE_CHAIN } = await import(path.join(REPO, "site/js/core/config.js"));

const ME = "0x" + "11".repeat(20);
const THEM = "0x" + "22".repeat(20);
const siwe = (addr, chain, extra = "") =>
  `enclave.host wants you to sign in with your Ethereum account:\n${addr}\n\nSign in.\n\n` +
  `URI: https://enclave.host\nVersion: 1\nChain ID: ${chain}\nNonce: abc123` + extra;

test("siwe gate: the genuine challenge passes, in both spellings", () => {
  assert.equal(assertSiweLogin(siwe(ME, BASE_CHAIN), ME), siwe(ME, BASE_CHAIN));
  // no statement, with the optional timestamps
  const bare = `enclave.host wants you to sign in with your Ethereum account:\n${ME}\n\n`
    + `URI: https://enclave.host\nVersion: 1\nChain ID: ${BASE_CHAIN}\nNonce: n1\n`
    + `Issued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 6e5).toISOString()}`;
  assert.equal(assertSiweLogin(bare, ME), bare);
  // address case must not matter
  assert.ok(assertSiweLogin(siwe(ME.toUpperCase().replace("0X", "0x"), BASE_CHAIN), ME));
});

test("siwe gate: anything that is not a SIWE login for this wallet is refused", () => {
  const cases = {
    "secrets write":  `enclave-secrets:put:0x${"11".repeat(32)}:9999999999:${"ab".repeat(32)}`,
    "upload token":   `enclave-upload:${"ab".repeat(32)}:9999999999`,
    "encvol key":     "enclave-encvol:v1:vault-prod",
    "bare text":      "please sign this",
    "empty":          "",
    "smuggled rider": siwe(ME, BASE_CHAIN, `\nenclave-secrets:put:0x${"11".repeat(32)}:9999999999:${"ab".repeat(32)}`),
    "other address":  siwe(THEM, BASE_CHAIN),
    "other chain":    siwe(ME, 1),
    "expired":        siwe(ME, BASE_CHAIN, "\nExpiration Time: 2020-01-01T00:00:00.000Z"),
    "two-line statement": `enclave.host wants you to sign in with your Ethereum account:\n${ME}\n\nline one\nline two\n\nURI: https://enclave.host\nVersion: 1\nChain ID: ${BASE_CHAIN}\nNonce: n`,
  };
  for (const [what, msg] of Object.entries(cases))
    assert.throws(() => assertSiweLogin(msg, ME), /Refusing to sign/, what);
});

// ---- a session travels only FOR the wallet that minted it ----------------------
// Sessions are keyed by BOX name, but each one names a wallet (its JWT sub).
// After an account switch the cached token still VERIFIES on its box — so a
// call presenting it doesn't fail as unauthorized, it succeeds as the PREVIOUS
// account, and every owner gate answers 404 "No such deployment." for records
// the connected account owns. Found 2026-08-20: /authorize saw a cached kryptos
// session, skipped the sign-in, minted an app token as the old wallet, and the
// enclave refused the owner's own private app with exactly that message.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtFor = (sub) => `${b64u({ alg: "ES256", kid: "k" })}.${b64u({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

test("another wallet's per-enclave session reads as signed-out, never as that wallet", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.token = null; Enclave.tokenBase = null;
  Enclave.address = ME;
  Enclave.setSessionFor("kryptos", jwtFor(ME));
  assert.equal(Enclave.authedFor("kryptos"), true, "the minting wallet keeps its session");
  await Enclave._req("GET", "/anything", { auth: true, enclave: "kryptos" });
  assert.match(authHeader(), /^Bearer /);

  Enclave.address = THEM;                                   // account switched in the wallet
  assert.equal(Enclave.authedFor("kryptos"), false, "the other wallet's session reads as signed-out");
  seen = [];
  await assert.rejects(() => Enclave._req("GET", "/anything", { auth: true, enclave: "kryptos" }),
    (e) => e instanceof EnclaveError && e.status === 401 && /Not signed in to kryptos/.test(e.message));
  assert.equal(seen.length, 0, "the stale session never left the page");

  Enclave.address = ME;                                     // switching back restores it
  assert.equal(Enclave.authedFor("kryptos"), true, "the session survives for a switch-back");
  Enclave.setSessionFor("kryptos", null);
});

test("a sticky session for another wallet falls back to the public ?owner= read", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.token = jwtFor(ME); Enclave.tokenBase = DEFAULT_API_BASE;
  Enclave.address = THEM;
  await Enclave.getDeployment("0xabc123");
  assert.equal(authHeader(), undefined, "the old account's token is not presented");
  assert.match(seen.at(-1).url, new RegExp("owner=" + THEM), "the read scopes to the CONNECTED wallet");
  await Enclave.listDeployments();
  assert.equal(authHeader(), undefined);
  assert.match(seen.at(-1).url, new RegExp("owner=" + THEM));
  // and a demanded auth without a usable session is an error, not a wrong-wallet call
  seen = [];
  await assert.rejects(() => Enclave.getAccount(), (e) => e.status === 401);
  assert.equal(seen.length, 0);
  Enclave.token = null; Enclave.tokenBase = null;
});

test("an opaque (non-JWT) token stays wallet-agnostic, exactly as before", async () => {
  seen = [];
  Enclave.base = DEFAULT_API_BASE;
  Enclave.address = THEM;
  Enclave.token = "legacy-opaque"; Enclave.tokenBase = DEFAULT_API_BASE;
  await Enclave.getDeployment("0xabc123");
  assert.equal(authHeader(), "Bearer legacy-opaque", "no sub to check means no mismatch to refuse");
  Enclave.setSessionFor("kryptos", "also-opaque");
  assert.equal(Enclave.authedFor("kryptos"), true);
  Enclave.setSessionFor("kryptos", null);
  Enclave.token = null; Enclave.tokenBase = null;
});
