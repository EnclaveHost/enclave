// wallet-owned-session-create-r1: AUTHORED, NOT RUN. Drives the REAL consumers (relay/sessions.mjs createCustodyGate +
// sessionRowRefusal, windows/node/session-api-auth.mjs refusal) through the ONE resolver (relay/wallet-session-policy.mjs)
// over an INERT in-memory chain fixture. Proves nothing about Base, a live host, attestation hardware or a browser.
// The custodyRefusal tested here is the function relay/secrets.js, relay/secrets-release.mjs and relay/shield-secrets.mjs
// receive from api-relay.js (ctx.custodyRefusal / the custodyRefusal option).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, getAddress } from "viem";
import { createCustodyGate, sessionRowRefusal } from "../../relay/sessions.mjs";
import { createSessionApiAuth } from "../../windows/node/session-api-auth.mjs";
import { createWalletPolicyResolver, contentHash, walletPinsFromEnv, WALLET_SESSION_PROTOCOL, WALLET_SESSION_VERSION }
  from "../../relay/wallet-session-policy.mjs";

const A = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const ZERO = "0x0000000000000000000000000000000000000000";
// >>> [wallet-owned-session-repair-r2 FIXTURE ADAPTATION - visible, assertion bodies unchanged] r1 had VAULT = A(0xa17) and
// FACTORY_CODE = "0x60016002"; the resolver now authenticates the row's birth (Created log + receipt + reviewed code
// template + CREATE/CREATE2 derivation), so VAULT and FACTORY_CODE come from the INERT synthetic protocol fixture and
// the chain fixture gains getBlock/getLogs/getTransactionReceipt plus a code map. ID was born by VAULT's deploy.create,
// ID_LEGACY by WALLET's own ledger.create (registered below).
import { fixtureProtocol } from "./fixture-protocol.mjs";
const FACTORY = A(0xfac), LEDGER = A(0x1ed), WALLET = A(0x0e1), OTHER = A(0x0e2), LEGACY_VAULT = A(0x01d);
const P = fixtureProtocol({ factory: FACTORY, ledger: LEDGER });
const VAULT = P.vaultFor(WALLET);
const FACTORY_CODE = P.codes.factory;
// <<< fixture adaptation
const PIN = { factory: FACTORY, codeHash: keccak256(FACTORY_CODE) };
const APP = "0x" + "ab".repeat(32), APP_B = "0x" + "cd".repeat(32);
const REF = `catalog://${APP}/0`, REF_B = `catalog://${APP_B}/0`;
const ID = "0x" + "11".repeat(32), ID_LEGACY = "0x" + "22".repeat(32);

P.births.vault(ID, VAULT, WALLET); P.births.eoa(ID_LEGACY, WALLET);   // [r2 fixture] the rows' authenticated births

// inert chain fixture: only the reads the resolver/consumers make
function chain() {
  const st = { creator: { [ID]: VAULT }, policy: { [ID]: { env: 1, state: 1, revision: 1n, approved: "0x" + "00".repeat(32), createdBy: "0x" + "33".repeat(32) } },
    fail: false };
  const pc = {
    st,
    async getChainId() { return 8453; },
    async getCode({ address }) { if (st.fail) throw new Error("rpc down"); return P.codeAt(address); },   // [r2 fixture] code map
    async getStorageAt() { return "0x0"; },
    async call() { throw Object.assign(new Error("execution reverted"), { name: "ExecutionRevertedError" }); },
    async readContract({ address, functionName, args }) {
      if (st.fail) throw new Error("rpc down");
      const a = getAddress(address);
      if (a === FACTORY) {
        if (functionName === "PROTOCOL") return WALLET_SESSION_PROTOCOL;
        if (functionName === "ledger") return LEDGER;
        if (functionName === "creatorOf") return st.creator[args[0]] ?? ZERO;
        if (functionName === "isVault") return getAddress(args[0]) === VAULT;
      }
      if (a === VAULT && functionName === "owner") return WALLET;
      if (a === VAULT && functionName === "policyOf") return st.policy[args[0]];
      if (functionName === "isVault") return false;      // legacy factories know none of these
      throw new Error(`fixture: unexpected ${functionName} on ${a}`);
    },
  };
  return P.install(pc);   // [r2 fixture] + getBlock / getLogs / getTransactionReceipt
}
// [r2 fixture] + the fixture's reviewed-template manifest (production: the root-generated relay/wallet-session-protocol.mjs)
const resolver = (pc, pins = [PIN]) => createWalletPolicyResolver({ pc, chainId: 8453, ledger: () => LEDGER, pins, manifest: P.manifest });
const row = (o = {}) => ({ id: ID, owner: WALLET, appRef: REF, configCid: "", ...o });
const walletSession = (o = {}) => ({ vault: VAULT, owner: WALLET, envs: 1, anyApp: false, apps: [APP], version: WALLET_SESSION_VERSION, ...o });

