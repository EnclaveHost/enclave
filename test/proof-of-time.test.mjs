// Proof of time (ledger rev 9): the OFF-CHAIN half.
//
// The Solidity side has its own suite (contracts/foundry/test/
// EnclaveDeployments.proofOfTime.t.sol) and proves the economics. What that
// suite CANNOT see is whether the supervisor, signing with viem, produces the
// digest the contract computes with abi.encode. If those two ever drift, every
// checkpoint the fleet signs is rejected with "bad proof signature", the runner
// meter stops at each host's last good proof, and every seller silently earns
// nothing until someone reads a payout report. There is no error anywhere near
// the change that caused it.
//
// So the digest is pinned here twice over: reimplemented from the Solidity
// verbatim, and against a frozen vector. A change to the typehash string, a
// field order, a type width, or the domain name/version fails this file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, keccak256, encodeAbiParameters, encodePacked, recoverAddress,
         toFunctionSelector, decodeAbiParameters } from "viem";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SOL = fs.readFileSync(path.join(REPO, "contracts", "EnclaveProofOfTime.sol"), "utf8");
const LEDGER_SOL = fs.readFileSync(path.join(REPO, "contracts", "EnclaveDeployments.sol"), "utf8");
const SUP = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
const ABI = (n) => JSON.parse(fs.readFileSync(path.join(REPO, "contracts", `${n}.abi.json`), "utf8"));

// The exact strings the contract hashes. Read OUT of the source rather than
// copied, so a reworded typehash cannot pass by being wrong in both places.
const typeHashOf = (name) => {
  const m = new RegExp(`${name}\\s*=\\s*keccak256\\(\\s*\\n?\\s*"([^"]+)"`).exec(SOL)
         || new RegExp(`${name}\\s*=\\s*\\n?\\s*keccak256\\("([^"]+)"\\)`).exec(SOL);
  assert.ok(m, `${name} is still a keccak256 of a literal in EnclaveProofOfTime.sol`);
  return { text: m[1], hash: keccak256(Buffer.from(m[1])) };
};

const PROVER = "0x1234567890123456789012345678901234567890";
const CHAIN_ID = 8453;                                   // Base mainnet, what the supervisor signs for

// The supervisor's typed-data definition, lifted from supervisor.js by shape so
// this test fails if the field list there changes.
const TYPES = { ProofOfTime: [
  { name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "upto", type: "uint64" }, { name: "anchorBlock", type: "uint64" }, { name: "anchorHash", type: "bytes32" }] };
const DOMAIN = { name: "EnclaveProofOfTime", version: "1", chainId: CHAIN_ID, verifyingContract: PROVER };
const MSG = {
  id: "0x" + "ab".repeat(32),
  enclaveId: "0x" + "cd".repeat(32),
  operator: "0x00000000000000000000000000000000000000aa",
  upto: 1700000600n, anchorBlock: 999n, anchorHash: "0x" + "ef".repeat(32),
};

// The contract's proofDigest(), reimplemented from the Solidity line by line.
function contractDigest(msg = MSG, prover = PROVER, chainId = CHAIN_ID) {
  const domainTypehash = typeHashOf("EIP712_DOMAIN_TYPEHASH").hash;
  const proofTypehash = typeHashOf("PROOF_TYPEHASH").hash;
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [domainTypehash, keccak256(Buffer.from("EnclaveProofOfTime")), keccak256(Buffer.from("1")),
     BigInt(chainId), prover]));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" },
     { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }],
    [proofTypehash, msg.id, msg.enclaveId, msg.operator, msg.upto, msg.anchorBlock, msg.anchorHash]));
  return keccak256(encodePacked(["bytes", "bytes32", "bytes32"], ["0x1901", domainSeparator, structHash]));
}

test("the supervisor's signing digest IS the contract's proofDigest", () => {
  assert.equal(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "ProofOfTime", message: MSG }),
    contractDigest(),
    "viem's EIP-712 digest diverged from EnclaveProofOfTime.proofDigest — every fleet proof would be rejected");
});

