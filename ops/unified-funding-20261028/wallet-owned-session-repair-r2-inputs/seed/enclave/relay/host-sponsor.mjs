// relay/host-sponsor.mjs -- a new host's first registration, paid by EnclaveHostPaymaster (contracts/), for boxes
// that proved real hardware to this relay.
//
// A box joining as a host registers itself in EnclaveRegistry from its operator key, which used to mean buying gas
// first. Now the box attaches (relay/tunnel.js) under a name nobody registered yet, proving its hardware - for a
// Windows hv-node: the TPM endorsement certificate chained to a pinned manufacturer root, credential activation tying
// the attestation key to that TPM, a quote over this relay's nonce, Secure Boot - and its v2 attach signature names the
// operator key that will register it, bound to that transport key on that TPM (the tunnel's `claimant`). Then:
//
//   POST /v1/hosts/sponsor/voucher  the box sends the ERC-4337 operation (its operator key delegated to the standard
//                                   Simple7702Account by EIP-7702) calling register() for ITS OWN endpoint; the relay
//                                   checks it all and signs the paymaster's voucher (EIP-712, HostSponsorship);
//   POST /v1/hosts/sponsor/submit   the box sends the operation signed by its operator key and the key's EIP-7702
//                                   authorization; the relay simulates it, sends EntryPoint.handleOps from its bundler
//                                   key (repaid by the EntryPoint from the paymaster's deposit) and answers the result.
//
// Both requests are signed by the box's ATTESTED transport key (the same scheme as relay/pads.mjs). The hardware id is
// the EK certificate's sha256; the paymaster records it on chain, so each TPM is sponsored once whatever this relay does.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createPublicClient, createWalletClient, http as viemHttp, decodeFunctionData, encodeFunctionData, getAddress,
         isAddress, keccak256, toBytes, hexToBigInt, sliceHex, concat, numberToHex, pad, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import { base } from "viem/chains";

export const ENTRYPOINT_08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const SIMPLE_7702 = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
// What a sponsored registration may ask for. The paymaster caps the total cost on chain as well; these keep a voucher
// from vouching for an operation the EntryPoint would refuse anyway, or one priced to waste the deposit.
export const LIMITS = Object.freeze({ verificationGas: 200_000n, callGas: 500_000n, preVerificationGas: 120_000n,
                                      paymasterVerificationGas: 200_000n, paymasterPostOpGas: 100_000n,
                                      maxFeePerGas: 1_000_000_000n /* 1 gwei; Base runs at ~0.01 */ });
const VOUCHER_TTL_SEC = 600;

