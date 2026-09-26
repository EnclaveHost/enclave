// usdc-to-operator.mjs <amount USDC> - ROLLOUT.md step 8.1: the agent wallet funds the NucBox operator with a few cents
// of USDC so the operator can own and fund the operator-owned test app (enclave-87 approved "a few cents"). One
// transfer, from the agent wallet whose key comes ONLY from the environment (ETH_AGENT_WALLET); nothing is written.
// Run from a directory whose node_modules has viem:  cd ~/Projects/enclave && ETH_AGENT_WALLET=… node <this> 0.10
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const OPERATOR = "0x389C3f030a209D04D026228D2D053fEB75DbadcA";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const amount = process.argv[2];
if (!/^0\.\d{1,6}$/.test(amount || "") || Number(amount) > 0.5) { console.error("usage: node usdc-to-operator.mjs <0.xx USDC, at most 0.5>"); process.exit(2); }
const k = (process.env.ETH_AGENT_WALLET || "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) { console.error("ETH_AGENT_WALLET is not set"); process.exit(2); }
const account = privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
if (account.address.toLowerCase() !== "0x29479bf04ed889d46a7afb7f292b9bb26e12647c") { console.error(`not the agent wallet (${account.address})`); process.exit(2); }
const pub = createPublicClient({ chain: base, transport: http("https://base.drpc.org", { retryCount: 2 }) });
const wal = createWalletClient({ account, chain: base, transport: http("https://base.drpc.org") });
const before = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OPERATOR] });
const hash = await wal.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [OPERATOR, parseUnits(amount, 6)] });
const r = await pub.waitForTransactionReceipt({ hash });
const after = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OPERATOR] });
console.log(`transfer ${amount} USDC -> ${OPERATOR}: tx ${hash} ${r.status}; operator USDC ${formatUnits(before, 6)} -> ${formatUnits(after, 6)}`);
if (r.status !== "success") process.exit(1);
