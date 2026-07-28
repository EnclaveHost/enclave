// Cancellation / refund (ledger rev 10): the OFF-CHAIN half.
//
// The economics are proved in Solidity (contracts/foundry/test/
// EnclaveDeployments.refund.t.sol). What that suite cannot see is whether the
// four clients that offer the button agree with the contract about (a) which
// function they are calling, and (b) WHAT NUMBER they show the user first.
//
// (b) is the one that matters here and the reason this file exists. A refund
// returns the runner ESCROW — what the contract still holds — and never the
// deployment's balance6: the publisher fee and the platform share forwarded to
// their wallets at funding time. A client that renders balance6 next to a
// refund button is not a cosmetic bug, it is telling a paying customer they
// will receive roughly 25% more money than the transaction will actually send
// them. So every client is pinned to refundableOf(), and the selectors the
// hand-mirrored ABIs use are checked against the real artifact.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { encodeRefundTx } from "../relay/mcp.js";
import { buildControlCall } from "../relay/vaultsvc.js";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const rd = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");
const ABI = (n) => JSON.parse(rd("contracts", `${n}.abi.json`));

const DEPS_ABI = ABI("EnclaveDeployments");
const D = "0x1111111111111111111111111111111111111111";
const ID = "0x" + "ab".repeat(32);

test("the ledger exposes the refund surface every client gates on", () => {
  const fn = (n) => DEPS_ABI.find((f) => f.type === "function" && f.name === n);
  assert.deepEqual(fn("refund").inputs.map((i) => i.type), ["bytes32"]);
  assert.equal(fn("refund").stateMutability, "nonpayable");
  // no payee argument and no amount argument: the contract decides both, which
  // is what keeps a refund a reversal to the owner rather than a transfer
  assert.equal(fn("refund").inputs.length, 1);
  // the exact quote clients must render (uint256, USDC 6dp)
  assert.deepEqual(fn("refundableOf").inputs.map((i) => i.type), ["bytes32"]);
  assert.equal(fn("refundableOf").outputs[0].type, "uint256");
  assert.equal(fn("refundableOf").stateMutability, "view");
  // the owner-contribution cap the runbook's same-address rule leans on
  assert.equal(fn("ownerEscrow6").outputs[0].type, "uint256");
  const ev = DEPS_ABI.find((f) => f.type === "event" && f.name === "Refunded");
  assert.deepEqual(ev.inputs.map((i) => i.type), ["bytes32", "address", "uint256"]);
  // rev 10 is the marker every client gates the feature on
  assert.ok(Number(/deploymentsSchema = (\d+);/.exec(rd("contracts", "EnclaveDeployments.sol"))[1]) >= 10);
});

test("mcp encoder: refund decodes against the ledger ABI, with no amount to get wrong", () => {
  const tx = encodeRefundTx({ deployments: D, id: ID, refundable6: 1_234_500n });
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data: tx.data });
  assert.equal(functionName, "refund");
  assert.deepEqual(args, [ID]);
  assert.equal(BigInt(tx.value ?? 0n), 0n);
  // the quote rides in the human-readable label only — never in the calldata,
  // so a stale quote can never become a wrong transfer
  assert.match(tx.function, /\$1\.23/);
});

test("vault control proxies refund under its own name, distinct from refundToTreasury", async () => {
  const data = await buildControlCall(ID, "cancel");
  const { functionName, args } = decodeFunctionData({ abi: DEPS_ABI, data });
  assert.equal(functionName, "refund");
  assert.deepEqual(args, [ID]);
  // "refund" as a top-level vault op is refundToTreasury (the card-refund
  // flow). The control action MUST NOT share that name.
  await assert.rejects(() => buildControlCall(ID, "refund"), /unknown control action/);
});

test("the vault contract allows the refund selector, single and inside a multicall", () => {
  const sol = rd("contracts", "EnclaveCreditVault.sol");
  assert.match(sol, /SEL_REFUND\s*=\s*bytes4\(keccak256\("refund\(bytes32\)"\)\)/);
  // both gates — the bare selector and the multicall inner-call loop — or a
  // batched cancel silently reverts
  const gates = sol.match(/\|\|\s*(inner|sel) == SEL_REFUND/g) || [];
  assert.equal(gates.length, 2, "refund must be allowed in both the single and multicall paths");
});

test("every client quotes refundableOf, never the deployment balance", () => {
  // the site's selector table must carry the real selectors
  const chain = rd("site", "js", "core", "chain.js");
  for (const sig of ["refund(bytes32)", "refundableOf(bytes32)"]) {
    const sel = toFunctionSelector(sig).slice(2);
    assert.ok(chain.includes(sel), `site DEP_SEL is missing ${sig} (${sel})`);
  }
  // and the reader must gate on rev 10 rather than calling a function that
  // does not exist on the live ledger
  assert.match(chain, /depRefundableOf[\s\S]{0,400}depSchemaRev\(\)\) < 10/);

  // the console's handler quotes the chain, and warns when the balance differs
  const con = rd("site", "components", "deployments", "deployments.js");
  assert.match(con, /_refund\(/);
  assert.match(con, /depRefundableOf\(id\)/);
  assert.match(con, /cannot be returned/i, "the console must name the non-refundable gap");

  // the CLI reads the same view and gates on the same rev
  const cli = rd("cli", "enclave.mjs");
  assert.match(cli, /"refundableOf", \[id\]/);
  assert.match(cli, /rev < 10/);
  assert.match(cli, /NOT refundable/i, "the CLI must name the non-refundable gap");

  // the MCP tool ships the caveat in the text the model reads, not just in docs
  const mcp = rd("relay", "mcp.js");
  assert.match(mcp, /"refundableOf", \[full\]/);
  assert.match(mcp, /notRefundable/);
});
