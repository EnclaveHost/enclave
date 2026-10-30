// wallet-owned-session-repair-r2: AUTHORED, NOT RUN. Focused cases for authenticated birth discovery, owner continuity,
// chain/block consistency, fail-closed construction and packaging, over the INERT synthetic protocol fixture
// (fixture-protocol.mjs). Independent of the 7 authored + 3 root cases (no overlap counted). Proves nothing about Base,
// real bytecode (the manifest here is synthetic), a live host or secret transmission through the release handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, toHex } from "viem";
import { createCustodyGate, sessionRowRefusal } from "../../relay/sessions.mjs";
import { createWalletPolicyResolver, walletSecretRefusal, createHostWalletPolicy, refusingWalletPolicy, WALLET_SESSION_PROTOCOL }
  from "../../relay/wallet-session-policy.mjs";
import { loadShippedManifest } from "../../relay/wallet-session-manifest.mjs";
import { closure } from "../../windows/node/deploy-files.mjs";
import { fixtureProtocol } from "./fixture-protocol.mjs";

const A = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const FACTORY = A(0xfac), LEDGER = A(0x1ed), WALLET = A(0x0e1), OTHER = A(0x0e2);
const APP = "0x" + "ab".repeat(32), REF = `catalog://${APP}/0`, Z = "0x" + "00".repeat(32);
const id = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function mk({ manifest = true, isLegacyVault = null, ledger = LEDGER } = {}) {
  const P = fixtureProtocol({ factory: FACTORY, ledger: LEDGER });
  const VAULT = P.vaultFor(WALLET);
  const st = { chain: 8453, creator: {}, policy: {}, vaults: new Set([VAULT]) };
  const pc = P.install({
    st, chain: { id: 8453 },
    async getChainId() { return typeof st.chain === "function" ? st.chain() : st.chain; },
    async getCode({ address }) { return P.codeAt(address); },
    async readContract({ address, functionName, args }) {
      const a = getAddress(address);
      if (a === FACTORY && functionName === "PROTOCOL") return WALLET_SESSION_PROTOCOL;
      if (a === FACTORY && functionName === "ledger") return LEDGER;
      if (a === FACTORY && functionName === "creatorOf") return st.creator[args[0]] ?? A(0);
      if (functionName === "isVault") return a === FACTORY && st.vaults.has(getAddress(args[0]));
      if (a === VAULT && functionName === "owner") return WALLET;
      if (a === VAULT && functionName === "policyOf") return st.policy[args[0]];
      throw new Error(`fixture: unexpected ${functionName} on ${a}`);
    },
  });
  const wp = createWalletPolicyResolver({ pc, chainId: 8453, ledger: () => ledger, pins: [], manifest: manifest ? P.manifest : null, isLegacyVault });
  const bind = (rid, env = 2, approved = Z, revision = 1n) => {
    P.births.vault(rid, VAULT, WALLET); st.creator[rid] = VAULT;
    st.policy[rid] = { env, state: 1, revision, approved, createdBy: "0x" + "33".repeat(32) };
  };
  return { P, VAULT, st, pc, wp, bind };
}
const row = (rid, o = {}) => ({ id: rid, owner: WALLET, appRef: REF, configCid: "", ...o });

test("no manifest: a vault-created PROD row is refused, never legacy; a wallet's own row stays legacy", async () => {
  const { P, wp, bind } = mk({ manifest: false });
  bind(id(1)); P.births.eoa(id(2), WALLET);
  const p = await wp.resolve(row(id(1)));
  assert.equal(p.kind, "invalid");
  assert.notEqual(walletSecretRefusal(p, row(id(1))), null);
  assert.equal((await wp.resolve(row(id(2)))).kind, "legacy-unbound");
});

test("import birth: Created.owner == wallet with verified wallet-session ancestry is refused; forged Bound is ignored", async () => {
  const { P, VAULT, wp, bind } = mk();
  bind(id(1));                                           // makes VAULT a live verified clone
  P.births.imported(id(3), WALLET); P.births.bound(VAULT, id(3), WALLET, 13n);
  const p = await wp.resolve(row(id(3)));
  assert.equal(p.kind, "invalid"); assert.match(p.reason, /ancestry/);
  P.births.imported(id(4), WALLET); P.births.bound(A(0xbad1), id(4), WALLET, 14n);   // an emitter with no reviewed code
  assert.equal((await wp.resolve(row(id(4)))).kind, "legacy-unbound");
});

test("misattributed create: a code-less creator that did not send the tx, an unknown contract, an unreviewed clone", async () => {
  const { P, wp } = mk();
  P.births.eoa(id(5), WALLET, 15n, OTHER);
  assert.match((await wp.resolve(row(id(5)))).reason, /did not send/);
  const C = A(0xc0de); P.extraCode.set(C, "0x6001600155"); P.births.eoa(id(6), C, 16n, C);
  assert.match((await wp.resolve(row(id(6)))).reason, /no reviewed protocol artifact/);
  const X = A(0xc10e); P.extraCode.set(X, P.clone(A(0x1234))); P.births.eoa(id(7), X, 17n, OTHER);
  assert.equal((await wp.resolve(row(id(7)))).kind, "invalid");
});

test("a row created by a vault of the EXISTING legacy factories keeps legacy behaviour (positive evidence)", async () => {
  const L = A(0x1e9a);
  const { P, wp } = mk({ isLegacyVault: async (a) => getAddress(a) === L });
  P.extraCode.set(L, "0x6002600255"); P.births.eoa(id(8), L, 18n, OTHER);
  assert.equal((await wp.resolve(row(id(8)))).kind, "legacy-unbound");
});

