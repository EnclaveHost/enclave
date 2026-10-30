// windows/node/sponsor.mjs -- register this box without buying gas first: EnclaveHostPaymaster pays the operator key's
// first register(), once the relay has seen this box prove its hardware (relay/host-sponsor.mjs).
//
// The operator key stays an ordinary key. For this one operation it is delegated (EIP-7702) to the standard
// Simple7702Account, so the ERC-4337 EntryPoint v0.8 can run execute(registry, 0, register(...)) from it with the
// paymaster paying; the registry sees the operator key as msg.sender, exactly as when it pays its own gas.
//
//   1. build the operation; ask the relay for the paymaster's voucher (signed with this box's ATTESTED transport key);
//   2. sign the operation (its EntryPoint hash) and the EIP-7702 authorization with the operator key;
//   3. hand both to the relay, which simulates and sends them, and answers whether register() went through.
import { createHash, sign as cryptoSign } from "node:crypto";
import { encodeFunctionData, numberToHex, pad, parseAbi, getAddress, toHex } from "viem";

export const ENTRYPOINT_08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const SIMPLE_7702 = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
// Generous for a register() (198,704 gas measured on a Base fork) and inside the relay's LIMITS.
export const GAS = Object.freeze({ verification: 150_000n, call: 400_000n, preVerification: 100_000n,
                                   paymasterVerification: 150_000n, paymasterPostOp: 80_000n });
const REGISTRY_ABI = parseAbi(["function register(string endpoint, string repo, bytes32 measurement, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey) returns (bytes32)"]);
const ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
const EP_ABI = [
  { type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getUserOpHash", stateMutability: "view", outputs: [{ type: "bytes32" }], inputs: [{ name: "op", type: "tuple", components: [
    { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] }] }];

const word = (hi, lo) => pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 });

/** The relay's canonical request message (relay/host-sponsor.mjs sponsorMessage; kept byte-identical, tested). */
export function canonicalOp(op) {
  const keys = ["sender", "nonce", "initCode", "callData", "accountGasLimits", "preVerificationGas", "gasFees",
                "paymasterAndData", "signature"];
  return keys.map((k) => [k, op[k] === undefined ? null : String(op[k])]);
}
export function sponsorMessage(kind, name, op, nonce) {
  const opDigest = createHash("sha256").update(JSON.stringify(canonicalOp(op))).digest("hex");
  return ["enclave-host-sponsor-" + kind, name, opDigest, nonce].join("\n");
}

/**
 * sponsoredRegister({ relayBase, name, transportKey, operator, client, registry, args, fetchImpl, log })
 *   relayBase     https://api.enclave.host (the relay this box is attached to)
 *   name          this box's tunnel name; the relay only sponsors register(<relay>/t/<name>)
 *   transportKey  the Ed25519 private KeyObject the relay verified at attach (hvnode-evidence.mjs)
 *   operator      the viem LOCAL account of the operator key (it signs the operation and the 7702 authorization)
 *   client        a viem public client on Base
 *   args          { endpoint, repo, measurement, cpuPricePerSec6, gpuPricePerSec6, proofKey }
 * -> { tx, success } or throws with the relay's reason.
 */
export async function sponsoredRegister({ relayBase, name, transportKey, operator, client, registry, args, fetchImpl = fetch, log = () => {} }) {
  const sender = getAddress(operator.address);
  const inner = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "register",
    args: [args.endpoint, args.repo, args.measurement, BigInt(args.cpuPricePerSec6), BigInt(args.gpuPricePerSec6), args.proofKey] });
  const callData = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [getAddress(registry), 0n, inner] });
  const [nonce, block] = await Promise.all([client.readContract({ address: ENTRYPOINT_08, abi: EP_ABI, functionName: "getNonce", args: [sender, 0n] }),
                                            client.getBlock()]);
  const priority = 1_000_000n;                                           // 0.001 gwei: Base is not congested
  const maxFee = (block.baseFeePerGas || 0n) * 2n + priority;
  const op = { sender, nonce: String(nonce), initCode: "0x", callData,
               accountGasLimits: word(GAS.verification, GAS.call), preVerificationGas: String(GAS.preVerification),
               gasFees: word(priority, maxFee) };
  const paymasterGasLimits = word(GAS.paymasterVerification, GAS.paymasterPostOp);

  const post = async (kind, body) => {
    const reqNonce = createHash("sha256").update(String(Math.random()) + Date.now() + kind).digest("hex").slice(0, 32);
    const sig = cryptoSign(null, Buffer.from(sponsorMessage(kind, name, body.op, reqNonce)), transportKey).toString("hex");
    const r = await fetchImpl(`${relayBase}/v1/hosts/sponsor/${kind}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...body, nonce: reqNonce, sig }) });
    let j = {}; try { j = await r.json(); } catch {}
    if (r.status !== 200) throw new Error(`the relay did not sponsor this registration (${kind}, HTTP ${r.status}): ${j.message || j.error || "no reason given"}`);
    return j;
  };

  const v = await post("voucher", { op: { ...op, paymasterGasLimits } });
  log(`registry: the relay vouched for this box's registration (hardware ${String(v.hardwareId).slice(0, 18)}…); signing it`);
  const full = { ...op, paymasterAndData: v.paymasterAndData };
  const userOpHash = await client.readContract({ address: ENTRYPOINT_08, abi: EP_ABI, functionName: "getUserOpHash",
    args: [{ ...full, nonce: BigInt(full.nonce), preVerificationGas: BigInt(full.preVerificationGas), signature: "0x" }] });
  const signature = await operator.sign({ hash: userOpHash });         // Simple7702Account: ECDSA over the hash itself
  const authorization = await operator.signAuthorization({ contractAddress: SIMPLE_7702, chainId: client.chain?.id ?? 8453,
                                                           nonce: await client.getTransactionCount({ address: sender }) });
  const result = await post("submit", { op: { ...full, signature },
    authorization: { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce,
                     r: authorization.r, s: authorization.s, yParity: authorization.yParity } });
  return result;
}