test("resolver refuses implicit configuration and malformed pins", () => {
  assert.throws(() => createWalletPolicyResolver({ pc: chain(), chainId: 8453, ledger: () => LEDGER }), /explicitly/);
  assert.throws(() => walletPinsFromEnv({ WALLET_SESSIONS_PINS: "0x12:nope" }), /not 0x<factory>/);
  assert.deepEqual(walletPinsFromEnv({}), []);
});

test("STAGING created row: relay custody gate releases, relay + host session rule allow the scoped wallet-v1 session", async () => {
  const pc = chain(), wp = resolver(pc);
  const gate = createCustodyGate({ pc, book: null, factory: A(0xbeef), walletPolicy: wp });
  assert.equal(await gate.custodyRefusal(row()), null);
  assert.equal(await sessionRowRefusal(walletSession(), row(), async () => 0, wp), null);
  const host = createSessionApiAuth({ pc, bases: () => [], factories: [], walletPolicy: wp });
  assert.equal(await host.refusal(walletSession(), row()), null);
});

test("PROD stays refused until the owner approves the exact content; drift and re-environment refuse again", async () => {
  const pc = chain(), wp = resolver(pc);
  const gate = createCustodyGate({ pc, book: null, factory: A(0xbeef), walletPolicy: wp });
  pc.st.policy[ID] = { ...pc.st.policy[ID], env: 2 };
  assert.match(await gate.custodyRefusal(row()), /not been approved/);
  pc.st.policy[ID] = { ...pc.st.policy[ID], approved: contentHash(REF, ""), revision: 2n };
  assert.equal(await gate.custodyRefusal(row()), null, "owner-promoted PROD releases");
  assert.match(await gate.custodyRefusal(row({ configCid: "bafy-drift" })), /not been approved/, "content drift");
  // a staging-only session does not reach the prod row; a prod one does
  assert.match(await sessionRowRefusal(walletSession(), row(), async () => 0, wp), /production/);
  assert.equal(await sessionRowRefusal(walletSession({ envs: 3 }), row(), async () => 0, wp), null);
});

test("scope: app B, another vault, another owner, a legacy session on a bound row", async () => {
  const pc = chain(), wp = resolver(pc);
  assert.match(await sessionRowRefusal(walletSession(), row({ appRef: REF_B }), async () => 0, wp), /apps/);
  assert.match(await sessionRowRefusal(walletSession({ vault: A(0xa18) }), row(), async () => 0, wp), /another session vault/);
  assert.match(await sessionRowRefusal(walletSession({ owner: OTHER }), row(), async () => 0, wp), /does not belong/);
  const legacy = { vault: LEGACY_VAULT, owner: WALLET, envs: 3, anyApp: true, apps: [] };
  assert.match(await sessionRowRefusal(legacy, row(), async () => 0, wp), /wallet-session vault/);
  const host = createSessionApiAuth({ pc, bases: () => [], factories: [], walletPolicy: wp });
  assert.match(await host.refusal(walletSession(), row({ appRef: REF_B })), /apps/);
  assert.match(await host.refusal(legacy, row()), /wallet-session vault/);
});

