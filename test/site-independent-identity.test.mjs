// site/js/core/identity.js rules without a chain: a passkey account becomes the dashboard identity only on an explicit,
// verified selection; a stored selection is re-verified on every load (pending until then, refused with the reason when it
// fails) and never falls back to the wallet; the session pointer is per identity. The chain verifiers are stand-ins here;
// the real ones run against the pinned deployed code in test/site-independent-passkey-ui.test.mjs.
//   run: node --test test/site-independent-identity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileNet = { format: "enclave-browser-profile", version: 1, chainId: 8453, rpcs: ["https://a.example", "https://b.example"], quorum: 2,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: "0x" + "11".repeat(20), deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
    proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
    sessionVaultFactory: "0x" + "55".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });

let ID, PA, AP, ls;
const SAFE = "0x" + "5a".repeat(20), WALLET = "0x" + "9e".repeat(20);
const pk = { kind: "passkey", signer: "0x" + "aa".repeat(20), x: "0x" + "aa".repeat(32), y: "0x" + "ab".repeat(32), verifiers: String(0x100n << 160n),
  credentialId: Buffer.from("credential-aa").toString("base64url"), rpId: "localhost", label: "laptop" };
const rk = { kind: "key", address: "0x" + "cc".repeat(20), label: "recovery 1" };
const account = (over = {}) => ({ v: 1, provider: "safe-passkey", chainId: 8453, safe: SAFE, saltNonce: "7", threshold: 1, transport: null, owners: [pk, rk], ...over });

// the chain as the stand-ins report it; each test edits it
let chain, snapshots, seen;
const SUPPORTED_ENTRYPOINT = viem.toFunctionSelector("SUPPORTED_ENTRYPOINT()");
const reader = { snapshot: async () => { snapshots++; if (chain.quorumDown) throw new Error("chain endpoints disagree"); return { number: 1234, hash: "0x" + "bb".repeat(32) }; },
  call: async (snap, to, data) => data === SUPPORTED_ENTRYPOINT ? viem.pad(chain.entryPoint, { size: 32 }) : "0x", code: async () => "0x" };
function deps(){
  const pins = AP.PROVIDERS["safe-passkey"].contracts;
  return {
    PA: { verifyAccountProfile: async (p, { reader: r }) => { seen.push(await r.snapshot()); if (chain.mismatch) throw new PA.AccountError(chain.mismatch, { code: "mismatch" }); return { ok: true, deployed: chain.deployed, block: 1234 }; } },
    AP: { identifyAccount: async (a, { reader: r }) => { seen.push(await r.snapshot());
      return { address: a.toLowerCase(), provider: chain.provider, recognized: chain.recognized, threshold: chain.threshold,
        owners: chain.owners, modules: chain.modules, guard: chain.guard, fallbackHandler: chain.handler || pins.safe4337Module.address, warnings: ["Threshold 1: any single owner can act alone."] }; } },
  };
}
const healthy = () => ({ entryPoint: AP.PROVIDERS["safe-passkey"].contracts.entryPoint.address, deployed: true, provider: "safe-passkey", recognized: true, threshold: 1, guard: "0x" + "00".repeat(20), handler: null, mismatch: null, quorumDown: false,
  owners: [{ kind: "passkey", address: pk.signer }, { kind: "eoa", address: rk.address }], modules: [{ address: AP.PROVIDERS["safe-passkey"].contracts.safe4337Module.address, known: true }] });
let events;
const reset = () => { chain = healthy(); snapshots = 0; seen = []; events = []; ID._setForTests({ ls, reader, emit: (s) => events.push(s), deps: deps() }); };

test.before(async () => {
  const text = JSON.stringify(profileNet);
  ls = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.localStorage = ls; globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost" };
  ID = await import(pathToFileURL(path.join(REPO, "site/js/core/identity.js")).href);
  PA = await import(pathToFileURL(path.join(REPO, "site/js/core/passkey-account.js")).href);
  AP = await import(pathToFileURL(path.join(REPO, "site/js/core/account-providers.js")).href);
  PA._useLibForTests({ ...viem, WebAuthnP256 });
  const C = await import(pathToFileURL(path.join(REPO, "site/js/core/config.js")).href);
  assert.equal(C.INDEPENDENT.state, "on");
});
test.beforeEach(() => { ls.removeItem(ID.IDENTITY_PREFIX + 8453); ls.removeItem(PA.PROFILE_PREFIX + 8453); reset(); });

