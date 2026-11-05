#!/usr/bin/env node
// send.mjs - send one L1 or L2 transaction from a devnet role key, for the
// steps cast would need --private-key on the command line for: funding role
// wallets, OptimismPortal deposits, guardian calls.
//
//   node l2/send.mjs --rpc URL --key FILE --to 0x.. [--value ETH] [--data 0x..] [--gas N]
//        -> prints {hash, from, to, status, gasUsed, effectiveGasPrice, blockNumber} as JSON
// Build --data with `cast calldata`. The key is read from a file; it never
// appears in argv or output. Refuses production chain ids.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PRODUCTION = new Set([1, 10, 8453, 42161, 137]);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const k of ["rpc", "key", "to"]) if (!args[k]) { console.error(`send: --${k} is required`); process.exit(2); }

const raw = fs.readFileSync(args.key, "utf8").trim();
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
const transport = http(args.rpc);
const pub = createPublicClient({ transport });
const chainId = await pub.getChainId();
if (PRODUCTION.has(chainId)) { console.error(`send: chain ${chainId} is a production chain; refusing`); process.exit(1); }
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [args.rpc] } } };
const wallet = createWalletClient({ account, chain, transport });

const hash = await wallet.sendTransaction({
  to: getAddress(args.to),
  value: args.value ? parseEther(args.value) : 0n,
  data: args.data || undefined,
  gas: args.gas ? BigInt(args.gas) : undefined,
});
const r = await pub.waitForTransactionReceipt({ hash });
console.log(JSON.stringify({ hash, chainId, from: account.address, to: r.to, status: r.status,
  gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.effectiveGasPrice.toString(), blockNumber: r.blockNumber.toString() }));
if (r.status !== "success") process.exit(1);
