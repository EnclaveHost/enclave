// network/direct-chain.mjs against a REAL chain (anvil, chain 8453, one block per second) behind three proxies that can
// lose answers, refuse, or lie (test/helpers/lying-peers.mjs). The supervisor's write path in direct mode:
//   * the signed bytes go to every peer exactly once; a lost answer is a PENDING transaction (the local hash), never an
//     error that invites a second signature, and the agreed receipt then decides;
//   * every peer definitely refusing is a definite failure: nothing is pending, the nonce does not move;
//   * the nonce is the AGREED pending nonce: one peer disagreeing stops the transaction before it is signed or sent;
//   * reads: logs agreed or refused, a snapshot scope reads ONE block, an agreed revert is a fact.
// Only anvil's published dev keys are used.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, encodeDeployData, keccak256, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startLyingPeers } from "./helpers/lying-peers.mjs";
import { freePort } from "./helpers/cli-independent-rig.mjs";
import { createDirectChain, directChainClient, quorumWalletTransport, broadcastSigned, pendingNonce } from "../network/direct-chain.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "contracts", "foundry", "out");
const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return "needs anvil"; }
  return fs.existsSync(path.join(OUT, "SessionMocks.sol", "MockUSDC3009.json")) ? null : "needs the Foundry build"; })();
const T = skip ? { skip } : { timeout: 120000 };
const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";   // anvil #2 (published)
const ME = privateKeyToAccount(KEY);
const local = { id: 8453, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [] } } };
let anvil, rpc, pc, usdc, peers, stops = [];
const art = JSON.parse(fs.readFileSync(path.join(OUT, "SessionMocks.sol", "MockUSDC3009.json"), "utf8"));
const ERC20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"]);

const chainOf = (q) => createDirectChain({ BASE_RPCS: peers.map((p) => p.url).join(","), CHAIN_QUORUM: String(q), CHAIN_CONFIRMATIONS: "0", CHAIN_MAX_BLOCK_AGE_SEC: "60" });
const sendRaw = (p) => p.ctl.calls.filter((c) => c.method === "eth_sendRawTransaction").length;
async function signedTransfer(n) {
  const nonce = await pc.getTransactionCount({ address: ME.address });
  return ME.signTransaction({ chainId: 8453, type: "eip1559", to: ME.address, value: BigInt(n), nonce, gas: 21000n, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n });
}
async function mined(hash, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms;) { const r = await pc.getTransactionReceipt({ hash }).catch(() => null); if (r) return r; await new Promise((ok) => setTimeout(ok, 200)); } return null; }

before(async () => {
  if (skip) return;
  const port = await freePort();
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--block-time", "1", "--silent"], { stdio: "ignore" });
  rpc = `http://127.0.0.1:${port}`;
  pc = createPublicClient({ chain: local, transport: http(rpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
  const w = createWalletClient({ chain: local, account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), transport: http(rpc) });
  const rc = await pc.waitForTransactionReceipt({ hash: await w.sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object }) }) });
  usdc = getAddress(rc.contractAddress);
  peers = await startLyingPeers(rpc, { stops });
});
after(async () => { for (const s of stops) await s(); anvil?.kill("SIGKILL"); });

test("a lost broadcast answer is a PENDING transaction: the same bytes once per peer, never an error, and the agreed receipt decides", T, async () => {
  peers.honest(); for (const p of peers) p.ctl.send = "lost";
  const { chain } = chainOf(3);
  const raw = await signedTransfer(1), logs = [];
  const hash = await broadcastSigned(chain, raw, { log: (m) => logs.push(m) });
  assert.equal(hash, keccak256(raw)); assert.match(logs[0], /ambiguous.*PENDING.*never resent/);
  assert.deepEqual(peers.map(sendRaw), [1, 1, 1], "each peer got the bytes exactly once");
  assert.ok(await mined(hash), "it did reach the chain");
  const c = directChainClient(chain);
  let r = null; for (let i = 0; i < 40 && !r; i++) { r = await c.getTransactionReceipt({ hash }).catch(() => null); if (!r) await new Promise((ok) => setTimeout(ok, 250)); }
  assert.equal(r?.status, "success"); assert.equal(r.transactionHash, hash);
});