test("nothing is selected by default: the wallet is the identity and acts for itself", async () => {
  assert.equal(ID.currentIdentity().kind, "wallet");
  assert.equal(ID.actingOwner(WALLET), WALLET);
  assert.equal(ID.actingOwner(null), null);
  assert.equal(ID.identityKey(), "");
  assert.equal((await ID.ensureIdentity()).kind, "wallet");
  assert.equal(snapshots, 0, "no chain read without a selection");
});

test("an explicit, verified selection makes the Safe the owner; the wallet becomes a payer only", async () => {
  const s = await ID.selectAccountIdentity(account());
  assert.equal(s.state, "verified"); assert.equal(s.safe, SAFE); assert.equal(s.block, 1234);
  assert.equal(ID.actingOwner(WALLET), SAFE, "the connected wallet is never the acting owner of an account identity");
  assert.equal(ID.identityKey(), "safe:" + SAFE);
  assert.deepEqual(JSON.parse(ls.getItem(ID.IDENTITY_PREFIX + 8453)), { kind: "account", safe: SAFE, block: 1234 });
  assert.equal(events.length, 1); assert.equal(events[0].safe, SAFE);
  assert.equal(snapshots, 1, "every check reads ONE agreed block");
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1], "the profile check and the account recognition share that block");
  assert.equal(ID.identityProfile().safe, SAFE);
});

test("selection is refused, and nothing stored, for an undeployed, unrecognized, mismatching or warned account", async () => {
  const pins = AP.PROVIDERS["safe-passkey"].contracts;
  for (const [edit, re] of [
    [{ deployed: false }, /not deployed yet/],
    [{ provider: "safe-unrecognized" }, /not a Safe on the pinned singleton/],
    [{ recognized: false }, /not a Safe on the pinned singleton/],
    [{ modules: [{ address: pins.safe4337Module.address, known: true }, { address: "0x" + "de".repeat(20), known: false }] }, /module 0xdede.* is enabled/],
    [{ guard: "0x" + "ee".repeat(20) }, /guard 0xeeee.* is set/],
    [{ handler: "0x" + "fa".repeat(20) }, /fallback handler .* is not a pinned handler/],
    [{ threshold: 2 }, /owners or threshold on chain/],
    [{ owners: [{ kind: "passkey", address: pk.signer }, { kind: "eoa", address: "0x" + "dd".repeat(20) }] }, /owners or threshold on chain/],
    [{ owners: [{ kind: "contract", address: pk.signer }, { kind: "eoa", address: rk.address }] }, /not a recognized passkey signer/],
    [{ mismatch: "passkey laptop does not derive signer" }, /does not derive signer/],
    [{ quorumDown: true }, /agreed block/],
    [{ entryPoint: "0x" + "e7".repeat(20) }, /4337 module names EntryPoint 0xe7e7.*not the pinned/],
  ]){
    reset(); Object.assign(chain, edit);
    await assert.rejects(ID.selectAccountIdentity(account()), (e) => e.identityRefused && re.test(e.message), JSON.stringify(edit));
    assert.equal(ls.getItem(ID.IDENTITY_PREFIX + 8453), null, "nothing stored: " + JSON.stringify(edit));
    assert.equal(ID.currentIdentity().kind, "wallet");
  }
  reset();
  await assert.rejects(ID.selectAccountIdentity(account({ chainId: 1 })), /invalid|chain/);
  await assert.rejects(ID.selectAccountIdentity({ ...account(), extra: 1 }), /invalid/);
});