test("owner detach / transfer away: sessions lose it; secrets follow the plain-wallet rule (explicit owner decisions)", async () => {
  const pc = chain(), wp = resolver(pc);
  const gate = createCustodyGate({ pc, book: null, factory: A(0xbeef), walletPolicy: wp });
  pc.st.policy[ID] = { ...pc.st.policy[ID], env: 2, approved: contentHash(REF, ""), revision: 2n };
  pc.st.policy[ID] = { env: 0, state: 2, revision: 3n, approved: "0x" + "00".repeat(32), createdBy: pc.st.policy[ID].createdBy };
  assert.match(await sessionRowRefusal(walletSession({ envs: 3 }), row(), async () => 0, wp), /detached/);
  assert.equal(await gate.custodyRefusal(row()), null);
  assert.equal((await wp.resolve(row({ owner: OTHER }))).kind, "void");
});

test("missing / unreadable policy never downgrades to legacy", async () => {
  const pc = chain(), wp = resolver(pc);
  const gate = createCustodyGate({ pc, book: null, factory: A(0xbeef), walletPolicy: wp });
  pc.st.fail = true;
  await assert.rejects(gate.custodyRefusal(row()), /rpc down/);
  await assert.rejects(sessionRowRefusal(walletSession(), row(), async () => 0, wp), /rpc down/);
  const host = createSessionApiAuth({ pc, bases: () => [], factories: [], walletPolicy: wp });
  await assert.rejects(host.refusal(walletSession(), row()), (e) => e.status === 503);
  pc.st.fail = false;
  pc.st.policy[ID] = { env: 0, state: 0, revision: 0n, approved: "0x" + "00".repeat(32), createdBy: "0x" + "00".repeat(32) };
  assert.match(await gate.custodyRefusal(row()), /unreadable/, "creator named but no binding: invalid, refused");
  // a wrong code hash pin is an error, never "legacy-unbound"
  const bad = resolver(chain(), [{ factory: FACTORY, codeHash: "0x" + "00".repeat(32) }]);
  await assert.rejects(bad.resolve(row()), /not the reviewed factory/);
});

test("proven legacy-unbound wallet row keeps legacy behaviour; wallet-v1 session never acts on it", async () => {
  const pc = chain(), wp = resolver(pc);
  const gate = createCustodyGate({ pc, book: null, factory: A(0xbeef), walletPolicy: wp });
  const legacyRow = row({ id: ID_LEGACY });
  assert.equal((await wp.resolve(legacyRow)).kind, "legacy-unbound");
  assert.equal(await gate.custodyRefusal(legacyRow), null);
  assert.match(await sessionRowRefusal(walletSession({ anyApp: true }), legacyRow, async () => 0, wp), /not created under/);
  // the legacy prod rule for a legacy session on a legacy wallet row is unchanged
  const legacy = { vault: LEGACY_VAULT, owner: WALLET, envs: 1, anyApp: true, apps: [] };
  assert.match(await sessionRowRefusal(legacy, legacyRow, async () => 0, wp), /production \(wallet-held\)/);
});

// ROOT independent requirements, appended to a COPY of unchanged author tests/fixtures.
test("ROOT omitted factory configuration must not release unapproved wallet-session PROD secrets", async () => {
 const pc=chain(); pc.st.policy[ID]={...pc.st.policy[ID],env:2};
 const wp=resolver(pc,[]), gate=createCustodyGate({pc,book:null,factory:A(0xbeef),walletPolicy:wp});
 assert.notEqual(await gate.custodyRefusal(row()),null,"missing factory configuration is not proof a row has no content policy");
});
test("ROOT incomplete configured factory list must not prove a foreign new row legacy", async () => {
 const pc=chain(); pc.st.policy[ID]={...pc.st.policy[ID],env:2};
 const read=pc.readContract.bind(pc);
 pc.readContract=async q => q.functionName==='creatorOf' ? ZERO : read(q);
 const wp=resolver(pc), gate=createCustodyGate({pc,book:null,factory:A(0xbeef),walletPolicy:wp});
 assert.notEqual(await gate.custodyRefusal(row()),null,"absence from one configured registry is not exhaustive provenance");
});
test("ROOT a cached factory verification must not survive a changed chain identity", async () => {
 const pc=chain();let actualChain=8453;pc.getChainId=async()=>actualChain;const wp=resolver(pc);
 await wp.resolve(row());actualChain=1;
 await assert.rejects(wp.resolve(row()),/chain/,"fresh decisions must be bound to the configured chain");
});
