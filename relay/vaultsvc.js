// Credit-vault service: the relay's thin bridge to EnclaveCreditVault.
//
// The relay NEVER holds authority over vault funds - every operation carries a
// WebAuthn P-256 signature from the customer's passkey, and the CONTRACT
// recomputes and verifies the signed digest on-chain. This module only:
//   - computes op digests for the site to display-and-sign (prepare). The site
//     RECOMPUTES that digest from the fields and checks them against what the
//     customer asked for before it prompts the passkey (site/js/core/vault.js
//     + keccak.js), which is what actually bounds a lying relay here: the
//     contract's outflow allowlist alone does NOT bound it to "credit spent on
//     the platform", because create() carries feeRecipient + feePerSec6 and
//     the publisher fee is paid pro-rata out of every funding - up to the
//     ledger's cap, to any wallet, on one tap. Do not weaken that client check
//     on the theory that the contract has it covered; it does not,
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
  { type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const IMPL_ABI = [
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
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

let cfg = null;            // { usdc, addressBook, chainId, alert?, reserved6? }
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
  setInterval(floatPass, FLOAT_SWEEP_SEC * 1000).unref?.();
  console.log(`[vault] float manager: sweep above $${Number(FLOAT_CEILING_6) / 1e6} down to $${Number(FLOAT_TARGET_6) / 1e6}, ` +
    `alert below $${Number(FLOAT_MIN_6) / 1e6} / ${Number(FLOAT_MIN_ETH_WEI) / 1e18} ETH, every ${FLOAT_SWEEP_SEC}s`);
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

// the provisioner/relayer float's current USDC balance - billing.js gates
// top-up CREATION on it: credit is never sold beyond what this wallet can
// actually deposit. Throws when the relayer is disabled or the read fails;
// the caller fails CLOSED (refuses the purchase), never open.
export async function relayerUsdc6() {
  if (!wallet) throw new Error("vault relayer disabled");
  const pub = await rpcPool();
  return BigInt(await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }));
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
// abi.encode exactly. The site recomputes it independently before signing
// (site/js/core/vault.js opDigest, pinned to the contract's encoding in
// test/vault-digest.test.mjs), so a drift here does not become a silent
// signature over something else: it becomes a refusal on the page.
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
// provisioner: rev>=8 = 10-arg with the rate cap, rev>=4 = 9-arg with zero fee
// args, else legacy 7-arg). spec.maxRate6 is the ceiling the quote was made at
// — credit checkout quotes the cheapest live enclave, so the cap is exactly
// what the buyer was shown.
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
  const inputs = [...baseInputs,
    ...(rev >= 4 ? [{ name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] : []),
    ...(rev >= 8 ? [{ name: "maxRate6", type: "uint256" }] : [])];
  if (rev >= 8 && !(BigInt(spec.maxRate6 || 0) > 0n)) throw new Error("spec.maxRate6 is required on this ledger");
  const args = [spec.appRef, spec.gpuMilli, spec.cpuMilli, spec.appPort, spec.ports, spec.isPublic, spec.configCid,
                ...(rev >= 4 ? ["0x0000000000000000000000000000000000000000", 0n] : []),
                ...(rev >= 8 ? [BigInt(spec.maxRate6)] : [])];
  return encodeFunctionData({ abi: [{ type: "function", name: "create", stateMutability: "nonpayable", inputs, outputs: [{ type: "bytes32" }] }], args, functionName: "create" });
}

// setActive/setAppRef/setShares/setConfig/setMaxRate calldata for
// controlDeployment - the vault contract allowlists exactly these selectors
// (they move no funds), plus a multicall composed solely of them (a version
// change + share resize ride one passkey signature; the vault checks every
// inner selector). "options" (setConfig) rewrites the deployment's options
// envelope - the waf/config namespaces - so vault deployments can gain rate
// limiting after create, same as wallet ones. "maxrate" (setMaxRate) moves the
// spend ceiling: which enclaves may run it, and at what price.
export async function buildControlCall(id, action, ref, shares, envelope, maxRate6) {
  const { encodeFunctionData } = viem || (viem = await import("viem"));
  const setAppRefCall = () => encodeFunctionData({ abi: [{ type: "function", name: "setAppRef", stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [] }],
    functionName: "setAppRef", args: [id, String(ref)] });
  if (action === "suspend" || action === "resume")
    return encodeFunctionData({ abi: [{ type: "function", name: "setActive", stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "bool" }], outputs: [] }],
      functionName: "setActive", args: [id, action === "resume"] });
  if (action === "version") return setAppRefCall();
  if (action === "options")
    return encodeFunctionData({ abi: [{ type: "function", name: "setConfig", stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [] }],
      functionName: "setConfig", args: [id, String(envelope ?? "")] });
  if (action === "maxrate") {
    if (!(BigInt(maxRate6 || 0) > 0n)) throw new Error("maxRate6 must be positive");
    return encodeFunctionData({ abi: [{ type: "function", name: "setMaxRate", stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] }],
      functionName: "setMaxRate", args: [id, BigInt(maxRate6)] });
  }
  // Cancel + refund (ledger rev 10). Named "cancel", not "refund", so it can
  // never be confused with the top-level `refund` op, which is
  // refundToTreasury (the card-refund flow). This one pays the deployment's
  // unused runtime back INTO the vault's own credit balance, because the vault
  // is the record's on-chain owner.
  if (action === "cancel")
    return encodeFunctionData({ abi: [{ type: "function", name: "refund", stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }], outputs: [] }],
      functionName: "refund", args: [id] });
  if (action === "resize") {
    const sharesCall = encodeFunctionData({ abi: [{ type: "function", name: "setShares", stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "uint16" }, { type: "uint16" }], outputs: [] }],
      functionName: "setShares", args: [id, Number(shares.gpuMilli), Number(shares.cpuMilli)] });
    if (ref === undefined || ref === null || ref === "") return sharesCall;
    return encodeFunctionData({ abi: [{ type: "function", name: "multicall", stateMutability: "nonpayable",
      inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] }],
      functionName: "multicall", args: [[setAppRefCall(), sharesCall]] });
  }
  throw new Error("unknown control action");
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

