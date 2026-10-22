// The approved enrollment plan, validated without trusting it: every operation is rebuilt from trust.mjs and the verified
// reserve ABI (calldata, ownerCall wrapper, value, recipient, gas cap) and the proposal must equal the rebuild exactly.
// Pure: reads only the bytes it is given. -> frozen array of 25 operations, or throws.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeFunctionData, encodeAbiParameters, parseAbi, keccak256, toHex, formatEther } from "../enclave/node_modules/viem/_esm/index.js";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const lc = (s) => String(s).toLowerCase();
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
export const VAULT_ABI = parseAbi(["function ownerCall(address target, bytes data) returns (bytes)", "function owner() view returns (address)",
  "function factory() view returns (address)"]);
export const budgetKey = (id, owner) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [id, owner]));
export const pubkeyAddress = (pub) => { assert.match(pub, /^0x04[0-9a-fA-F]{128}$/, "relay public key"); return "0x" + keccak256("0x" + pub.slice(4)).slice(-40); };

/** The 25 operations exactly as reviewed, in order. */
export function expectedOperations(trust, reserveAbi) {
  const enc = (functionName, args) => encodeFunctionData({ abi: reserveAbi, functionName, args });
  const ops = [];
  for (const [id, who, label] of trust.apps) {
    const owner = who === "admin" ? lc(trust.admin) : who === "dnsVault" ? trust.dnsVault : assert.fail("owner kind");
    const viaVault = owner !== lc(trust.admin);
    const policy = { ...trust.policy, claimPolicy: viaVault ? 2 : 1 };
    const ownerOp = (kind, action, inner, title) => ops.push({ kind, app: id, appLabel: label, ownerOfRecord: owner, action, title: title + (viaVault ? " (sent through your DNS SessionVault ownerCall)" : ""),
      from: lc(trust.admin), to: viaVault ? owner : trust.reserve, value: "0x0", gas: toHex(trust.gasCaps.owner),
      data: viaVault ? encodeFunctionData({ abi: VAULT_ABI, functionName: "ownerCall", args: [trust.reserve, inner] }) : inner, inner, policy: kind === "configure" ? policy : undefined });
    ops.push({ kind: "deposit", app: id, appLabel: label, ownerOfRecord: owner, action: "deposit", title: `Deposit ${formatEther(trust.perAppWei)} ETH lease gas for ${label}`,
      from: lc(trust.admin), to: trust.reserve, value: toHex(trust.perAppWei), gas: toHex(trust.gasCaps.deposit), data: enc("deposit", [id]) });
    if (viaVault) ownerOp("setClaimant", "allow existing DNS operator", enc("setClaimant", [id, trust.dnsOperator, true]), `Allow the existing DNS operator ${short(trust.dnsOperator)} to claim ${label}`);
    ownerOp("configure", "configure lease sponsorship", enc("configure", [id, { ...policy, maxPerOpWei: BigInt(policy.maxPerOpWei), epochCapWei: BigInt(policy.epochCapWei), maxGasPrice: BigInt(policy.maxGasPrice) }]),
      `Enable lease sponsorship for ${label}: ${viaVault ? "existing DNS operator only" : "self-hosted runner only"}, ≤${Number(policy.maxGasPrice) / 1e9} gwei, ≤${policy.maxClaimsPerEpoch} claims/hour`);
  }
  for (const [host, address] of trust.relays)
    ops.push({ kind: "transfer", app: null, appLabel: `${host} lease relay`, host, action: "Initial lease relay working balance", title: `Send ${formatEther(trust.relayWei)} ETH working balance to the ${host} lease relay ${short(address)}`,
      from: lc(trust.admin), to: address, value: toHex(trust.relayWei), gas: toHex(trust.gasCaps.transfer), data: "0x" });
  return ops.map((o, index) => Object.freeze({ ...o, index, opId: sha256(JSON.stringify([index, o.from, o.to, o.value, o.data, o.gas])) }));
}

/**
 * validatePlan({ trust, reserveAbi, approvedSha256, proposal, enrollment, identities }) - Buffers of the three files.
 * -> { planSha256, operations, totalWei }
 */
export function validatePlan({ trust, reserveAbi, approvedSha256, proposal, enrollment, identities }) {
  const planSha256 = sha256(proposal);
  assert.match(String(approvedSha256 || ""), /^[0-9a-f]{64}$/, "an approved proposal sha256 pin is required");
  assert.equal(planSha256, approvedSha256, "the proposal file is not the approved proposal");
  assert.equal(sha256(enrollment), trust.reviewedFiles.enrollment, "the enrollment proposal changed");
  assert.equal(sha256(identities), trust.reviewedFiles.identities, "the relay identity metadata changed");
  const p = JSON.parse(proposal), e = JSON.parse(enrollment), ids = JSON.parse(identities).identities;
  assert.equal(p.chainId, trust.chainId, "proposal chain"); assert.equal(lc(p.from), lc(trust.admin), "proposal sender");
  assert.equal(p.totalEth, formatEther(trust.totalWei), "proposal total");
  assert.equal(lc(e.reserve), trust.reserve, "the enrollment proposal is for another reserve"); assert.equal(e.chainId, trust.chainId);
  // relay recipients: root's public metadata, each address derived from its own public key
  assert.equal(ids.length, trust.relays.length, "relay identity count");
  ids.forEach((x, i) => {
    assert.equal(x.host, trust.relays[i][0], "relay host"); assert.equal(x.chainId, trust.chainId, "relay chain");
    assert.equal(lc(x.address), trust.relays[i][1], "relay address"); assert.equal(pubkeyAddress(x.publicKey), trust.relays[i][1], "relay address is not derived from its public key");
  });
  for (const a of e.apps) {
    const t = trust.apps.find(([id]) => id === lc(a.id)); assert.ok(t, `unreviewed app ${a.id}`);
    assert.equal(lc(a.owner), t[1] === "admin" ? lc(trust.admin) : trust.dnsVault, "app owner of record");
    assert.deepEqual({ ...a.policy }, { ...trust.policy, claimPolicy: t[1] === "admin" ? 1 : 2 }, `policy of ${a.id}`);
  }
  assert.equal(e.apps.length, trust.apps.length, "app count");
  const want = expectedOperations(trust, reserveAbi);
  assert.equal(p.operations.length, want.length, `the approved proposal must hold exactly ${want.length} operations`);
  assert.equal(e.operations.length, want.length - trust.relays.length, "enrollment operation count");
  const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? lc(v) : v]));
  p.operations.forEach((op, i) => {
    const w = want[i];
    const shape = { ...(w.app ? { app: w.app } : { host: w.host }), action: w.action, from: w.from, to: lc(w.to), value: w.value, data: w.data, gas: w.gas };
    assert.deepEqual(fields(op), fields(shape), `operation ${i + 1} differs from the reviewed rebuild`);
    if (i < e.operations.length) assert.deepEqual(fields(e.operations[i]), fields(op), `operation ${i + 1} differs from the enrollment proposal`);
  });
  const totalWei = want.reduce((s, o) => s + BigInt(o.value), 0n);
  assert.equal(totalWei, trust.totalWei, "total value");
  return Object.freeze({ planSha256, operations: want, totalWei });
}
