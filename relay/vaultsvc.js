// Credit-vault service: the relay's thin bridge to EnclaveCreditVault.
//
// The relay NEVER holds authority over vault funds - every operation carries a
// WebAuthn P-256 signature from the customer's passkey, and the CONTRACT
// recomputes and verifies the signed digest on-chain. This module only:
//   - computes op digests for the site to display-and-sign (prepare); the
//     site independently recomputes the digest before signing, so a lying
//     relay cannot get a different op signed,
//   - wraps signed assertions into transactions and submits them, paying gas
//     (a relayer, not a custodian - the sender is irrelevant to the contract),
//   - deposits company USDC into vaults when a card top-up settles, and
//     deploys a customer's vault clone on first use.
// All company-wallet sends share ONE strictly-serial queue (same key as the
// legacy provisioner, which is dormant in the vault era - two writers on one
// nonce would race).
//
// Env: VAULT_FACTORY_ADDRESS (book key "vaultFactory" overrides), plus the
// PROVISIONER_PRIVATE_KEY wallet it reuses. Inert without both.

import { rid, rpcPool, rpcParts } from "./store.js";

const BOOK_KEY_VAULT_FACTORY = "0x" + Buffer.from("vaultFactory").toString("hex").padEnd(64, "0");
const BOOK_CACHE_MS = 10 * 60_000;

const FACTORY_ABI = [
  { type: "function", name: "vaultFor", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "createVault", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "address" }] },
];
const SIG_COMPONENTS = [
  { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
  { name: "r", type: "uint256" }, { name: "s", type: "uint256" },
  { name: "x", type: "uint256" }, { name: "y", type: "uint256" },
];
const VAULT_ABI = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deployAndFund", stateMutability: "nonpayable",
    inputs: [{ type: "bytes" }, { type: "uint256" }, { type: "uint256" }, { type: "tuple", components: SIG_COMPONENTS }],
    outputs: [{ type: "bytes32" }] },
  { type: "function", name: "fundDeployment", stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "tuple", components: SIG_COMPONENTS }], outputs: [] },
  { type: "function", name: "controlDeployment", stateMutability: "nonpayable",
    inputs: [{ type: "bytes" }, { type: "uint256" }, { type: "tuple", components: SIG_COMPONENTS }], outputs: [] },
  { type: "function", name: "refundToTreasury", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "tuple", components: SIG_COMPONENTS }], outputs: [] },
  { type: "event", name: "Deployed", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "funded6", type: "uint256" }] },
];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
// digest op tags - EXACTLY the contract's constants
const OP = {
  deploy:  "EnclaveVault.deployAndFund.v1",
  fund:    "EnclaveVault.fundDeployment.v1",
  control: "EnclaveVault.controlDeployment.v1",
  refund:  "EnclaveVault.refundToTreasury.v1",
};

let cfg = null;            // { usdc, addressBook, chainId }
let account = null, wallet = null;
let factoryEnv = "";
let _factory = { addr: null, at: 0 };
let viem = null;

export async function initVault(c) {
  cfg = c;
  factoryEnv = (process.env.VAULT_FACTORY_ADDRESS || "").trim();
  const pk = (process.env.PROVISIONER_PRIVATE_KEY || "").trim();
  if (!pk) { console.log("[vault] PROVISIONER_PRIVATE_KEY unset - credit vaults disabled"); return; }
  viem = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  account = privateKeyToAccount(pk);
  const { chain, transport } = await rpcParts();
  const { createWalletClient } = viem;
  wallet = createWalletClient({ account, chain, transport });
  const f = await factoryAddress().catch(() => null);
  console.log(`[vault] ${f ? "enabled - factory " + f : "no factory address yet (env VAULT_FACTORY_ADDRESS or book key vaultFactory) - vaults dark"} · relayer ${account.address}`);
}

export function vaultEnabled() { return !!wallet; }

export async function factoryAddress() {
  if (_factory.addr && Date.now() - _factory.at < BOOK_CACHE_MS) return _factory.addr;
  let addr = factoryEnv;
  try {
    const pub = await rpcPool();
    const a = await pub.readContract({ address: cfg.addressBook, abi:
      [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }],
      functionName: "addr", args: [BOOK_KEY_VAULT_FACTORY] });
    if (a && !/^0x0{40}$/i.test(a)) addr = a;
  } catch { /* keep env fallback */ }
  if (!addr) throw new Error("no vault factory configured");
  _factory = { addr, at: Date.now() };
  return addr;
}

export async function vaultAddressFor(key) {
  const pub = await rpcPool();
  return pub.readContract({ address: await factoryAddress(), abi: FACTORY_ABI,
    functionName: "vaultFor", args: [BigInt(key.x), BigInt(key.y)] });
}

export async function vaultInfo(key) {
  const pub = await rpcPool();
  const address = await vaultAddressFor(key);
  const [code, balance6] = await Promise.all([
    pub.getCode({ address }).catch(() => null),
    pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
  ]);
  const deployed = !!(code && code !== "0x");
  const nonce = deployed
    ? await pub.readContract({ address, abi: VAULT_ABI, functionName: "nonce" }) : 0n;
  return { address, deployed, balance6: balance6.toString(), nonce: nonce.toString() };
}

