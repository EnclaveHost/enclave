// Deployment transfer (ledger rev 11): the OFF-CHAIN half.
//
// The handoff semantics are proved in Solidity (contracts/foundry/test/
// EnclaveDeployments.transfer.t.sol). What that suite cannot see is whether
// the clients that offer the action agree with the contract about (a) which
// function they are calling, and (b) HOW they carry the money rule.
//
// (b) is the reason this file exists, twice over. First: a transfer moves
// CONTROL and never money — the ledger reverts "refund first" while it still
// holds the owner's refundable backing — so every client must either chain
// the refund in front (money back to the OWNER's wallet, then the empty
// record hands over) or say plainly why the transfer waits. Second: the
// handoff is ONE-SHOT — the ledger had no EIP-170 room for a pending/accept
// step — so the only confirmation a user ever gets is the one the client
// renders, and every client must restate the destination address before a
// signature.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { encodeTransferTx } from "../relay/mcp.js";
import { buildControlCall } from "../relay/vaultsvc.js";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const rd = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");
const ABI = (n) => JSON.parse(rd("contracts", `${n}.abi.json`));

const DEPS_ABI = ABI("EnclaveDeployments");
const D = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const ID = "0x" + "ab".repeat(32);

test("the ledger exposes the transfer surface every client gates on", () => {
  const fn = DEPS_ABI.find((f) => f.type === "function" && f.name === "transferDeployment");
  assert.deepEqual(fn.inputs.map((i) => i.type), ["bytes32", "address"]);
  assert.equal(fn.stateMutability, "nonpayable");
  const ev = DEPS_ABI.find((f) => f.type === "event" && f.name === "DeploymentTransferred");
  assert.deepEqual(ev.inputs.map((i) => i.type), ["bytes32", "address", "address"]);
  assert.ok(ev.inputs.every((i) => i.indexed), "indexers filter transfers by id, from AND to");
  // rev 11 is the marker every client gates the feature on
  const sol = rd("contracts", "EnclaveDeployments.sol");
  assert.ok(Number(/deploymentsSchema = (\d+);/.exec(sol)[1]) >= 11);
  // the money rule lives in the CONTRACT, not in client goodwill: no transfer
  // while the owner's own refundable backing is held. The gate must read
  // min(ownerEscrow6, escrow6) — NOT refundableOf, which reads zero mid-lease
  // while the seller's reserve would later free to the NEW owner.
  assert.match(sol, /require\(ownerEscrow6\[id\] == 0 \|\| _earn\[id\]\.escrow6 == 0, "refund first"\);/);
});

test("mcp encoder: transferDeployment decodes against the ledger ABI, address in the label", () => {
  const tx = encodeTransferTx({ deployments: D, id: ID, to: TO });
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data: tx.data });
  assert.equal(functionName, "transferDeployment");
  assert.deepEqual(args.map((a) => String(a).toLowerCase()), [ID, TO]);
  assert.equal(BigInt(tx.value ?? 0n), 0n);
  // the FULL destination address rides in the human-readable label — the
  // signer must be able to see exactly what they are handing over, and that
  // no money rides along
  assert.match(tx.function, new RegExp(TO, "i"));
  assert.match(tx.function, /money does not/);
});

test("the credit vault can NEVER transfer a record out of itself", async () => {
  // A vault-owned deployment's on-chain owner IS the vault: its refunds land
  // in the vault's credit balance. A transferDeployment selector in the vault
  // allowlist would let a passkey control op hand the record — and every
  // future refund — to an outside wallet, outside the vault's accounting.
  const sol = rd("contracts", "EnclaveCreditVault.sol");
  assert.ok(!sol.includes("transferDeployment"), "the vault allowlist must not carry the transfer selector");
  // and the relay's control-op builder refuses to encode one
  await assert.rejects(() => buildControlCall(ID, "transfer"), /unknown control action/);
});

test("every client chains or explains the refund, restates the destination, and gates on rev 11", () => {
  // the site's selector table must carry the real selectors (transfer + both
  // halves of the gate it reads)
  const chain = rd("site", "js", "core", "chain.js");
  for (const sig of ["transferDeployment(bytes32,address)", "ownerEscrow6(bytes32)", "earnOf(bytes32)"]) {
    const sel = toFunctionSelector(sig).slice(2);
    assert.ok(chain.includes(sel), `site DEP_SEL is missing ${sig} (${sel})`);
  }

  // the console: wallet rows only (the vault case above), rev-gated, and the
  // money rule carried in the flow — refund chained in front when needed
  const con = rd("site", "components", "deployments", "deployments.js");
  assert.match(con, /_transfer\(id, btn\)\{[\s\S]{0,2000}deploymentsSchema < 11/);
  assert.match(con, /Refund & transfer/, "the console must chain the refund in front of the handoff");
  assert.match(con, /refund first/, "the console must recognize the ledger's gate");
  assert.match(con, /ctl === "wallet" \? '<button class="btn btn-sm enc-xferbtn"/, "transfer is a wallet-row action, never a vault one");

  // the CLI chains the same two transactions behind one confirm
  const cli = rd("cli", "enclave.mjs");
  assert.match(cli, /"transferDeployment", args: \[id, to\]/);
  assert.match(cli, /rev < 11/);
  assert.match(cli, /cmdTransfer[\s\S]{0,6000}functionName: "refund", args: \[id\]/,
    "the CLI must refund the owner before the handoff");

  // the MCP tool returns [refund, transfer] when money is held, and says why
  const mcp = rd("relay", "mcp.js");
  assert.match(mcp, /rev < 11/);
  assert.match(mcp, /refundsFirst/);
  assert.match(mcp, /transactions: \[encodeRefundTx/, "the refund tx must ride in front of the transfer tx");
});

test("the serving box re-keys its owner gates when the record changes hands", () => {
  // supervisor.js snapshots rec.owner at adopt() and gates the private data
  // path, logs, delete/restart and top-up on it. Without a re-sync in the
  // ledger audit, a transfer would leave the OLD owner holding those gates
  // (and lock the new owner out) until the lease was released and re-claimed.
  const sup = rd("supervisor.js");
  assert.match(sup, /auditClaims[\s\S]{0,2500}getAddress\(d\.owner\)/, "auditClaims must mirror the on-chain owner");
  assert.match(sup, /owner transferred on-chain/, "the flip must be visible in the box's logs");
});
