#!/usr/bin/env node
// safe.mjs - the smallest Safe v1.4.1 wallet the Enclave L2 needs on L1.
//
// OPContractsManager V2 changes a chain (adding the permissionless game, later
// upgrades) only when the L1 ProxyAdmin owner DELEGATECALLs it, which an EOA
// cannot do. So the owner is a Safe; in production its signer is the owner's
// Trezor, on the devnet a test key. Uses the canonical v1.4.1 deployments
// (present on Sepolia and Ethereum); the tool refuses to run without them.
//
//   node l2/safe.mjs create --rpc URL --key FILE [--salt N]
//        -> deploys a 1-of-1 Safe owned by the key's address, prints its address
//   node l2/safe.mjs exec --rpc URL --key FILE --safe 0x.. --to 0x.. --data 0x.. [--delegatecall]
//        -> executes one transaction from the Safe, signed by its sole owner
// The key is read from a file; it never appears in argv or output.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData, getAddress, decodeEventLog, concat, pad, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";      // SafeProxyFactory 1.4.1
const SINGLETON = "0x41675C099F32341bf84BFc5382aF534df5C7461a";    // Safe 1.4.1
const FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";     // CompatibilityFallbackHandler 1.4.1

const SAFE_ABI = [
  { type: "function", name: "setup", stateMutability: "nonpayable", outputs: [], inputs: [
    { name: "_owners", type: "address[]" }, { name: "_threshold", type: "uint256" }, { name: "to", type: "address" },
    { name: "data", type: "bytes" }, { name: "fallbackHandler", type: "address" }, { name: "paymentToken", type: "address" },
    { name: "payment", type: "uint256" }, { name: "paymentReceiver", type: "address" }] },
  { type: "function", name: "execTransaction", stateMutability: "payable", outputs: [{ type: "bool" }], inputs: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "signatures", type: "bytes" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "ExecutionSuccess", inputs: [{ name: "txHash", type: "bytes32", indexed: true }, { name: "payment", type: "uint256" }] },
  { type: "event", name: "ExecutionFailure", inputs: [{ name: "txHash", type: "bytes32", indexed: true }, { name: "payment", type: "uint256" }] },
];
const FACTORY_ABI = [
  { type: "function", name: "createProxyWithNonce", stateMutability: "nonpayable", outputs: [{ type: "address" }], inputs: [
    { name: "_singleton", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" }] },
  { type: "event", name: "ProxyCreation", inputs: [{ name: "proxy", type: "address", indexed: true }, { name: "singleton", type: "address" }] },
];

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const die = (m) => { console.error(`safe: ${m}`); process.exit(1); };
const rpc = opt("rpc") || die("--rpc required");
const keyFile = opt("key") || die("--key required");
const account = privateKeyToAccount(fs.readFileSync(keyFile, "utf8").trim());
const pub = createPublicClient({ transport: http(rpc) });
const chainId = await pub.getChainId();
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
for (const a of [FACTORY, SINGLETON, FALLBACK]) if (((await pub.getCode({ address: a })) || "0x") === "0x") die(`no Safe 1.4.1 contract at ${a} on chain ${chainId}`);

async function sendAndWait(req) {
  const hash = await wallet.sendTransaction(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") die(`reverted: ${hash}`);
  return r;
}

if (cmd === "create") {
  const init = encodeFunctionData({ abi: SAFE_ABI, functionName: "setup",
    args: [[account.address], 1n, zeroAddress, "0x", FALLBACK, zeroAddress, 0n, zeroAddress] });
  const r = await sendAndWait({ to: FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createProxyWithNonce",
    args: [SINGLETON, init, BigInt(opt("salt", "0"))] }) });
  const log = r.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
  const safe = getAddress(decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics }).args.proxy);
  const owners = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" });
  console.log(JSON.stringify({ safe, owners, threshold: 1, chainId, tx: r.transactionHash, gasUsed: Number(r.gasUsed) }));
} else if (cmd === "exec") {
  const safe = getAddress(opt("safe") || die("--safe required"));
  const owners = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" });
  const threshold = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" });
  if (threshold !== 1n || !owners.map((o) => o.toLowerCase()).includes(account.address.toLowerCase()))
    die(`this key is not the sole signer of ${safe}`);
  // v=1 "approved hash" signature: valid because the owner itself is msg.sender.
  const sig = concat([pad(account.address, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
  const r = await sendAndWait({ to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction",
    args: [getAddress(opt("to") || die("--to required")), 0n, opt("data", "0x"), rest.includes("--delegatecall") ? 1 : 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, sig] }) });
  // A Safe swallows inner reverts and emits ExecutionFailure: treat that as failure.
  const ok = r.logs.some((l) => { try { return decodeEventLog({ abi: SAFE_ABI, data: l.data, topics: l.topics }).eventName === "ExecutionSuccess"; } catch { return false; } });
  if (!ok) die(`inner call failed (ExecutionFailure) in ${r.transactionHash}`);
  console.log(JSON.stringify({ safe, tx: r.transactionHash, gasUsed: Number(r.gasUsed), operation: rest.includes("--delegatecall") ? "delegatecall" : "call" }));
} else die("usage: safe.mjs create|exec ...");