const REGISTRY_ABI = parseAbi(["function register(string endpoint, string repo, bytes32 measurement, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey) returns (bytes32)"]);
const ACCOUNT_ABI = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
const PAYMASTER_ABI = parseAbi(["function hardwareSponsored(bytes32) view returns (address)", "function operatorSponsored(address) view returns (bytes32)"]);
const ENTRYPOINT_ABI = [{ type: "function", name: "handleOps", stateMutability: "nonpayable", outputs: [], inputs: [
  { name: "ops", type: "tuple[]", components: [
    { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] },
  { name: "beneficiary", type: "address" }] }];
const USEROP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";   // UserOperationEvent

const hex = (v) => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const hexN = (v, bytes) => hex(v) && v.length === 2 + 2 * bytes;
const bad = (status, error, message) => ({ status, body: { error, message } });

/** The canonical message a box signs for a sponsorship request (its attested transport key). */
export function sponsorMessage(kind, name, op, nonce) {
  const opDigest = createHash("sha256").update(JSON.stringify(canonicalOp(op))).digest("hex");
  return ["enclave-host-sponsor-" + kind, name, opDigest, nonce].join("\n");
}
/** The operation's fields in a fixed order, numbers as decimal strings: what is signed is what is checked. */
export function canonicalOp(op) {
  const keys = ["sender", "nonce", "initCode", "callData", "accountGasLimits", "preVerificationGas", "gasFees",
                "paymasterAndData", "signature"];
  return keys.map((k) => [k, op[k] === undefined ? null : String(op[k])]);
}

/** Split the packed gas words. */
export function unpackOp(op) {
  const word = (h) => hexToBigInt(h);
  const agl = word(op.accountGasLimits), fees = word(op.gasFees);
  return { verificationGas: agl >> 128n, callGas: agl & ((1n << 128n) - 1n), maxPriorityFeePerGas: fees >> 128n,
           maxFeePerGas: fees & ((1n << 128n) - 1n), preVerificationGas: BigInt(op.preVerificationGas) };
}

/**
 * hostSponsor({ hub, endpointOf, ownerOf, verifierKey, bundlerKey, paymaster, rpc, log }) -> { voucher(body), submit(body) },
 * each answering { status, body }. `endpointOf(name)` is the registry endpoint a box under that tunnel name registers
 * (https://api.enclave.host/t/<name>); `ownerOf(name)` its on-chain operator, or "" when unregistered.
 */
export function hostSponsor({ hub, endpointOf, ownerOf, verifierKey, bundlerKey, paymaster, registry, rpc, log = () => {},
                              client = null, wallet = null, now = () => Math.floor(Date.now() / 1000) }) {
  const verifier = privateKeyToAccount(verifierKey);
  const bundler = privateKeyToAccount(bundlerKey);
  const pub = client || createPublicClient({ chain: base, transport: viemHttp(rpc) });
  const wal = wallet || createWalletClient({ chain: base, account: bundler, transport: viemHttp(rpc) });
  paymaster = getAddress(paymaster); registry = getAddress(registry);
  const seen = new Map();                                     // request nonces, for ten minutes: a replay asks nothing new

  /** The attested caller, its hardware id and the operator key it named at attach; or why not. */
  function callerOf(kind, b) {
    const t = hub && hub.info ? hub.info(String(b.name || "")) : null;
    if (!t || !t.spki) return bad(404, "unknown_tunnel", "no attested tunnel by that name");
    if (t.mode !== "hv-node" || !t.hvNode || !t.hvNode.boot || !/^[0-9a-f]{64}$/.test(String(t.hvNode.boot.ekCertSha256 || "")))
      return bad(403, "not_hardware_attested", "sponsorship is for a box that proved its hardware (a TPM-attested hv-node) on this relay");
    if (!t.claimant) return bad(403, "no_claimant", "this box attached without naming its operator key (a v2 attach signature), or its name is already registered");
    if (typeof b.nonce !== "string" || !/^[0-9a-f]{32,128}$/.test(b.nonce) || b.nonce.length % 2)
      return bad(400, "bad_nonce", "nonce must be 16..64 bytes lowercase hex");
    const cut = Date.now() - 600_000;
    for (const [k, at] of seen) if (at < cut) seen.delete(k);
    if (seen.has(b.nonce)) return bad(409, "replayed", "that request nonce was used already");
    let key, ok = false;
    try { key = createPublicKey({ key: Buffer.from(t.spki, "base64"), format: "der", type: "spki" }); }
    catch { return bad(403, "bad_key", "the tunnel's transport key is not a public key"); }
    try {
      ok = cryptoVerify(key.asymmetricKeyType === "ed25519" ? null : "sha256", Buffer.from(sponsorMessage(kind, b.name, b.op || {}, b.nonce)),
                        key, Buffer.from(String(b.sig || ""), "hex"));
    } catch {}
    if (!ok) return bad(403, "bad_signature", "the request is not signed by this tunnel's attested transport key");
    seen.set(b.nonce, Date.now());
    return { tunnel: t, hardwareId: "0x" + t.hvNode.boot.ekCertSha256, claimant: getAddress(t.claimant) };
  }

  /** The operation must be the claimant's execute(registry, 0, register(<this box's endpoint>, ...)), within the limits. */
  async function checkOp(op, c, name) {
    for (const k of ["sender", "callData", "accountGasLimits", "gasFees"]) if (!hex(op[k])) return `op.${k} is not hex`;
    if (!isAddress(op.sender) || getAddress(op.sender) !== c.claimant) return `op.sender must be the operator key this box named at attach (${c.claimant})`;
    if (!hexN(op.accountGasLimits, 32) || !hexN(op.gasFees, 32)) return "op gas words must be 32 bytes";
    if (!/^\d+$/.test(String(op.nonce)) || !/^\d+$/.test(String(op.preVerificationGas))) return "op.nonce and op.preVerificationGas are decimal";
    if (op.initCode && op.initCode !== "0x") return "op.initCode must be empty (the key is delegated by EIP-7702)";
    let outer, inner;
    try { outer = decodeFunctionData({ abi: ACCOUNT_ABI, data: op.callData }); } catch { return "op.callData is not execute(address,uint256,bytes)"; }
    const [target, value, data] = outer.args;
    if (getAddress(target) !== registry || value !== 0n) return "op must call the registry with no value";
    try { inner = decodeFunctionData({ abi: REGISTRY_ABI, data }); } catch { return "op must call register()"; }
    const endpoint = endpointOf(name);
    if (inner.args[0] !== endpoint) return `a box under ${name} registers ${endpoint}, not ${String(inner.args[0]).slice(0, 120)}`;
    const g = unpackOp(op);
    if (g.verificationGas > LIMITS.verificationGas || g.callGas > LIMITS.callGas || g.preVerificationGas > LIMITS.preVerificationGas)
      return "op gas limits exceed what a registration needs";
    if (g.maxFeePerGas > LIMITS.maxFeePerGas || g.maxPriorityFeePerGas > g.maxFeePerGas) return "op fees exceed the sponsored maximum";
    if (await ownerOf(name)) return `${name} is registered already`;
    if ((await pub.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "hardwareSponsored", args: [c.hardwareId] }))
        !== "0x0000000000000000000000000000000000000000") return "this machine's registration was sponsored already";
    if ((await pub.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "operatorSponsored", args: [c.claimant] }))
        !== pad("0x", { size: 32 })) return "this operator key's registration was sponsored already";
    return null;
  }

  async function voucher(b) {
    const c = callerOf("voucher", b);
    if (c.status) return c;
    const op = b.op || {};
    if (!hexN(op.paymasterGasLimits, 32)) return bad(400, "bad_op", "op.paymasterGasLimits must be 32 bytes");
    const pg = hexToBigInt(op.paymasterGasLimits);
    if (pg >> 128n > LIMITS.paymasterVerificationGas || (pg & ((1n << 128n) - 1n)) > LIMITS.paymasterPostOpGas)
      return bad(400, "bad_op", "paymaster gas limits exceed what a registration needs");
    let why;
    try { why = await checkOp(op, c, b.name); } catch (e) { return bad(502, "chain_unreadable", e.shortMessage || e.message); }
    if (why) return bad(403, "not_sponsored", why);
    const validUntil = now() + VOUCHER_TTL_SEC, validAfter = 0;
    const signature = await verifier.signTypedData({
      domain: { name: "EnclaveHostPaymaster", version: "1", chainId: base.id, verifyingContract: paymaster },
      types: { HostSponsorship: [
        { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCodeHash", type: "bytes32" },
        { name: "callDataHash", type: "bytes32" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
        { name: "gasFees", type: "bytes32" }, { name: "paymasterGasLimits", type: "bytes32" }, { name: "hardwareId", type: "bytes32" },
        { name: "validUntil", type: "uint48" }, { name: "validAfter", type: "uint48" }] },
      primaryType: "HostSponsorship",
      message: { sender: c.claimant, nonce: BigInt(op.nonce), initCodeHash: keccak256("0x"), callDataHash: keccak256(op.callData),
                 accountGasLimits: op.accountGasLimits, preVerificationGas: BigInt(op.preVerificationGas), gasFees: op.gasFees,
                 paymasterGasLimits: op.paymasterGasLimits, hardwareId: c.hardwareId, validUntil, validAfter } });
    const paymasterAndData = concat([paymaster, op.paymasterGasLimits, c.hardwareId, numberToHex(validUntil, { size: 6 }),
                                     numberToHex(validAfter, { size: 6 }), signature]);
    log(`[sponsor] voucher for ${b.name}: operator ${c.claimant}, hardware ${c.hardwareId.slice(0, 18)}…, until ${validUntil}`);
    return { status: 200, body: { paymasterAndData, validUntil, hardwareId: c.hardwareId, paymaster, entryPoint: ENTRYPOINT_08 } };
  }

  async function submit(b) {
    const c = callerOf("submit", b);
    if (c.status) return c;
    const op = b.op || {}, auth = b.authorization || {};
    let why;
    try { why = await checkOp(op, c, b.name); } catch (e) { return bad(502, "chain_unreadable", e.shortMessage || e.message); }
    if (why) return bad(403, "not_sponsored", why);
    if (!hex(op.paymasterAndData) || getAddress(sliceHex(op.paymasterAndData, 0, 20)) !== paymaster)
      return bad(400, "bad_op", "op.paymasterAndData must carry this relay's voucher for the host paymaster");
    if (!hex(op.signature)) return bad(400, "bad_op", "op.signature is not hex");
    // the operator key's EIP-7702 authorization: delegate to the standard account, on Base, signed by that very key
    const authorization = { address: auth.address, chainId: Number(auth.chainId), nonce: Number(auth.nonce),
                            r: auth.r, s: auth.s, yParity: Number(auth.yParity) };
    if (!isAddress(authorization.address || "") || getAddress(authorization.address) !== SIMPLE_7702 || authorization.chainId !== base.id)
      return bad(400, "bad_authorization", `the authorization must delegate to Simple7702Account ${SIMPLE_7702} on Base`);
    let signer;
    try { signer = await recoverAuthorizationAddress({ authorization }); } catch { signer = null; }
    if (!signer || getAddress(signer) !== c.claimant) return bad(400, "bad_authorization", "the authorization is not signed by the operator key");
    const packed = { ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas), initCode: "0x" };
    delete packed.paymasterGasLimits;
    const data = encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "handleOps", args: [[packed], bundler.address] });
    try {
      await pub.call({ account: bundler, to: ENTRYPOINT_08, data, authorizationList: [authorization] });   // a revert costs nothing yet
    } catch (e) { return bad(422, "simulation_failed", `the operation would fail: ${(e.shortMessage || e.message).slice(0, 300)}`); }
    let hash, rcpt;
    try {
      hash = await wal.sendTransaction({ to: ENTRYPOINT_08, data, authorizationList: [authorization] });
      rcpt = await pub.waitForTransactionReceipt({ hash });
    } catch (e) { return bad(502, "not_sent", (e.shortMessage || e.message).slice(0, 300)); }
    const ev = rcpt.logs.find((l) => l.address.toLowerCase() === ENTRYPOINT_08.toLowerCase() && l.topics[0] === USEROP_EVENT);
    // UserOperationEvent data: nonce, success, actualGasCost, actualGasUsed
    const success = !!ev && hexToBigInt(sliceHex(ev.data, 32, 64)) === 1n;
    log(`[sponsor] ${b.name}: register by ${c.claimant} ${success ? "SUCCEEDED" : "REVERTED"} in ${hash}`);
    return { status: success ? 200 : 409, body: { tx: hash, success, ...(success ? {} : { error: "register_reverted", message: "the registration reverted on chain; the paymaster gave the sponsorship back" }) } };
  }

  return { voucher, submit, verifier: verifier.address, bundler: bundler.address };
}

/** The relay's routes: POST /v1/hosts/sponsor/{voucher,submit}; off (404) unless configured. */
export function hostSponsorRouter({ sponsor, json, readBody }) {
  return async (req, res, url) => {
    const p = url.pathname;
    if (p !== "/v1/hosts/sponsor/voucher" && p !== "/v1/hosts/sponsor/submit") return false;
    if (!sponsor) { json(res, 404, { error: "not_offered", message: "this relay sponsors no host registrations" }); return true; }
    if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    let b;
    try { b = JSON.parse(String(await readBody(req, 64 * 1024))); } catch { json(res, 400, { error: "bad_json" }); return true; }
    if (!b || typeof b !== "object") { json(res, 400, { error: "bad_json" }); return true; }
    const r = await (p.endsWith("/voucher") ? sponsor.voucher(b) : sponsor.submit(b));
    json(res, r.status, r.body);
    return true;
  };
}