test("reorg of the birth block drops the cached birth; a head reorg or chain switch during a decision throws", async () => {
  const { P, st, pc, wp, bind } = mk();
  bind(id(1), 1);
  assert.equal((await wp.resolve(row(id(1)))).kind, "bound");
  P.hist.blocks.set(10n, keccak256(toHex("reorged-10")));
  await assert.rejects(wp.resolve(row(id(1))), /Created/);
  const m2 = mk(); m2.bind(id(1), 1);
  const gb = m2.pc.getBlock; let n = 0;
  m2.pc.getBlock = async (q) => { const b = await gb(q); return q?.blockNumber === 100n && ++n >= 1 ? { ...b, hash: keccak256(toHex("x")) } : b; };
  await assert.rejects(m2.wp.resolve(row(id(1))), /reorg/);
  const m3 = mk(); m3.bind(id(1), 1); let calls = 0;
  m3.st.chain = () => (++calls === 1 ? 8453 : 1);
  await assert.rejects(m3.wp.resolve(row(id(1))), /chain changed/);
  void st; void pc;
});

test("transfer away and back without a new owner decision is stale (secrets + sessions refuse); a later decision restores", async () => {
  const { P, VAULT, wp, bind } = mk();
  bind(id(9), 1);
  P.births.transfer(id(9), WALLET, OTHER, 20n); P.births.transfer(id(9), OTHER, WALLET, 21n);
  const gate = createCustodyGate({ pc: { getCode: async () => "0x", readContract: async () => false }, book: null, factory: A(0xbeef), walletPolicy: wp });
  const p = await wp.resolve(row(id(9)));
  assert.equal(p.kind, "stale");
  assert.match(await gate.custodyRefusal(row(id(9))), /came back/);
  const s = { vault: VAULT, owner: WALLET, envs: 3, anyApp: true, apps: [], version: "wallet-v1" };
  assert.match(await sessionRowRefusal(s, row(id(9)), async () => 0, wp), /came back/);
  P.births.policyChanged(VAULT, id(9), 22n);
  const q = await wp.resolve(row(id(9)));
  assert.equal(q.kind, "bound"); assert.equal(q.continuity, "redecided");
});

test("custodyDecision: the policy key changes with the owner's revision even while release stays allowed", async () => {
  const { st, wp, bind } = mk();
  bind(id(10), 1);
  const gate = createCustodyGate({ pc: { getCode: async () => "0x", readContract: async () => false }, book: null, factory: A(0xbeef), walletPolicy: wp });
  const a = await gate.custodyDecision(row(id(10)));
  st.policy[id(10)] = { ...st.policy[id(10)], revision: 2n };
  const b = await gate.custodyDecision(row(id(10)));
  assert.equal(a.why, null); assert.equal(b.why, null); assert.notEqual(a.policy, b.policy);
  const c = await gate.custodyDecision(row(id(10), { configCid: "bafy-other" }));
  assert.notEqual(b.policy, c.policy, "row content is part of the key");
});

test("factoryOfVault: a verified vault on this ledger; the same vault for a consumer of another ledger is not one", async () => {
  const { VAULT, wp, bind } = mk(); bind(id(1));
  assert.equal(await wp.factoryOfVault(VAULT), FACTORY);
  assert.equal(await wp.factoryOfVault(A(0xa18)), null);
  const other = mk({ ledger: A(0x2ed) }); other.bind(id(1));
  assert.equal(await other.wp.factoryOfVault(other.VAULT), null);
});

test("no resolver configured: custody gate and both session rules refuse wallet-held rows (no default-null bypass)", async () => {
  const gate = createCustodyGate({ pc: { getCode: async () => "0x", readContract: async () => false }, book: null, factory: A(0xbeef) });
  assert.match(await gate.custodyRefusal(row(id(1))), /not configured/);
  const legacy = { vault: A(0x01d), owner: WALLET, envs: 3, anyApp: true, apps: [] };
  assert.match(await sessionRowRefusal(legacy, row(id(1)), async () => 0, null), /not configured/);
});

test("construction: the shipped manifest is NOT generated (activation blocker); host constructor + refusing fallback", async () => {
  assert.equal(await loadShippedManifest(), null);
  await assert.rejects(createHostWalletPolicy({ pc: { getChainId: async () => 8453 }, ledger: () => LEDGER, legacyFactories: [], env: {} }), /configured chain/);
  const { pc } = mk();
  const wp = await createHostWalletPolicy({ pc, ledger: () => LEDGER, legacyFactories: [], env: {} });
  assert.equal(wp.manifestLoaded, false);
  await assert.rejects(refusingWalletPolicy("x").resolve(row(id(1))), /unavailable/);
});

test("packaging: the Windows import closure ships the three relay modules without a bare import; Dockerfile copies them", () => {
  const { files, problems } = closure({ root: ROOT });
  for (const f of ["relay/wallet-session-policy.mjs", "relay/wallet-session-manifest.mjs", "relay/wallet-session-protocol.mjs"])
    assert.ok(files.includes(f), `${f} in the node closure`);
  assert.deepEqual(problems.filter((p) => /wallet-session/.test(p)), []);
  const docker = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(docker, /COPY relay\/wallet-session-policy\.mjs relay\/wallet-session-manifest\.mjs relay\/wallet-session-protocol\.mjs \.\/relay\//);
});
