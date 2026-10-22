#!/usr/bin/env node
// A TEST-ONLY ERC-4337 v0.7 paymaster for local forks (compiled here, never a repository contract): it sponsors exactly one
// account and nothing else, and is funded with an EntryPoint deposit from the test's own key. A short-lived process, so the
// Solidity compiler never loads into the browser test's driver.
//   node test/helpers/test-paymaster.mjs <rpc> <entryPoint> <sponsoredAccount> <funder (unlocked on the fork)> <depositWei>  -> {paymaster}
import * as viem from "viem";
import solc from "solc";

const [rpc, entryPoint, sponsored, funder, deposit] = process.argv.slice(2);
const SOURCE = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits;
  uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }
interface IEntryPointDeposit { function depositTo(address account) external payable; }
contract TestSponsorPaymaster {
  address public immutable entryPoint; address public immutable sponsored;
  constructor(address ep, address account) { entryPoint = ep; sponsored = account; }
  function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256) external view returns (bytes memory context, uint256 validationData) {
    require(msg.sender == entryPoint, "only the EntryPoint");
    return ("", op.sender == sponsored ? 0 : 1);
  }
  function postOp(uint8, bytes calldata, uint256, uint256) external pure {}
  function deposit() external payable { IEntryPointDeposit(entryPoint).depositTo{value: msg.value}(address(this)); }
}`;
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "P.sol": { content: SOURCE } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
const c = out.contracts["P.sol"].TestSponsorPaymaster;
const chain = { id: 8453, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pc = viem.createPublicClient({ chain, transport: viem.http(rpc) });
const wc = viem.createWalletClient({ chain, account: viem.getAddress(funder), transport: viem.http(rpc) });
const h = await wc.deployContract({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, args: [entryPoint, sponsored], gas: 2_000_000n });
const rc = await pc.waitForTransactionReceipt({ hash: h });
if (rc.status !== "success") throw new Error("paymaster deploy failed");
const paymaster = rc.contractAddress.toLowerCase();
const d = await wc.writeContract({ address: paymaster, abi: c.abi, functionName: "deposit", value: BigInt(deposit), gas: 300_000n });
if ((await pc.waitForTransactionReceipt({ hash: d })).status !== "success") throw new Error("deposit failed");
process.stdout.write(JSON.stringify({ paymaster }) + "\n");
