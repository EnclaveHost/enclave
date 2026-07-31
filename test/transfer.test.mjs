// Deployment transfer (ledger rev 11): the OFF-CHAIN half.
//
// The handoff semantics are proved in Solidity (contracts/foundry/test/
// EnclaveDeployments.transfer.t.sol). What that suite cannot see is whether
// the clients that offer the action agree with the contract about (a) which
// function they are calling, and (b) WHAT THEY WARN about first.
//
// (b) is the reason this file exists, twice over. First: the transfer is
// ONE-SHOT — the ledger had no EIP-170 room for a pending/accept step — so
// the only confirmation a user ever gets is the one the client renders, and
// every client must restate the destination address before a signature.
// Second: the refundable escrow TRAVELS WITH the record (refund() pays
// whoever owns it at call time), so a client that offers Transfer without
// quoting the escrow is quietly handing the new owner the old owner's money.
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
  assert.ok(Number(/deploymentsSchema = (\d+);/.exec(rd("contracts", "EnclaveDeployments.sol"))[1]) >= 11);
});

test("mcp encoder: transferDeployment decodes against the ledger ABI, escrow quoted in the label only", () => {
  const tx = encodeTransferTx({ deployments: D, id: ID, to: TO, refundable6: 1_234_500n });
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data: tx.data });
  assert.equal(functionName, "transferDeployment");
  assert.deepEqual(args.map((a) => String(a).toLowerCase()), [ID, TO]);
  assert.equal(BigInt(tx.value ?? 0n), 0n);
  // the FULL destination address and the escrow ride in the human-readable
  // label — the signer must be able to see exactly what they give away
  assert.match(tx.function, new RegExp(TO, "i"));
  assert.match(tx.function, /\$1\.23/);
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

test("every client restates the destination, quotes the escrow, and gates on rev 11", () => {
  // the site's selector table must carry the real selector
  const chain = rd("site", "js", "core", "chain.js");
  const sel = toFunctionSelector("transferDeployment(bytes32,address)").slice(2);
  assert.ok(chain.includes(sel), `site DEP_SEL is missing transferDeployment (${sel})`);

  // the console: wallet rows only (the vault case above), rev-gated, escrow
  // named before the signature, and the confirm restates the address
  const con = rd("site", "components", "deployments", "deployments.js");
  assert.match(con, /_transfer\(/);
  assert.match(con, /_transfer\(id, btn\)\{[\s\S]{0,1500}deploymentsSchema < 11/);
  assert.match(con, /_transfer\(id, btn\)\{[\s\S]{0,3000}refundable escrow/i, "the console must name the escrow that travels");
  assert.match(con, /ctl === "wallet" \? '<button class="btn btn-sm enc-xferbtn"/, "transfer is a wallet-row action, never a vault one");

  // the CLI reads the same view, gates on the same rev, and warns the same way
  const cli = rd("cli", "enclave.mjs");
  assert.match(cli, /"transferDeployment", args: \[id, to\]/);
  assert.match(cli, /rev < 11/);
  assert.match(cli, /travels WITH the record/i, "the CLI must name the escrow that travels");

  // the MCP tool ships both caveats in text the model reads, not just in docs
  const mcp = rd("relay", "mcp.js");
  assert.match(mcp, /rev < 11/);
  assert.match(mcp, /escrowGoesWithIt/);
  assert.match(mcp, /one-shot/i);
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