test("every peer definitely refusing is definite: it throws, nothing is pending, the nonce does not move", T, async () => {
  peers.honest(); for (const p of peers) p.ctl.send = "refuse";
  const { chain } = chainOf(2);
  const before = await pc.getTransactionCount({ address: ME.address });
  await assert.rejects(broadcastSigned(chain, await signedTransfer(2)), /every RPC refused the transaction; nothing is pending/);
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(await pc.getTransactionCount({ address: ME.address }), before);
  peers.honest(); peers[0].ctl.send = "refuse"; peers[1].ctl.send = "lost";
  const hash = await broadcastSigned(chain, await signedTransfer(3));
  assert.ok(await mined(hash), "one accepting peer is enough to know it is in flight");
});

test("the operator wallet's nonce is the AGREED pending nonce: one disagreeing peer stops the transaction before it is signed or sent", T, async () => {
  peers.honest();
  const { chain } = chainOf(3);
  const wallet = createWalletClient({ chain: local, account: ME, transport: quorumWalletTransport(chain) });
  const hash = await wallet.writeContract({ address: usdc, abi: ERC20, functionName: "mint", args: [ME.address, 5n] });
  assert.ok((await mined(hash))?.status === "success");
  assert.equal(await pendingNonce(chain, ME.address), await pc.getTransactionCount({ address: ME.address, blockTag: "pending" }));
  peers.honest(); peers[1].ctl.nonce = true;
  const before = await pc.getTransactionCount({ address: ME.address });
  await assert.rejects(wallet.writeContract({ address: usdc, abi: ERC20, functionName: "mint", args: [ME.address, 6n] }), /disagree on the pending nonce/);
  assert.deepEqual(peers.map(sendRaw), [0, 0, 0], "nothing was broadcast");
  assert.equal(await pc.getTransactionCount({ address: ME.address }), before);
});

test("reads: logs agree or refuse; a snapshot scope reads ONE block; an agreed revert is a fact with viem's wording", T, async () => {
  peers.honest();
  const w = createWalletClient({ chain: local, account: ME, transport: http(rpc) });
  for (const n of [7n, 8n]) await mined(await w.writeContract({ address: usdc, abi: ERC20, functionName: "mint", args: [ME.address, n] }));
  await new Promise((ok) => setTimeout(ok, 1500));
  const event = ERC20.find((x) => x.name === "Transfer");
  peers[2].ctl.logs = true;
  await assert.rejects(directChainClient(chainOf(3).chain).getLogs({ address: usdc, event, fromBlock: 0n }), /no 3 RPCs agreed/);
  const agreed = await directChainClient(chainOf(2).chain).getLogs({ address: usdc, event, fromBlock: 0n });
  const truth = await pc.getLogs({ address: usdc, event, fromBlock: 0n, toBlock: BigInt(agreed.at(-1).blockNumber) });
  assert.equal(agreed.length, truth.length, "the honest two agree; the dropping peer is outvoted");
  peers.honest();
  const c = directChainClient(chainOf(3).chain);
  await c.snapshotScope(async (s) => {
    await s.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [ME.address] });
    await new Promise((ok) => setTimeout(ok, 1500));   // a new block arrives in between
    await s.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [usdc] });
  });
  const blocks = new Set(peers.flatMap((p) => p.ctl.calls.filter((x) => x.method === "eth_call").map((x) => JSON.stringify(x.params[1]))));
  assert.equal(blocks.size, 1, "both reads, on every peer, at the scope's block: " + [...blocks].join(","));
  const revertAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
  const e = await c.simulateContract({ address: usdc, abi: revertAbi, functionName: "transfer", args: [ME.address, 10n ** 30n], account: privateKeyToAccount(KEY) }).catch((x) => x);
  assert.equal(e.agreedRevert, true); assert.match(e.shortMessage, /reverted/);
});