// deposit company USDC into a customer's vault (card top-up settlement).
// onBroadcast(hash, vault) fires the moment the tx leaves the wallet, BEFORE
// the receipt wait - the caller persists the hash so a receipt timeout can be
// verified on-chain later instead of blind-retried into a double credit (the
// provisioner's write-ahead discipline). A revert throws with e.reverted=true:
// nothing moved and the nonce is spent, so a fresh retry is safe.
export async function depositToVault(key, amount6, onBroadcast) {
  const address = await ensureVault(key);
  return serial(async () => {
    const pub = await rpcPool();
    const have = await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    if (have < BigInt(amount6)) throw new Error(`relayer wallet is short of USDC (${have} < ${amount6})`);
    const hash = await wallet.writeContract({ address: cfg.usdc, abi: ERC20_ABI,
      functionName: "transfer", args: [address, BigInt(amount6)] });
    onBroadcast?.(hash, address);
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rcpt.status !== "success") { const e = new Error(`vault deposit reverted (${hash})`); e.reverted = true; throw e; }
    return { vault: address, txHash: hash };
  });
}

// ---- float manager --------------------------------------------------------------
// The relayer wallet is a FLOAT, not a treasury: Stripe stablecoin payouts
// (Bridge) land card revenue as USDC on Base directly here, sized by sales -
// the exact demand that drains it. Two jobs, both company->company:
//   - sweep everything above the ceiling down to the target, into the company
//     treasury (read from the factory's implementation - the SAME address every
//     vault refunds to; never an env var that could point anywhere else),
//   - alert (once per dip, re-armed on recovery) when USDC or gas run low,
//     BEFORE a customer top-up starts failing instead of after.
// The ceiling/target gap is hysteresis: without it every daily payout would
// trigger a dust sweep. See docs/billing-runbook.md ("Fiat -> crypto").
const FLOAT_TARGET_6 = BigInt(process.env.FLOAT_TARGET_6 || "200000000");        // $200 stays behind after a sweep
const FLOAT_CEILING_6 = BigInt(process.env.FLOAT_CEILING_6 || "400000000");      // sweep only above $400
const FLOAT_MIN_6 = BigInt(process.env.FLOAT_MIN_6 || "50000000");               // low-USDC alert under $50
const FLOAT_MIN_ETH_WEI = BigInt(process.env.FLOAT_MIN_ETH_WEI || "2000000000000000");   // low-gas alert under 0.002 ETH
const FLOAT_SWEEP_SEC = parseInt(process.env.FLOAT_SWEEP_SEC || "300", 10);

