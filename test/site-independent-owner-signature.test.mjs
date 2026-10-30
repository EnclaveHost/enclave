// Contract-account (ERC-1271) session owners in the independent browser (site/js/core/owner-signature.js): the exact factory
// call the SDK prepares is simulated at an agreed block, so the vault's own ECDSA/ERC-1271 check (and USDC's, for a
// deposit) decides; ERC-6492 signatures are refused up front; the owner's kind comes from agreed code; and the dashboard
// sign-in and /grant check before anything is submitted or handed to the CLI.
//   run: node --test test/site-independent-owner-signature.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeAbiParameters, decodeFunctionData } from "viem";
import * as SDK from "../sdk/sessions/dist/node.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY = "0x" + "55".repeat(20), VAULT = "0x" + "88".repeat(20), USDC = "0x" + "66".repeat(20);
const OWNER = "0x" + "a1".repeat(20);
let OS;
test.before(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.location ??= { hostname: "localhost" };
  OS = await import(pathToFileURL(path.join(REPO, "site/js/core/owner-signature.js")).href);
});

/* a scripted agreed reader: the code it reports, and the outcome of the simulated call */
function reader({ code = "0x", call = async () => "0x" + "00".repeat(64) } = {}){
  const seen = { snapshots: 0, codes: [], calls: [] };
  return { seen, snapshot: async () => { seen.snapshots++; return { number: 4242, hash: "0x" + "12".repeat(32) }; },
    code: async (snap, a) => { seen.codes.push([snap.number, a]); return code; },
    call: async (snap, to, data) => { seen.calls.push([snap.number, to, data]); return call(to, data); } };
}
const pc = { getChainId: async () => 8453, readContract: async ({ functionName }) => { assert.equal(functionName, "vaultFor"); return VAULT; } };
const grant = (budget = 0n) => SDK.buildGrant({ preset: "browser", label: "test", sessionKey: "0x" + "5a".repeat(32), policy: { budget, expiresIn: 3600 } });

test("owner kind from agreed code: EOA, EIP-7702-delegated EOA, contract account", async () => {
  assert.deepEqual(OS.kindOfCode("0x"), { kind: "eoa" });
  assert.deepEqual(OS.kindOfCode("0xef0100" + "cd".repeat(20)), { kind: "delegated-eoa", delegate: "0x" + "cd".repeat(20) });
  assert.deepEqual(OS.kindOfCode("0x6080604052"), { kind: "contract" });
  assert.deepEqual(OS.kindOfCode("0xef0100" + "cd".repeat(19)), { kind: "contract" }, "a malformed designator is code, not a delegation");
  const r = reader({ code: "0x6080" });
  assert.deepEqual(await OS.ownerAccountKind(OWNER, { reader: r }), { kind: "contract", block: 4242 });
  assert.match(OS.describeOwnerKind({ kind: "contract" }), /ERC-1271 rules decide/);
  await assert.rejects(OS.ownerAccountKind("0x1234", { reader: r }), /owner address/);
});

test("an ERC-1271 owner's signature rides the SDK's exact openFor, and the simulation is of exactly those bytes", async () => {
  // a contract account's signature: arbitrary bytes the account's isValidSignature understands (here 2 x 32 + more)
  const sig1271 = "0x" + "c0".repeat(32) + "de".repeat(64) + "01";
  const rec = OS.recordingSigner({ address: OWNER, signTypedData: async () => sig1271 });
  const prep = await SDK.prepareSessionOpen({ publicClient: pc, factory: FACTORY, owner: rec.signer, chainId: 8453, grant: grant() });
  assert.deepEqual(rec.signatures, [sig1271], "the grant signature was recorded");
  const decoded = decodeFunctionData({ abi: SDK.sessionVaultFactoryAbi, data: prep.data });
  assert.equal(decoded.functionName, "openFor"); assert.equal(decoded.args[2], sig1271);
  const r = reader({ code: "0x6080604052" });
  const out = await OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: rec.signatures }, { reader: r });
  assert.equal(out.kind, "contract"); assert.equal(out.block, 4242);
  assert.deepEqual(r.seen.calls, [[4242, FACTORY, prep.data]], "one agreed eth_call of the very calldata that would be submitted");
  assert.deepEqual(r.seen.codes, [[4242, OWNER]], "the owner's kind is read at the same block");
});

