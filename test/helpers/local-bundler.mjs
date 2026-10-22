// A minimal ERC-4337 v0.7 bundler for local tests ONLY: an HTTP JSON-RPC endpoint (CORS-open, loopback) that takes user
// operations for the pinned EntryPoint and submits them with handleOps from its own fresh key, which the EntryPoint repays
// out of the account's prefund. It is not a production bundler: it does not run the ERC-7562 validation rules, and its gas
// estimate is a fixed, generous answer (the page adds its own margins and simulates the exact operation before sending).
//   const b = await startLocalBundler({ rpcUrl, entryPoint, chain }); ... b.url, b.mode = "hold" | "submit", b.release(), b.received, b.stop()
import http from "node:http";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const U = (v) => viem.pad(viem.toHex(BigInt(v)), { size: 16 });
const EXECUTE_ABI = [{ type: "function", name: "executeUserOp", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], outputs: [] }];
const PACKED = { type: "tuple", components: ["address sender", "uint256 nonce", "bytes initCode", "bytes callData", "bytes32 accountGasLimits",
  "uint256 preVerificationGas", "bytes32 gasFees", "bytes paymasterAndData", "bytes signature"].map((s) => { const [type, name] = s.split(" "); return { type, name }; }) };
const EP_ABI = [
  { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ type: "tuple[]", components: PACKED.components }, { type: "address" }], outputs: [] },
  { type: "function", name: "getUserOpHash", stateMutability: "view", inputs: [PACKED], outputs: [{ type: "bytes32" }] },
];
export const packOp = (op) => ({ sender: op.sender, nonce: BigInt(op.nonce), initCode: op.factory ? viem.concat([op.factory, op.factoryData]) : "0x", callData: op.callData,
  accountGasLimits: viem.concat([U(op.verificationGasLimit), U(op.callGasLimit)]), preVerificationGas: BigInt(op.preVerificationGas),
  gasFees: viem.concat([U(op.maxPriorityFeePerGas), U(op.maxFeePerGas)]),
  paymasterAndData: op.paymaster ? viem.concat([op.paymaster, U(op.paymasterVerificationGasLimit), U(op.paymasterPostOpGasLimit || 0), op.paymasterData || "0x"]) : "0x",
  signature: op.signature });

export async function startLocalBundler({ rpcUrl, entryPoint, chain, setBalance }){
  const key = privateKeyToAccount(generatePrivateKey());
  await setBalance(key.address, "0x56bc75e2d63100000");               // the bundler's own gas money (local fork state only)
  const pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
  const wc = viem.createWalletClient({ chain, account: key, transport: viem.http(rpcUrl) });
  const b = { mode: "submit", received: [], held: [], submitted: [], pmCalls: [], paymaster: null, key: key.address };
  const submit = async (packed) => {
    const h = await wc.writeContract({ address: entryPoint, abi: EP_ABI, functionName: "handleOps", args: [[packed], key.address], gas: 6_000_000n });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    b.submitted.push(h);
    return rc;
  };
  b.release = async () => { const q = b.held.splice(0); for (const p of q) await submit(p); return q.length; };
  const answer = async (method, params) => {
    if (method === "eth_chainId") return "0x" + chain.id.toString(16);
    if (method === "eth_supportedEntryPoints") return [entryPoint];
    if (method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
    if (method === "eth_estimateUserOperationGas"){
      const [op, ep] = params;
      if (String(ep).toLowerCase() !== entryPoint.toLowerCase()) throw new Error("unsupported entry point");
      // call gas: the account's own call, measured from the account (a bundler simulates execution); a counterfactual
      // account's first call is measured the same way (no code is needed at the sender for a plain call). Verification is
      // a fixed allowance for WebAuthn plus, on creation, the Safe's setup.
      let call = 100_000n;
      try {
        const { args: [to, value, data, operation] } = viem.decodeFunctionData({ abi: EXECUTE_ABI, data: op.callData });
        if (Number(operation) === 0) call = await pc.estimateGas({ account: op.sender, to, value, data }) + 80_000n;
      } catch {}
      if (b.underestimateCallGas) call = 50_000n;
      return { verificationGasLimit: op.factory ? "0xc3500" : "0x55730", callGasLimit: viem.toHex(call), preVerificationGas: "0xea60" };
    }
    // ERC-7677, for an owner-chosen test paymaster (b.paymaster): stub data, then the final data for the exact limits
    if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData"){
      if (!b.paymaster) throw new Error("no paymaster here");
      b.pmCalls.push(method);
      return method === "pm_getPaymasterStubData"
        ? { paymaster: b.paymaster, paymasterData: "0x", paymasterVerificationGasLimit: "0x186a0", paymasterPostOpGasLimit: "0x0", isFinal: false }
        : { paymaster: b.paymaster, paymasterData: "0x" };
    }
    if (method === "eth_sendUserOperation"){
      const [op, ep] = params;
      if (String(ep).toLowerCase() !== entryPoint.toLowerCase()) throw new Error("unsupported entry point");
      const packed = packOp(op);
      const hash = await pc.readContract({ address: entryPoint, abi: EP_ABI, functionName: "getUserOpHash", args: [packed] });
      b.received.push({ hash: hash.toLowerCase(), sender: op.sender.toLowerCase(), nonce: BigInt(op.nonce), factory: op.factory || null });
      if (b.mode === "hold") b.held.push(packed);
      else await submit(packed);
      return hash;
    }
    throw new Error("method not supported by this local bundler: " + method);
  };
  b.server = http.createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS"){ res.writeHead(204, cors); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    let id = null;
    try {
      const j = JSON.parse(body); id = j.id;
      const result = await answer(j.method, j.params || []);
      res.writeHead(200, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e){
      res.writeHead(200, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32500, message: String(e.shortMessage || e.message || e).slice(0, 300) } }));
    }
  });
  await new Promise((r) => b.server.listen(0, "127.0.0.1", r));
  b.url = `http://127.0.0.1:${b.server.address().port}/rpc`;
  b.stop = () => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); });
  return b;
}