// how much a sweep moves to treasury: everything above the ceiling, down to
// the target - but never below reserved6, the credit already SOLD against
// this float (open top-ups whose card can still charge or whose deposit is
// still owed; billing.js sums them). The creation-time float gate promises
// every accepted purchase is deposit-backed; a sweep that dipped under the
// reserved sum would quietly break that promise minutes later. Pure - unit
// tested directly.
export function floatSweepAmount(balance6, target6 = FLOAT_TARGET_6, ceiling6 = FLOAT_CEILING_6, reserved6 = 0n) {
  balance6 = BigInt(balance6); reserved6 = BigInt(reserved6);
  const keep6 = reserved6 > target6 ? reserved6 : target6;
  return balance6 > ceiling6 && balance6 > keep6 ? balance6 - keep6 : 0n;
}

// the company treasury, resolved ON-CHAIN: factory -> implementation ->
// treasury (an immutable; cached forever once read)
let _treasury = null;
export async function treasuryAddress() {
  if (_treasury) return _treasury;
  const pub = await rpcPool();
  const impl = await pub.readContract({ address: await factoryAddress(), abi: FACTORY_ABI, functionName: "implementation" });
  const t = await pub.readContract({ address: impl, abi: IMPL_ABI, functionName: "treasury" });
  if (!t || /^0x0{40}$/i.test(t)) throw new Error("factory reports no treasury");
  _treasury = t;
  return t;
}

const _low = { usdc: false, eth: false };
async function floatPass() {
  if (!wallet) return;
  try {
    const pub = await rpcPool();
    const [usdcBal, ethBal] = await Promise.all([
      pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      pub.getBalance({ address: account.address }),
    ]);
    if (usdcBal < FLOAT_MIN_6) {
      if (!_low.usdc) { _low.usdc = true; cfg.alert?.("float_low_usdc", { wallet: account.address, balance6: String(usdcBal), min6: String(FLOAT_MIN_6) }); }
    } else _low.usdc = false;
    if (ethBal < FLOAT_MIN_ETH_WEI) {
      if (!_low.eth) { _low.eth = true; cfg.alert?.("float_low_gas", { wallet: account.address, balanceWei: String(ethBal), minWei: String(FLOAT_MIN_ETH_WEI) }); }
    } else _low.eth = false;
    // owed credit stays behind; if the sum is unreadable, move no money
    let reserved6;
    try { reserved6 = BigInt(cfg.reserved6?.() ?? 0n); } catch { return; }
    if (floatSweepAmount(usdcBal, FLOAT_TARGET_6, FLOAT_CEILING_6, reserved6) === 0n) return;
    const treasury = await treasuryAddress();
    await serial(async () => {
      // recompute INSIDE the serial queue: a vault deposit may have spent
      // part of the balance (and a new top-up grown the reserve) between the
      // read above and our turn to send
      const now6 = await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
      const excess = floatSweepAmount(now6, FLOAT_TARGET_6, FLOAT_CEILING_6, BigInt(cfg.reserved6?.() ?? 0n));
      if (excess === 0n) return;
      const hash = await wallet.writeContract({ address: cfg.usdc, abi: ERC20_ABI,
        functionName: "transfer", args: [treasury, excess] });
      const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rcpt.status !== "success") throw new Error(`float sweep reverted (${hash})`);
      console.log(`[vault] float sweep: $${(Number(excess) / 1e6).toFixed(2)} -> treasury ${treasury} (${hash})`);
    });
  } catch (e) { console.error("[vault] float pass failed:", e.message || e); }
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