test("a funded grant records both owner signatures (grant and USDC authorization) and checks them in one simulation", async () => {
  let n = 0;
  const rec = OS.recordingSigner({ address: OWNER, signTypedData: async (td) => "0x" + (td.primaryType === "SessionGrant" ? "aa" : "bb").repeat(70) + String(n++).padStart(2, "0") });
  const usdc = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC };
  const prep = await SDK.prepareSessionOpen({ publicClient: pc, factory: FACTORY, owner: rec.signer, chainId: 8453, grant: grant(2_000_000n), usdc });
  assert.equal(rec.signatures.length, 2);
  assert.equal(decodeFunctionData({ abi: SDK.sessionVaultFactoryAbi, data: prep.data }).functionName, "openWithDepositFor");
  const r = reader({ code: "0x60" });
  await OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: rec.signatures }, { reader: r });
  assert.equal(r.seen.calls.length, 1);
});

test("refusals: an agreed revert (EOA and contract wording), no agreement, an ERC-6492 signature (before any read)", async () => {
  const prep = await SDK.prepareSessionOpen({ publicClient: pc, factory: FACTORY, chainId: 8453, grant: grant(),
    owner: { address: OWNER, signTypedData: async () => "0x" + "11".repeat(65) } });
  const revert = async () => { const e = new Error("the contract call reverted"); e.revert = true; throw e; };
  await assert.rejects(OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: [] }, { reader: reader({ code: "0x", call: revert }) }),
    (e) => e.name === "OwnerSignatureError" && e.code === "refused" && e.kind === "eoa" && /not this wallet's over exactly this request/.test(e.message));
  await assert.rejects(OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: [] }, { reader: reader({ code: "0x6080", call: revert }) }),
    (e) => e.code === "refused" && e.kind === "contract" && /did not accept the signature through ERC-1271/.test(e.message) && /threshold/.test(e.message));
  await assert.rejects(OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: [] }, { reader: reader({ call: async () => { throw new Error("chain endpoints disagree on a contract read (1 agree, need 2)"); } }) }),
    (e) => e.code === "chain" && /did not agree/.test(e.message));
  // ERC-6492: abi.encode(factory, factoryCalldata, innerSig) || magic
  const wrapped = encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], ["0x" + "77".repeat(20), "0x1234", "0x" + "ab".repeat(65)]) + "6492".repeat(16);
  assert.equal(OS.isErc6492(wrapped), true); assert.equal(OS.isErc6492("0x" + "ab".repeat(65)), false); assert.equal(OS.isErc6492("6492".repeat(16)), false);
  const r = reader();
  await assert.rejects(OS.verifyOwnerSubmission({ prep, owner: OWNER, signatures: [wrapped] }, { reader: r }), (e) => e.code === "undeployed" && /deploy the account first/.test(e.message));
  assert.equal(r.seen.snapshots + r.seen.calls.length, 0, "refused before any chain read");
  await assert.rejects(OS.verifyOwnerSubmission({ prep: { to: "0x1", data: "0x" }, owner: OWNER }, { reader: r }), /prepared call/);
});

test("the dashboard sign-in and /grant check the owner signature before anything is submitted or handed over", () => {
  const sessions = fs.readFileSync(path.join(REPO, "site/js/core/sessions.js"), "utf8");
  const start = sessions.slice(sessions.indexOf("async function startDirectSession"), sessions.indexOf("async function startDirectSession") + 4000);
  assert.ok(start.indexOf("verifyOwnerSubmission") > 0 && start.indexOf("verifyOwnerSubmission") < start.indexOf("submitPrepared(prepared)"), "sign-in verifies before submitting");
  assert.match(start, /recordingSigner\(S\.ownerFromProvider/);
  const grantPage = fs.readFileSync(path.join(REPO, "site/js/pages/grant.js"), "utf8");
  const card = grantPage.slice(grantPage.indexOf("async function independentCard"));
  const signOnly = card.slice(card.indexOf('sign.addEventListener("click"'), card.indexOf('$("#grOpen").addEventListener'));
  assert.ok(signOnly.indexOf("verifyOwnerSubmission") > 0 && signOnly.indexOf("verifyOwnerSubmission") < signOnly.indexOf("gr-sig"), "sign-only hands a signature over only after the vault accepts it");
  const open = card.slice(card.indexOf('$("#grOpen").addEventListener'));
  assert.ok(open.indexOf("verifyOwnerSubmission") > 0 && open.indexOf("verifyOwnerSubmission") < open.indexOf("sendTx(prep.to"), "approve-and-open verifies before the transaction");
});