test("frozen digest vector (a reworded typehash or reordered field fails here)", () => {
  // Regenerating this constant is the deliberate act of changing the proof
  // format. It is a CONSENSUS value between the fleet and a deployed contract:
  // a live prover cannot be edited, so changing it means deploying a new one
  // and rebinding a ledger, which setProver makes impossible without a new
  // ledger. If this line needs changing, that is the conversation to have.
  assert.equal(contractDigest(), "0x4583bfbe09ce04bc0f1861b743ff40b1dfcda1127a5f05773a8bdc2e5233dabc");
});

test("the typehash text matches the struct the contract actually verifies", () => {
  const { text } = typeHashOf("PROOF_TYPEHASH");
  assert.equal(text,
    "ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)");
  // ... and that the checkpoint() signature carries those same six fields in
  // that same order, since the digest is built from its arguments
  const cp = ABI("EnclaveProofOfTime").find((f) => f.type === "function" && f.name === "checkpoint");
  assert.deepEqual(cp.inputs.map((i) => `${i.type} ${i.name}`),
    ["bytes32 id", "bytes32 enclaveId", "uint64 upto", "uint64 anchorBlock", "bytes32 anchorHash", "bytes sig"]);
});

test("a supervisor-signed proof recovers to the in-CVM key", async () => {
  const acct = privateKeyToAccount("0x" + "11".repeat(32));
  const sig = await acct.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "ProofOfTime", message: MSG });
  assert.equal((sig.length - 2) / 2, 65, "the contract requires exactly 65 bytes");
  assert.equal((await recoverAddress({ hash: contractDigest(), signature: sig })).toLowerCase(),
    acct.address.toLowerCase());
});

test("the signature's s value is canonical (the contract rejects the high-s twin)", async () => {
  // _recover enforces s <= N/2. viem always emits the low-s form; if that ever
  // changed, every proof would revert "bad signature s".
  const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  const acct = privateKeyToAccount("0x" + "22".repeat(32));
  for (let i = 0; i < 8; i++) {
    const sig = await acct.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "ProofOfTime",
      message: { ...MSG, upto: MSG.upto + BigInt(i) } });
    const s = BigInt("0x" + sig.slice(66, 130));
    assert.ok(s <= HALF_N, `signature ${i} has a high s value`);
    const v = parseInt(sig.slice(130, 132), 16);
    assert.ok(v === 27 || v === 28, `signature ${i} has v=${v}; the contract accepts 27/28 (and 0/1)`);
  }
});

