// Provisioner: the company wallet that converts a PAID order into an on-chain
// deployment - create() then fund() on EnclaveDeployments. The ledger stays
// the source of truth and the enclaves' claim/lease machinery runs untouched;
// they never learn an order existed.
//
// Money-flow invariant: this wallet spends COMPANY funds against the
// company's own contract (fund() forwards to the company payout; fee-bearing
// apps are refused at order time so no cut ever reaches a third party). It
// never sends anything to a customer address. Fund amount is capped at the
// order's quote - an overpayment never over-funds (no customer balance).
//
// Crash safety: a strictly SERIAL queue plus write-ahead steps persisted on
// the order (provision.step/txCreate/txFund, flushed BEFORE each await) make
// recovery unambiguous: on restart, planRecovery() decides from the persisted
// step + receipts whether to await, resume, adopt, or resend - never two
// create() calls for one order. Serial = at most one in-flight create, so an
// orphaned Created log can be adopted with confidence.
//
// Unset PROVISIONER_PRIVATE_KEY = provisioning HELD, loudly: paid orders wait
// in confirmed_provisioning and resume the moment the key is configured.

import { rpcParts, rpcPool } from "./store.js";

const MIN_ETH_WEI = BigInt(process.env.PROVISIONER_MIN_ETH_WEI || "500000000000000"); // 0.0005 ETH
const USDC_HEADROOM_6 = BigInt(process.env.PROVISIONER_USDC_HEADROOM_6 || "5000000"); // $5
const RELAY_PORT = parseInt(process.env.API_RELAY_PORT || "8100", 10);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const CREATED_EVENT = { type: "event", name: "Created", inputs: [
  { name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
  { name: "cpuMilli", type: "uint16" }, { name: "rate", type: "uint256" } ] };

const createAbi = (rev) => [{
  type: "function", name: "create", stateMutability: "nonpayable",
  inputs: [
    { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" },
    { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
    { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
    { name: "configCid", type: "string" },
    ...(rev >= 4 ? [{ name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] : []),
  ],
  outputs: [{ name: "id", type: "bytes32" }],
}];
const FUND_ABI = [{ type: "function", name: "fund", stateMutability: "nonpayable",
  inputs: [{ name: "id", type: "bytes32" }, { name: "value", type: "uint256" }], outputs: [] }];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

let cfg = null;          // { dir, orders, usdc, getDeploymentsAddress, setOrderState, alert }
let account = null, wallet = null;
let enabled = false;
let queue = [], running = null;   // running = orderId in flight (serial by design)
let _depRev = { addr: null, rev: null };

export async function initProvisioner(opts) {
  cfg = opts;
  const pk = (process.env.PROVISIONER_PRIVATE_KEY || "").trim();
  if (!pk) {
    console.log("[provisioner] PROVISIONER_PRIVATE_KEY unset - provisioning HELD (paid orders wait in confirmed_provisioning)");
    return { enabled: false };
  }
  try {
    const { createWalletClient } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { chain, transport } = await rpcParts();
    account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
    wallet = createWalletClient({ account, chain, transport });
    enabled = true;
    console.log(`[provisioner] enabled - wallet ${account.address}`);
  } catch (e) {
    console.error(`[provisioner] init failed (${e.message}) - provisioning HELD`);
    return { enabled: false };
  }
  // retry sweep: anything sitting in confirmed_provisioning gets (re)queued -
  // covers held funds, transient RPC errors, and restarts alike
  setInterval(() => { if (enabled) recoverProvisioning(); }, 60_000).unref?.();
  return { enabled: true };
}

export function recoverProvisioning() {
  if (!cfg?.orders) return;
  for (const order of Object.values(cfg.orders.data.orders))
    if (order.state === "confirmed_provisioning") enqueueProvision(order.id);
}

export function enqueueProvision(orderId) {
  if (!enabled) return;                       // held; the sweep re-finds it once enabled
  if (running === orderId || queue.includes(orderId)) return;
  queue.push(orderId);
  drain();
}

let _draining = false;
async function drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const order = cfg.orders.data.orders[id];
      if (!order || order.state !== "confirmed_provisioning") continue;
      running = id;
      try { await provisionOrder(order); }
      catch (e) {
        console.error(`[provisioner] ${id}: ${e.shortMessage || e.message} (the 60s sweep retries)`);
      }
      finally { running = null; }
    }
  } finally { _draining = false; }
}

// Pure recovery decision - unit-tested directly. provision = the persisted
// write-ahead record; receipts = { create, fund }, each one of:
//   {status} (mined) | "pending" (in the mempool) | null (chain never saw it)
// -> send_create | hold (a tx is still in flight: retry later, NEVER resend -
//    a resend racing a pending tx double-spends) | fund | send_fund |
//    complete | adopt_or_resend_create
export function planRecovery(provision, receipts) {
  if (!provision || !provision.step) return "send_create";
  if (provision.step === "creating") {
    if (!provision.txCreate) return "send_create";
    if (receipts.create === "pending") return "hold";
    if (receipts.create === null) return "adopt_or_resend_create";   // gone: never landed, or landed then this RPC forgot it - the Created scan disambiguates
    if (receipts.create.status === "success") return "fund";
    return "send_create";                                            // reverted: safe to retry
  }
  if (provision.step === "funding") {
    if (!provision.deploymentId) return "adopt_or_resend_create";    // torn record; the Created scan resolves it
    if (!provision.txFund) return "send_fund";
    if (receipts.fund === "pending") return "hold";
    if (receipts.fund === null) return "send_fund";                  // chain never saw it: safe to resend
    if (receipts.fund.status === "success") return "complete";
    return "send_fund";
  }
  return "complete";
}

async function depRev(pub, dep) {
  if (_depRev.addr === dep && _depRev.rev != null) return _depRev.rev;
  let rev;
  try {
    rev = Number(await pub.readContract({ address: dep,
      abi: [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "deploymentsSchema" }));
  } catch (e) {
    // genuine revert = a pre-schema (rev 1) ledger; transport errors must not
    // cache (the relay's 2026-07-17 sniff-poisoning lesson)
    if (/revert/i.test(e?.shortMessage || e?.message || "")) rev = 1;
    else throw e;
  }
  _depRev = { addr: dep, rev };
  return rev;
}

// mined receipt | "pending" (tx known but unmined) | null (chain never saw it)
async function txStatus(pub, hash) {
  if (!hash) return null;
  try { return await pub.getTransactionReceipt({ hash }); }
  catch {
    try { return (await pub.getTransaction({ hash })) ? "pending" : null; }
    catch { return null; }
  }
}

async function provisionOrder(order) {
  const pub = await rpcPool();
  const { parseEventLogs } = await import("viem");
  const dep = cfg.getDeploymentsAddress();
  if (!dep) throw new Error("deployments ledger address unknown");

  // fund amount: what actually arrived, capped at the quote (overpay is
  // income, never extra runtime); card orders fund the full quote
  const paid = BigInt(order.usdc.total6 || "0");
  const quote = BigInt(order.quote.amount6);
  const amount = paid > 0n ? (paid < quote ? paid : quote) : quote;

  // balance guards BEFORE any tx: hold loudly rather than half-provision
  const [ethBal, usdcBal] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  if (ethBal < MIN_ETH_WEI || usdcBal < amount + USDC_HEADROOM_6) {
    cfg.alert("provisioner_underfunded", { wallet: account.address, ethWei: ethBal.toString(),
      usdc6: usdcBal.toString(), need6: (amount + USDC_HEADROOM_6).toString(), orderId: order.id });
    throw new Error(`provisioner wallet underfunded (eth=${ethBal} usdc=${usdcBal}) - HOLDING order ${order.id}`);
  }

  const plan = planRecovery(order.provision, {
    create: await txStatus(pub, order.provision?.txCreate),
    fund: await txStatus(pub, order.provision?.txFund),
  });
  if (plan === "hold") throw new Error(`a prior tx for order ${order.id} is still pending - holding (never resend over a pending tx)`);

  if (plan === "send_create" || plan === "adopt_or_resend_create") {
    if (plan === "adopt_or_resend_create") {
      const adopted = await adoptOrphanCreate(pub, dep, order);
      if (adopted) return provisionOrder(order);           // record advanced to funding; re-plan
    }
    const rev = await depRev(pub, dep);
    const s = order.spec;
    const args = [s.appRef, s.gpuMilli, s.cpuMilli, s.appPort, s.ports, s.isPublic, s.configCid,
                  ...(rev >= 4 ? [ZERO_ADDR, 0n] : [])];
    order.provision = { step: "creating", txCreate: null, deploymentId: null, txFund: null };
    cfg.orders.flush();                                     // write-ahead: the step exists before the tx
    const txCreate = await wallet.writeContract({ address: dep, abi: createAbi(rev), functionName: "create", args });
    order.provision.txCreate = txCreate;
    cfg.orders.flush();                                     // the hash is durable before we await the receipt
    const rcpt = await pub.waitForTransactionReceipt({ hash: txCreate, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`create tx ${txCreate} reverted`);
    const created = parseEventLogs({ abi: [CREATED_EVENT], logs: rcpt.logs }).find(Boolean);
    if (!created) throw new Error(`create tx ${txCreate} has no Created log`);
    order.provision.deploymentId = created.args.id;
    order.provision.step = "funding";
    cfg.orders.flush();
  }

  // funding (fresh or resumed)
  if (!order.provision.deploymentId) throw new Error("no deploymentId to fund");
  const fundStatus = await txStatus(pub, order.provision.txFund);
  if (fundStatus === "pending") throw new Error(`fund tx for order ${order.id} is still pending - holding`);
  const fundPlan = planRecovery(order.provision, { create: null, fund: fundStatus });
  if (fundPlan !== "complete") {
    const allowance = await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI,
      functionName: "allowance", args: [account.address, dep] });
    if (allowance < amount) {
      const txA = await wallet.writeContract({ address: cfg.usdc, abi: ERC20_ABI,
        functionName: "approve", args: [dep, 2n ** 256n - 1n] });   // company wallet -> company contract
      await pub.waitForTransactionReceipt({ hash: txA, timeout: 120_000 });
    }
    const txFund = await wallet.writeContract({ address: dep, abi: FUND_ABI,
      functionName: "fund", args: [order.provision.deploymentId, amount] });
    order.provision.txFund = txFund;
    cfg.orders.flush();
    const rcpt = await pub.waitForTransactionReceipt({ hash: txFund, timeout: 120_000 });
    if (rcpt.status !== "success") throw new Error(`fund tx ${txFund} reverted`);
  }

  order.provision.fundedAt = new Date().toISOString();
  order.provision.step = "done";
  cfg.setOrderState(order, "complete", "provisioner");
  cfg.orders.flush();
  console.log(`[provisioner] order ${order.id} -> deployment ${order.provision.deploymentId} funded ${amount} (6dp)`);

  // nudge the fleet so the claim happens in seconds, not at the next sweep
  fetch(`http://127.0.0.1:${RELAY_PORT}/v1/claim-hint`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: order.provision.deploymentId }),
  }).catch(() => {});
}

