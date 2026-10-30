// site/js/core/sessions.js under a passkey account identity (identity.js), without a chain: a session serves only the account
// it was opened for (never another Safe's, never before the account verifies), and a pending, refused or unrelated request is
// refused before anything is signed or sent - never handed to the connected wallet. Identity changes drop the cached session.
// The chain paths themselves run in test/site-independent-passkey-ui.test.mjs.
//   run: node --test test/site-independent-account-sessions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });
const net = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: "0x" + "11".repeat(20), deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
    proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
    sessionVaultFactory: "0x" + "55".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
const text = JSON.stringify(net);
globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
const doc = new EventTarget(); doc.querySelector = () => null; doc.querySelectorAll = () => [];
globalThis.document = doc;
globalThis.location = { hostname: "localhost", origin: "http://localhost" };
globalThis.fetch = async () => { throw new Error("no network in this test"); };

const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
const { Enclave } = await core("api.js");
const S = await core("sessions.js");
const ID = await core("identity.js");
const AP = await core("account-providers.js");
const { encCall, DEP_SEL } = await core("chain.js");
(await core("passkey-account.js"))._useLibForTests({ ...viem, WebAuthnP256 });
const EP = AP.PROVIDERS["safe-passkey"].contracts.entryPoint.address, SUPPORTED_ENTRYPOINT = viem.toFunctionSelector("SUPPORTED_ENTRYPOINT()");

const SAFE = "0x" + "5a".repeat(20), OTHER = "0x" + "5b".repeat(20), WALLET = "0x" + "9e".repeat(20);
const pk = { kind: "passkey", signer: "0x" + "aa".repeat(20), x: "0x" + "aa".repeat(32), y: "0x" + "ab".repeat(32), verifiers: String(0x100n << 160n),
  credentialId: Buffer.from("credential-aa").toString("base64url"), rpId: "localhost", label: "laptop" };
const profile = { v: 1, provider: "safe-passkey", chainId: 8453, safe: SAFE, saltNonce: "7", threshold: 1, transport: null, owners: [pk] };

// the SDK's key store, holding one session per owner; a session is just its handle here
const records = new Map();
const rec = (id, owner) => records.set(id, { id, handle: { owner, vault: "0x" + "77".repeat(20), sid: id } });
S._useSdkForTests({ IndexedDbStore: class { async load(id){ return records.get(id) || null; } async save(){} async remove(id){ records.delete(id); } },
  sessionFromRecord: async (r) => ({ handle: r.handle, status: async () => ({ live: true }), prepareCall: async () => { throw new Error("must not sign"); } }) });

let verdict = "ok";
const reader = { snapshot: async () => ({ number: 1, hash: "0x" + "bb".repeat(32), timestamp: 1 }),
  call: async (snap, to, data) => data === SUPPORTED_ENTRYPOINT ? viem.pad(EP, { size: 32 }) : "0x", code: async () => "0x" };
const deps = () => ({
  PA: { verifyAccountProfile: async () => { if (verdict === "mismatch") { const e = new Error("the account's owners or threshold on chain differ"); e.name = "AccountError"; throw e; } return { deployed: true, block: 1 }; } },
  AP: { identifyAccount: async (a) => ({ provider: "safe-passkey", recognized: true, threshold: 1, owners: [{ kind: "passkey", address: pk.signer }],
    modules: [], guard: "0x" + "00".repeat(20), fallbackHandler: AP.PROVIDERS["safe-passkey"].contracts.safe4337Module.address, warnings: [] }) },
});
const reset = () => { verdict = "ok"; ID._setForTests({ ls: localStorage, reader, deps: deps() }); S.identityChanged(); };
const accountKey = (safe) => ID.accountSessionKey(8453, safe);
const walletNeverCalled = () => { throw new Error("WALLET FALLBACK"); };
const setActive = encCall(DEP_SEL.setActive, [{ t: "bytes32", v: "0x" + "cd".repeat(32) }, { t: "uint", v: 0 }]);

test.beforeEach(() => {
  for (const k of [...localStorage.m.keys()]) if (/^enclave_(identity|account_session|account_profile|wallet_session)/.test(k)) localStorage.removeItem(k);
  records.clear(); Enclave.address = WALLET; Enclave.provider = null; reset();
  localStorage.setItem("enclave_account_profile:v1:8453", JSON.stringify(profile));
});

test("a verified account's session serves it; another Safe's session, or the wallet's pointer, never does", async () => {
  await ID.selectAccountIdentity(profile);
  rec("0x01", SAFE); rec("0x02", OTHER); rec("0x03", WALLET);
  localStorage.setItem("enclave_wallet_session", "0x03");
  localStorage.setItem(accountKey(SAFE), "0x01");
  assert.equal((await S.currentSession()).owner, SAFE);
  S.identityChanged();
  localStorage.setItem(accountKey(SAFE), "0x02");                       // a pointer planted to another Safe's session
  assert.equal(await S.currentSession(), null, "a session of another Safe never serves this account");
  localStorage.setItem(accountKey(SAFE), "0x03");
  S.identityChanged();
  assert.equal(await S.currentSession(), null, "the wallet's own session never serves the account");
  await assert.rejects(S.sessionCall("deploy.setActive", { id: "0x" + "cd".repeat(32), active: false }), /Start a session/);
});

test("pending and refused identities: no session, and every send is refused before signing - never the wallet", async () => {
  await ID.selectAccountIdentity(profile);
  rec("0x01", SAFE); localStorage.setItem(accountKey(SAFE), "0x01");
  reset();                                                              // a new page: stored, not yet re-verified
  assert.equal(ID.currentIdentity().state, "pending");
  assert.equal(await S.currentSession(), null);
  await assert.rejects(S.ledgerSend(setActive, walletNeverCalled), /still being checked on chain; nothing was sent/);
  verdict = "mismatch";
  await ID.ensureIdentity();
  assert.equal(ID.currentIdentity().state, "refused");
  await assert.rejects(S.ledgerSend(setActive, walletNeverCalled), /is not verified .*nothing was sent/);
  await assert.rejects(S.ownerOp({ op: "revokeAll", withdraw: false }), /is not verified/);
  await assert.rejects(S.accountFund({ id: "0x" + "cd".repeat(32), amount6: 1n }), /is not verified/);
  await assert.rejects(S.setAccountDelegation(true), /is not verified/);
  await assert.rejects(S.safeExecute({ to: "0x" + "22".repeat(20), data: "0x" }), /is not verified/);
});

test("a verified account never hands a ledger call it cannot make to the wallet", async () => {
  await ID.selectAccountIdentity(profile);
  await assert.rejects(S.ledgerSend("0xdeadbeef", walletNeverCalled), /not one your passkey account can make from here; nothing was sent/);
});

test("starting a session: the account needs a gas payer connected; the wallet's own sign-in is refused under the account", async () => {
  await ID.selectAccountIdentity(profile);
  await assert.rejects(S.startSession({ budgetUsd: 0 }), /Connect a wallet first/);
});

test("an identity change drops the cached session at once", async () => {
  await ID.selectAccountIdentity(profile);
  rec("0x01", SAFE); rec("0x03", WALLET);
  localStorage.setItem(accountKey(SAFE), "0x01"); localStorage.setItem("enclave_wallet_session", "0x03");
  assert.equal((await S.currentSession()).owner, SAFE);
  ID.useWalletIdentity();                                               // announces enclave:identity: sessions.js listens
  assert.equal((await S.currentSession()).owner, WALLET, "the wallet's session, not the cached account one");
  assert.equal(localStorage.getItem(accountKey(SAFE)), "0x01", "the account's pointer is kept for when it is selected again");
});