// the digest the passkey must sign for an op - MUST mirror the contract's
// abi.encode exactly (the site recomputes this independently before signing)
export function opDigest(op, vault, chainId, nonce, args, deadline) {
  const { keccak256, encodeAbiParameters, toHex } = viem;
  const tag = keccak256(toHex(OP[op]));
  const enc = (types, values) => encodeAbiParameters(types, values);
  const base = [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }];
  const baseV = [tag, vault, BigInt(chainId), BigInt(nonce)];
  if (op === "deploy")
    return keccak256(enc([...base, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [...baseV, keccak256(args.createCall), BigInt(args.fund6), BigInt(deadline)]));
  if (op === "fund")
    return keccak256(enc([...base, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [...baseV, args.id, BigInt(args.fund6), BigInt(deadline)]));
  if (op === "control")
    return keccak256(enc([...base, { type: "bytes32" }, { type: "uint256" }],
      [...baseV, keccak256(args.callData), BigInt(deadline)]));
  if (op === "refund")
    return keccak256(enc([...base, { type: "uint256" }, { type: "uint256" }],
      [...baseV, BigInt(args.amount6), BigInt(deadline)]));
  throw new Error("unknown op");
}

// create(...) calldata for the CURRENT ledger schema (rev sniff like the
// provisioner: rev>=4 = 9-arg with zero fee args, else legacy 7-arg)
export async function buildCreateCall(depAddress, spec) {
  const pub = await rpcPool();
  let rev = 3;
  try {
    rev = Number(await pub.readContract({ address: depAddress, abi:
      [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "deploymentsSchema" }));
  } catch { /* rev-1/2 ledgers: legacy shape */ }
  const { encodeFunctionData } = viem;
  const baseInputs = [
    { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
    { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
    { name: "ports", type: "string" }, { name: "isPublic", type: "bool" }, { name: "configCid", type: "string" },
  ];
  const inputs = rev >= 4 ? [...baseInputs, { name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] : baseInputs;
  const args = [spec.appRef, spec.gpuMilli, spec.cpuMilli, spec.appPort, spec.ports, spec.isPublic, spec.configCid,
                ...(rev >= 4 ? ["0x0000000000000000000000000000000000000000", 0n] : [])];
  return encodeFunctionData({ abi: [{ type: "function", name: "create", stateMutability: "nonpayable", inputs, outputs: [{ type: "bytes32" }] }], args, functionName: "create" });
}

// DER ECDSA -> {r, s} bigints (the precompile takes raw values, any s)
export function derToRS(der) {
  const u8 = Buffer.from(der);
  let i = 2;                                     // SEQUENCE header (short form: sigs are ~70 bytes)
  const readInt = () => {
    if (u8[i++] !== 0x02) throw new Error("bad DER");
    const len = u8[i++]; let v = u8.subarray(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("bad DER int");
    return BigInt("0x" + Buffer.from(v).toString("hex"));
  };
  return { r: readInt(), s: readInt() };
}

// ---- the serial company-wallet queue -------------------------------------------
let _chain = Promise.resolve();
function serial(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

export async function ensureVault(key) {
  const info = await vaultInfo(key);
  if (info.deployed) return info.address;
  return serial(async () => {
    const again = await vaultInfo(key);
    if (again.deployed) return again.address;
    const pub = await rpcPool();
    const hash = await wallet.writeContract({ address: await factoryAddress(), abi: FACTORY_ABI,
      functionName: "createVault", args: [BigInt(key.x), BigInt(key.y)] });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`createVault reverted (${hash})`);
    return again.address;
  });
}

// deposit company USDC into a customer's vault (card top-up settlement)
export async function depositToVault(key, amount6) {
  const address = await ensureVault(key);
  return serial(async () => {
    const pub = await rpcPool();
    const have = await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    if (have < BigInt(amount6)) throw new Error(`relayer wallet is short of USDC (${have} < ${amount6})`);
    const hash = await wallet.writeContract({ address: cfg.usdc, abi: ERC20_ABI,
      functionName: "transfer", args: [address, BigInt(amount6)] });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`vault deposit reverted (${hash})`);
    return { vault: address, txHash: hash };
  });
}

// submit a passkey-signed vault op; the contract is the verifier of record
export async function submitOp(op, vaultAddress, args, deadline, assertion) {
  const sig = {
    authenticatorData: "0x" + Buffer.from(assertion.authenticatorData, "base64url").toString("hex"),
    clientDataJSON: Buffer.from(assertion.clientDataJSON, "base64url").toString("utf8"),
    ...derToRS(Buffer.from(assertion.signature, "base64url")),
    x: BigInt(assertion.x), y: BigInt(assertion.y),
  };
  const fn = { deploy: "deployAndFund", fund: "fundDeployment", control: "controlDeployment", refund: "refundToTreasury" }[op];
  const fnArgs = {
    deploy:  () => [args.createCall, BigInt(args.fund6), BigInt(deadline), sig],
    fund:    () => [args.id, BigInt(args.fund6), BigInt(deadline), sig],
    control: () => [args.callData, BigInt(deadline), sig],
    refund:  () => [BigInt(args.amount6), BigInt(deadline), sig],
  }[op]();
  return serial(async () => {
    const pub = await rpcPool();
    const hash = await wallet.writeContract({ address: vaultAddress, abi: VAULT_ABI, functionName: fn, args: fnArgs });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`${fn} reverted (${hash})`);
    let deploymentId = null;
    try {
      const logs = viem.parseEventLogs({ abi: VAULT_ABI, logs: rcpt.logs });
      const d = logs.find((l) => l.eventName === "Deployed");
      if (d) deploymentId = d.args.id;
    } catch { /* no event parse: fund/control/refund */ }
    return { txHash: hash, deploymentId };
  });
}