// The serial queue guarantees at most ONE unaccounted create() from this
// wallet. Scan recent Created logs owned by the provisioner; if exactly one
// isn't mapped to any order, it is this order's - adopt it and move to
// funding. Otherwise fall through to a fresh create.
async function adoptOrphanCreate(pub, dep, order) {
  try {
    const tip = await pub.getBlockNumber();
    const from = tip > 50_000n ? tip - 50_000n : 0n;
    const logs = await pub.getLogs({ address: dep, event: CREATED_EVENT,
      args: { owner: account.address }, fromBlock: from, toBlock: tip });
    const mapped = new Set();
    for (const o of Object.values(cfg.orders.data.orders))
      if (o.provision?.deploymentId) mapped.add(String(o.provision.deploymentId).toLowerCase());
    const orphans = logs.filter((lg) => !mapped.has(String(lg.args.id).toLowerCase()));
    if (orphans.length === 1) {
      order.provision = { step: "funding", txCreate: orphans[0].transactionHash,
        deploymentId: orphans[0].args.id, txFund: order.provision?.txFund || null };
      cfg.orders.flush();
      console.log(`[provisioner] adopted orphaned create ${orphans[0].args.id} for order ${order.id}`);
      return true;
    }
    if (orphans.length > 1) {
      cfg.alert("provisioner_multiple_orphans", { count: orphans.length, orderId: order.id,
        note: "serial queue should make this impossible - investigate before anything double-funds" });
      throw new Error("multiple orphaned creates - holding for a human");
    }
  } catch (e) {
    if (/multiple orphaned/.test(e.message)) throw e;
    console.warn(`[provisioner] orphan scan failed: ${e.shortMessage || e.message}`);
  }
  return false;
}
