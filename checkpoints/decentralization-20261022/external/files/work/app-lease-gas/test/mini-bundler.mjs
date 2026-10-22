// A minimal bundler-style JSON-RPC endpoint for LOCAL tests: eth_sendUserOperation (ERC-7769 JSON, EntryPoint v0.8,
// eip7702Auth) -> EntryPoint.handleOps from its own funded key, simulated first. It is NOT a production bundler: it
// does not run the ERC-7562 validation tracer or keep a mempool (test/erc7562-check.mjs checks the paymaster's
// validation separately); it stands for "any independent submitter".
import http from "node:http";
import * as viem from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as C from "../client/lease-gas-client.mjs";

export async function startMiniBundler({ pc, chain, rpcUrl, key, onResult = () => {} }) {
  const wallet = viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(rpcUrl) });
  const received = [];
  const server = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    let id = null, method, params;
    try { ({ id, method, params } = JSON.parse(Buffer.concat(c).toString())); } catch {}
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, ...o })); };
    if (method !== "eth_sendUserOperation") return reply({ error: { code: -32601, message: "method not found" } });
    const u = params[0], u16 = (v) => viem.pad(viem.toHex(BigInt(v)), { size: 16 });
    received.push(u);
    const op = { sender: u.sender, nonce: BigInt(u.nonce), initCode: "0x", callData: u.callData,
      accountGasLimits: viem.concat([u16(u.verificationGasLimit), u16(u.callGasLimit)]), preVerificationGas: BigInt(u.preVerificationGas),
      gasFees: viem.concat([u16(u.maxPriorityFeePerGas), u16(u.maxFeePerGas)]),
      paymasterAndData: viem.concat([u.paymaster, u16(u.paymasterVerificationGasLimit), u16(u.paymasterPostOpGasLimit), u.paymasterData]),
      signature: u.signature };
    const auth = u.eip7702Auth ? { address: u.eip7702Auth.address, chainId: Number(u.eip7702Auth.chainId), nonce: Number(u.eip7702Auth.nonce),
                                   yParity: Number(u.eip7702Auth.yParity), r: u.eip7702Auth.r, s: u.eip7702Auth.s } : null;
    try {
      const userOpHash = await pc.readContract({ address: C.ENTRYPOINT_08, abi: C.EP_ABI, functionName: "getUserOpHash", args: [op] });
      const r = await C.submitDirect({ client: pc, wallet, op, authorization: auth });   // simulated, then sent: only what lands is accepted
      onResult({ userOpHash, ...r });
      reply({ result: userOpHash });
    } catch (e) { reply({ error: { code: -32500, message: e.message.slice(0, 300) } }); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}