test("a stored selection is pending on load, re-verified, and refused with the reason - never the wallet", async () => {
  await ID.selectAccountIdentity(account());
  PA.saveAccountProfile(account(), ls);
  // a new page load
  reset();
  assert.deepEqual([ID.currentIdentity().kind, ID.currentIdentity().state], ["account", "pending"]);
  assert.equal(ID.actingOwner(WALLET), null, "pending: nobody acts, and not the wallet");
  assert.equal(ID.identityKey(), "safe:" + SAFE);
  const v = await ID.ensureIdentity();
  assert.equal(v.state, "verified"); assert.equal(ID.actingOwner(WALLET), SAFE); assert.equal(events.length, 1);
  // the owners changed on chain since: refused, with the reason, and it stays so
  reset(); chain.threshold = 2;
  const r = await ID.ensureIdentity();
  assert.equal(r.state, "refused"); assert.match(r.reason, /owners or threshold on chain/); assert.equal(r.retryable, false);
  assert.equal(ID.actingOwner(WALLET), null);
  const before = snapshots; await ID.ensureIdentity(); assert.equal(snapshots, before, "a definite refusal is not re-read in a loop");
  // a transient disagreement is retried on the next call
  reset(); chain.quorumDown = true;
  const t = await ID.ensureIdentity();
  assert.equal(t.state, "refused"); assert.equal(t.retryable, true); assert.equal(ID.actingOwner(WALLET), null);
  chain.quorumDown = false;
  assert.equal((await ID.ensureIdentity()).state, "verified");
});

test("a missing or different account description refuses the stored selection", async () => {
  await ID.selectAccountIdentity(account());
  reset();
  assert.match((await ID.ensureIdentity()).reason, /no longer has the account's description/);
  PA.saveAccountProfile(account({ safe: "0x" + "5b".repeat(20) }), ls);
  reset();
  assert.match((await ID.ensureIdentity()).reason, /is for 0x5b5b.*not the selected/);
});

test("'use my connected wallet' restores the wallet identity; session pointers are per identity", async () => {
  await ID.selectAccountIdentity(account());
  ID.useWalletIdentity();
  assert.equal(ID.currentIdentity().kind, "wallet"); assert.equal(ls.getItem(ID.IDENTITY_PREFIX + 8453), null);
  assert.equal(ID.actingOwner(WALLET), WALLET); assert.equal(events.at(-1).kind, "wallet");
  const a = ID.accountSessionKey(8453, SAFE), b = ID.accountSessionKey(8453, "0x" + "5b".repeat(20));
  assert.notEqual(a, b); assert.notEqual(a, "enclave_wallet_session");
  assert.equal(a, "enclave_account_session:8453:" + SAFE);
  assert.equal(ID.accountSessionKey(8453, SAFE.toUpperCase().replace("0X", "0x")), a, "case-insensitive");
});

test("a planted or malformed stored selection is not an identity", () => {
  ls.setItem(ID.IDENTITY_PREFIX + 8453, "{not json"); reset(); assert.equal(ID.currentIdentity().kind, "wallet");
  ls.setItem(ID.IDENTITY_PREFIX + 8453, JSON.stringify({ kind: "account", safe: "nope" })); reset(); assert.equal(ID.currentIdentity().kind, "wallet");
  ls.setItem(ID.IDENTITY_PREFIX + 8453, JSON.stringify({ kind: "account", safe: SAFE })); reset();
  assert.equal(ID.currentIdentity().state, "pending", "a well-formed one still verifies before it acts");
  assert.equal(ID.actingOwner(WALLET), null);
});

test("a shared-signer passkey counts only with exactly its key configured in this Safe's storage", async () => {
  const SH = AP.PROVIDERS["safe-passkey"].contracts.webauthnSharedSigner.address;
  const shared = { ...pk, signer: SH, shared: true };
  const prof = account({ owners: [shared, rk] });
  chain.owners = [{ kind: "passkey", address: SH, via: "shared signer", x: pk.x, y: pk.y, configured: true }, { kind: "eoa", address: rk.address }];
  assert.equal((await ID.selectAccountIdentity(prof)).state, "verified");
  for (const w of [{ x: "0x" + "ac".repeat(32), y: pk.y, configured: true }, { x: pk.x, y: pk.y, configured: false }]){
    reset();
    chain.owners = [{ kind: "passkey", address: SH, via: "shared signer", ...w }, { kind: "eoa", address: rk.address }];
    await assert.rejects(ID.selectAccountIdentity(prof), /configured for this account's shared signer is not laptop/);
  }
  // a profile may not claim a shared passkey at another address, or two of them
  assert.throws(() => PA.validateAccountProfile(account({ owners: [{ ...pk, shared: true }, rk] })), /pinned shared signer/);
});