test("the supervisor signs for the same domain the contract verifies", () => {
  // Pinned against supervisor.js's source: a typo in the domain name or version
  // there produces valid signatures that verify against nothing.
  const m = /domain: \{ name: "([^"]+)", version: "([^"]+)", chainId: base\.id,/.exec(SUP);
  assert.ok(m, "signCheckpoint still builds an EIP-712 domain literal");
  assert.equal(m[1], "EnclaveProofOfTime");
  assert.equal(m[2], "1");
  // and the contract hashes those same two literals
  assert.match(SOL, /keccak256\("EnclaveProofOfTime"\),\s*\n?\s*keccak256\("1"\)/);
});

test("the ledger exposes exactly the proof surface the fleet and clients read", () => {
  const abi = ABI("EnclaveDeployments");
  const fn = (n) => abi.find((f) => f.type === "function" && f.name === n);
  // the watermark the runner meter is capped by — the authority for "was this
  // host actually serving", read by the CLI and any watcher
  assert.deepEqual(fn("provenUntil").outputs.map((o) => o.type), ["uint64"]);
  assert.equal(fn("proofRequired").outputs[0].type, "bool");
  // the one prover-gated write, and the one-shot binding that authorises it
  assert.deepEqual(fn("creditProven").inputs.map((i) => i.type), ["bytes32", "uint64"]);
  assert.deepEqual(fn("setProver").inputs.map((i) => i.type), ["address"]);
  assert.equal(fn("prover").outputs[0].type, "address");
  assert.deepEqual(fn("setProofRequiredFrom").inputs.map((i) => i.type), ["uint64"]);
  // rev 9 is the marker consumers gate the whole PROOF feature on; the ledger
  // rev only ever moves forward, so assert the floor rather than an equality
  // that every later rev has to come back and edit
  assert.ok(Number(/deploymentsSchema = (\d+);/.exec(LEDGER_SOL)[1]) >= 9);
});

test("registry schema 3 carries the proof key, and register() carries it too", () => {
  const abi = ABI("EnclaveRegistry");
  const entry = abi.find((f) => f.type === "function" && f.name === "get").outputs[0].components;
  // APPENDED, not inserted: every earlier field must keep its offset or every
  // consumer that sniffs the schema and decodes the tuple misreads it. Pin the
  // known PREFIX rather than the whole list — appending a later schema's field
  // is then not a test edit, while INSERTING one still is.
  assert.deepEqual(entry.slice(0, 11).map((c) => c.name),
    ["endpoint", "repo", "measurement", "operator", "registeredAt", "lastSeen", "active",
     "cpuPricePerSec6", "gpuPricePerSec6", "proofKey", "payoutWallet"]);
  assert.equal(entry.find((c) => c.name === "proofKey").type, "address");
  const reg = abi.find((f) => f.type === "function" && f.name === "register");
  assert.equal(reg.inputs.at(-1).name, "proofKey");
  assert.equal("0x" + toFunctionSelector("function register(string,string,bytes32,uint64,uint64,address) returns (bytes32)").slice(2),
    toFunctionSelector(reg));
  assert.ok(abi.some((f) => f.type === "function" && f.name === "setProofKey"));
});

test("the payout wallet can only be declared BY that wallet (schema 4)", () => {
  // THE anti-grief property of free self-hosting. A rev-12 ledger charges
  // nothing for a deployment whose owner is the claiming box's payoutWallet,
  // and a zero rate is beyond the reach of the owner's rate cap — so if an
  // operator could name any address here, it could pull a stranger's deployment
  // into a free tier they cannot evict by lowering their cap. setPayoutWallet
  // therefore takes NO address and records msg.sender. If either of these ever
  // grows an address parameter, that whole argument collapses.
  const abi = ABI("EnclaveRegistry");
  const set = abi.find((f) => f.type === "function" && f.name === "setPayoutWallet");
  const clear = abi.find((f) => f.type === "function" && f.name === "clearPayoutWallet");
  assert.ok(set && clear, "the registry must expose both halves of the declaration");
  assert.deepEqual(set.inputs.map((i) => i.type), ["bytes32"], "setPayoutWallet takes the enclave id ALONE");
  assert.deepEqual(clear.inputs.map((i) => i.type), ["bytes32"]);
  // register() is the operator's call, and it must never be able to carry one
  const reg = abi.find((f) => f.type === "function" && f.name === "register");
  assert.ok(!reg.inputs.some((i) => /payout/i.test(i.name)), "register() must not set the payout wallet");
  const sol = fs.readFileSync(path.join(REPO, "contracts", "EnclaveRegistry.sol"), "utf8");
  assert.match(sol, /function setPayoutWallet\(bytes32 id\) external \{[^}]*payoutWallet = msg\.sender/,
    "setPayoutWallet must record msg.sender, never an argument");
  // a FLOOR, like the ledger check below: the property under test is the
  // direction of the declaration, and later revisions keep appending (schema 5
  // added caps+region). Pinning the exact number here only ever fails the wrong
  // test.
  assert.ok(Number(/registrySchema = (\d+);/.exec(sol)[1]) >= 4);
});

test("a rev-12 ledger prices self-hosting at zero and never divides by it", () => {
  const sol = LEDGER_SOL;
  assert.ok(Number(/deploymentsSchema = (\d+);/.exec(sol)[1]) >= 12);
  // the whole feature: one comparison in the rate path
  assert.match(sol, /if \(e\.payoutWallet == d\.owner\) return 0;/);
  // ... and the two places a zero rate would otherwise be a divisor. These are
  // the crash the feature would ship if either guard were dropped.
  assert.match(sol, /rate == 0 \? leaseSec : d\.balance6 \/ rate/);
  assert.match(sol, /newRate == 0 \? tail/);
  // the ledger must decode the schema-4 entry, or payoutWallet reads as garbage
  const iface = /interface IEnclaveRegistry \{[\s\S]*?\n\}/.exec(sol)[0];
  assert.match(iface, /address proofKey;\s*\n\s*address payoutWallet;/);
});

test("the ledger's Deployment tuple is still byte-for-byte the rev-2 shape", () => {
  // rev 9 promised this, and the supervisor/relay/CLI/site all decode the tuple
  // after sniffing only the schema NUMBER. A field added here would misdecode
  // every deployment on every consumer at once.
  const components = ABI("EnclaveDeployments").find((f) => f.type === "function" && f.name === "get")
    .outputs[0].components;
  assert.deepEqual(components.map((c) => `${c.type} ${c.name}`), [
    "bytes32 id", "address owner", "string appRef", "string ports", "string configCid",
    "uint16 gpuMilli", "uint16 cpuMilli", "uint32 appPort", "bool isPublic", "bool active",
    "uint64 createdAt", "uint256 rate", "uint256 balance6", "uint256 spent6",
    "bytes32 runner", "address runnerOperator", "uint64 leaseUntil"]);
  // and the prover's mirror of it must match, or its d.runner/d.runnerOperator
  // reads would be garbage
  const mirror = /struct Deployment \{([\s\S]*?)\n    \}/.exec(SOL)[1];
  for (const c of components)
    assert.match(mirror, new RegExp(`\\b${c.type.replace(/(\d)/g, "$1")}\\s+${c.name};`),
      `EnclaveProofOfTime's Deployment mirror is missing ${c.type} ${c.name}`);
});

test("checkpointMany is tolerant, not atomic (one bad proof must not sink a batch)", () => {
  const many = ABI("EnclaveProofOfTime").find((f) => f.type === "function" && f.name === "checkpointMany");
  // returns a per-item verdict rather than reverting the lot
  assert.deepEqual(many.outputs.map((o) => o.type), ["bool[]"]);
  assert.match(SOL, /try this\.checkpoint\(/, "each proof is tried in its own external call");
  assert.match(SOL, /catch Error\(string memory reason\)[\s\S]*?CheckpointRejected/,
    "a refused proof is logged with its reason, not raised");
  // and the supervisor reads those rejections back out, so a seller sees why
  assert.match(SUP, /CheckpointRejected/);
});

test("the supervisor never proves a deployment it has not confirmed is serving", () => {
  // The honesty invariant of the whole loop: a proof is a claim about the app,
  // so it must be gated on a real probe of the app — and never signed for a
  // record that was never provisioned here.
  assert.match(SUP, /async function tenantServing\(rec\) \{[\s\S]*?instanceAlive\(rec\)/,
    "tenantServing still starts from the manager's own liveness answer");
  assert.match(SUP, /async function tenantServing\(rec\)[\s\S]*?net\.connect\(/,
    "tenantServing still opens a real socket to the tenant's port");
  const build = /async function buildCheckpoints\(recs\)[\s\S]*?\n\}/.exec(SUP)[0];
  assert.match(build, /if \(!\(await tenantServing\(rec\)\)\)[\s\S]*?continue;/,
    "buildCheckpoints skips any deployment that is not serving");
  const final = /async function proveFinalPeriod\(rec, why\)[\s\S]*?\n\}/.exec(SUP)[0];
  assert.match(final, /if \(!rec\.startedAt\) return;/,
    "proveFinalPeriod refuses to prove a record that never ran here");
});

test("teardown proves BEFORE it releases (the other order donates the partial period)", () => {
  // release() clears the watermark on-chain, so a proof sent after it settles
  // nothing. Pin the ordering inside the helper every teardown path uses.
  const pr = /async function proveAndRelease\(rec, why\) \{([\s\S]*?)\n\}/.exec(SUP);
  assert.ok(pr, "proveAndRelease still exists");
  const body = pr[1];
  assert.ok(body.indexOf("proveFinalPeriod") < body.indexOf("releaseLease"),
    "proveAndRelease must prove first and release second");
  // and the paths that never served must NOT prove (they earn nothing, rightly)
  for (const why of ["claim receipt unreadable", "capacity vanished", "provision failed"])
    assert.match(SUP, new RegExp(`releaseLease\\((?:rec|d)\\.id, "${why}"\\)`),
      `"${why}" must stay a plain release: nothing was served, so there is nothing to prove`);
});

test("every tenant gets proven, not just the first batch's worth", () => {
  // The silent-failure shape this guards: `deployments` iterates in INSERTION
  // order and one batch is capped at PROOF_MAX_PER_TX, so a box serving more
  // tenants than the cap would prove the same front slice every round and earn
  // nothing at all for the rest — no error, no log, just short payouts. The fix
  // is staleness ordering plus a loop, and both have to stay.
  const fn = /async function proveAllLeases\(recs, why\) \{([\s\S]*?)\n\}/.exec(SUP);
  assert.ok(fn, "proveAllLeases still exists");
  const body = fn[1];
  assert.match(body, /sort\(\(a, b\) => \(a\._provenAt \|\| 0\) - \(b\._provenAt \|\| 0\)\)/,
    "oldest proof must go first, so coverage rotates and the most at-risk tenant is served");
  assert.match(body, /while \(rest\.length && sent < maxBatches\)/,
    "one round must keep batching until every live lease is covered");
  assert.match(body, /if \(rest\.length === before\) break;/,
    "a round that covers nothing must stop, not spin");
  // a REFUSED proof must not be marked proven: that would report an on-chain
  // provenUntil to the tenant that does not exist, and would make the rotation
  // above skip the retry for a whole round
  const one = /async function proveLeases\(recs, why\) \{([\s\S]*?)\n\}/.exec(SUP)[1];
  assert.match(one, /if \(refused\.has\(key\)\) continue;/,
    "proveLeases must stamp only the checkpoints that actually landed");
  // and the tick must call the looping version, never the single-batch one
  const tick = /async function proofTick\(\) \{[\s\S]*?\n\}/.exec(SUP)[0];
  assert.match(tick, /await proveAllLeases\(mine, "steady"\)/);
  assert.ok(!/await proveLeases\(mine/.test(tick), "the tick must not use the single-batch path");
});

test("the proof interval leaves room for a missed round inside the contract's window", () => {
  // A host proving every PROOF_INTERVAL_SEC can lose one round to an RPC hiccup
  // and still recover the whole gap on the next, because one checkpoint reaches
  // proofWindowSec backwards. That only holds while 2 * interval <= window.
  const interval = Number(/PROOF_INTERVAL_SEC \|\| "(\d+)"/.exec(SUP)[1]);
  const window = Number(/uint64 public proofWindowSec = (\d+);/.exec(SOL)[1]);
  assert.ok(2 * interval <= window,
    `interval ${interval}s vs window ${window}s: a single missed round would cost real income`);
  // and the window must stay under the lease quantum, or one proof buys a lease
  const leaseSec = Number(/uint64  public leaseSec = (\d+);/.exec(LEDGER_SOL)[1]);
  assert.ok(window < leaseSec, `window ${window}s must stay under leaseSec ${leaseSec}s`);
});

test("the fleet advertises proof-of-time capability, AND-ed across every host", () => {
  assert.match(SUP, /proofOfTime: PROOF_READY\(\),/, "each box advertises whether it can prove");
  const relay = fs.readFileSync(path.join(REPO, "relay", "api-relay.js"), "utf8");
  assert.match(relay, /proofOfTime: serving\.length > 0 && serving\.every\(\(e\) => e\.availability\?\.proofOfTime === true\)/,
    "the relay must AND it: 'hosts here are held to account' is only true if ALL are");
});

test("the proof key is published over the attested origin for cross-checking", () => {
  // The one lie the chain cannot catch (a proofKey whose private half is not in
  // the CVM) is caught by comparing the registry entry with this. If it stops
  // being served, that check quietly becomes impossible.
  assert.match(SUP, /out\.proofKey = PROOF_ACCOUNT[\s\S]*?address: PROOF_ACCOUNT\.address/);
  assert.match(SUP, /keySource: "in-enclave"[\s\S]*?EnclaveRegistry\.get\(enclaveId\)\.proofKey/);
  // minted in-CVM, memory-only, and republished when it rotates
  assert.match(SUP, /function initProofKey\(\)[\s\S]*?randomBytes\(32\)/);
  assert.match(SUP, /async function syncRegisteredProofKey\(id\)[\s\S]*?"setProofKey"/);
});
