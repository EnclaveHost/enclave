/* ============================================================
   A passkey account that pays its own gas (independent mode):
   ERC-4337 v0.7 through the pinned EntryPoint and Safe4337Module,
   sent to the owner's OWN bundlers (the account profile's transport).
   No connected wallet, no Enclave bundler or paymaster, no default.

   Gas is not free: the account pays the EntryPoint from its own ETH
   (balance, or its EntryPoint deposit), and the bundler is paid out of
   that. Before the first deployment the counterfactual address must
   already hold that ETH (sent from anywhere). A paymaster the owner
   names in the transport (ERC-7677) pays instead, from its own
   EntryPoint deposit: only that paymaster is accepted in its answers,
   and its deposit must cover the operation.

   Every operation, in order:
   1. an earlier operation whose outcome is unknown blocks new ones
      until it is checked (nothing is ever resent automatically);
   2. the call itself is simulated FROM the Safe at an agreed block;
   3. gas limits are the bundler's estimate (with margins), fees come
      from the agreed block; the account must hold enough to pay;
   4. the owners' passkeys approve the operation hash (the module's
      getOperationHash, agreed);
   5. the exact signed operation is simulated through EntryPoint
      handleOps at an agreed block;
   6. it is recorded as pending, then sent;
   7. the outcome is the EntryPoint's own UserOperationEvent for its
      hash, read at agreed blocks - not the bundler's word. No event
      in time = outcome unknown, kept pending, never resent.
   ============================================================ */
import { INDEPENDENT } from "./config.js";

const lower = (a) => String(a || "").toLowerCase();
const GAS_PREFIX = "enclave_account_gas:v1:", PENDING_PREFIX = "enclave_account_pending:v1:";
const chainId = () => (INDEPENDENT.profile && INDEPENDENT.profile.chainId) || 8453;
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const gasKey = (safe) => GAS_PREFIX + chainId() + ":" + lower(safe), pendingKey = (safe) => PENDING_PREFIX + chainId() + ":" + lower(safe);

export class TransportError extends Error {
  constructor(message, { code = "refused", outcomeUnknown = false, userOpHash = null, needWei = null } = {}){
    super(message); this.name = "TransportError"; this.code = code; this.outcomeUnknown = outcomeUnknown; this.userOpHash = userOpHash; this.needWei = needWei;
  }
}

let _deps = null;
/** Tests only: stand-ins for the reader, passkey-account and the clock. */
export function _setForTests(d){ _deps = d; }
async function deps(){
  if (_deps) return _deps;
  const [PA, IC] = await Promise.all([import("./passkey-account.js"), import("./independent-chain.js")]);
  return { PA, reader: IC.reader(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
}

/* ---- who pays gas: the owner's explicit choice ---- */
/** "wallet" (a connected wallet submits and pays gas), "account" (the account pays through its own bundler), or null when the
 *  owner must still choose (a transport exists but no choice was made). Without a transport only "wallet" is possible. */
export function gasChoice(profile){
  if (!profile) return null;
  const v = (ls() && ls().getItem(gasKey(profile.safe))) || null;
  if (v === "account") return profile.transport ? "account" : null;
  if (v === "wallet") return "wallet";
  return profile.transport ? null : "wallet";
}
export function setGasChoice(profile, mode){
  if (mode !== "wallet" && mode !== "account") throw new TransportError("choose the connected wallet or the account itself");
  if (mode === "account" && !profile.transport) throw new TransportError("name your own bundler first (Gas transport): the account then pays through it");
  ls().setItem(gasKey(profile.safe), mode);
}

/* ---- pending operations ---- */
export function pendingOf(safe){ try { return JSON.parse((ls() && ls().getItem(pendingKey(safe))) || "null"); } catch { return null; } }
// every change is announced so an open panel shows (or stops showing) "check the pending operation"
const announce = (safe) => { try { globalThis.document?.dispatchEvent(new CustomEvent("enclave:account-pending", { detail: { safe: lower(safe) } })); } catch {} };
const setPending = (safe, p) => { ls().setItem(pendingKey(safe), JSON.stringify(p)); announce(safe); };
const clearPending = (safe) => { ls().removeItem(pendingKey(safe)); announce(safe); };

const entryPoint = async () => (await import("./account-providers.js")).PROVIDERS["safe-passkey"].contracts.entryPoint.address;
const topic = async (D, sig) => { const L = await D.PA.lib(); return lower(L.keccak256(L.toHex(sig))); };
/* the EntryPoint's own record of `userOpHash` in [fromBlock, agreed head], read in agreed chunks */
async function findOutcome(D, { userOpHash, fromBlock }){
  const ep = await entryPoint();
  const EVENT = await topic(D, "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
  const REVERT = await topic(D, "UserOperationRevertReason(bytes32,address,uint256,bytes)");
  const snap = await D.reader.snapshot();
  for (let from = Math.max(0, fromBlock); from <= snap.number; from += 2000){
    const to = Math.min(snap.number, from + 1999);
    const evs = await D.reader.logs(snap, { address: ep, topics: [EVENT, userOpHash], fromBlock: from, toBlock: to });
    if (evs.length){
      const e = evs[0], w = (i) => BigInt("0x" + e.data.slice(2 + i * 64, 2 + i * 64 + 64));
      let reason = null;
      if (w(1) !== 1n){
        const rv = await D.reader.logs(snap, { address: ep, topics: [REVERT, userOpHash], fromBlock: e.blockNumber, toBlock: e.blockNumber }).catch(() => []);
        if (rv.length) reason = "0x" + rv[0].data.slice(2 + 64 * 3);
      }
      return { found: true, success: w(1) === 1n, nonce: w(0), actualGasCost: w(2), paymaster: e.topics && e.topics[3] ? "0x" + String(e.topics[3]).slice(26) : null,
        txHash: e.transactionHash, block: e.blockNumber, reason, snap };
    }
  }
  return { found: false, snap };
}

/** What became of the pending operation, if any: "none", "included" (success or failed - the chain's own answer), "replaced"
 *  (the account's nonce moved past it without it: it can no longer execute), or "pending" (still unknown). Settled entries
 *  are cleared; a pending one is kept. */
export async function checkPending(profile){
  const p = pendingOf(profile.safe);
  if (!p) return { state: "none" };
  const D = await deps(), PA = D.PA;
  const out = await findOutcome(D, p);
  if (out.found){ clearPending(profile.safe); return { state: "included", ...p, ...out }; }
  const L = await PA.lib();
  const nonce = BigInt(await D.reader.call(out.snap, await entryPoint(),
    L.encodeFunctionData({ abi: PA.ABI.entryPoint, functionName: "getNonce", args: [L.getAddress(profile.safe), 0n] })));
  if (nonce > BigInt(p.nonce)){ clearPending(profile.safe); return { state: "replaced", ...p }; }
  return { state: "pending", ...p, block: out.snap.number };
}
/** Forget a pending operation - only once the chain shows it can no longer execute (its nonce was used) or the owner
 *  insists after checking. */
export function discardPending(profile){ clearPending(profile.safe); }

/* ---- gas ---- */
const MAX = { verificationGasLimit: 3_000_000n, callGasLimit: 10_000_000n, preVerificationGas: 1_000_000n };
const marginUp = (v, num, den) => (BigInt(v) * num + den - 1n) / den;

/** The operation's gas: the owner's bundler estimates the limits (each raised by a margin; WebAuthn verification gets the
 *  most), fees follow the agreed block's base fee plus the bundler's priority fee (capped). -> { gas, needWei }. */
// what the 4337 path adds around the account's own call: EntryPoint -> Safe fallback -> module.executeUserOp ->
// Safe.execTransactionFromModule -> the call
const EXECUTION_OVERHEAD = 80_000n;
async function gasFor(D, profile, { to, value, data, operation, initCode, snap }){
  const PA = D.PA, t = profile.transport;
  const draft = await PA.prepareUserOperation(profile, { to, value, data, operation, initCode,
    gas: { verificationGasLimit: 1n, callGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } }, { reader: D.reader });
  const userOp = { ...draft.userOp, signature: await PA.estimationSignature(profile) };
  let tip = null;
  for (const b of t.bundlers){ try { tip = BigInt(await PA.bundlerRequest(b, "eth_maxPriorityFeePerGas", [])); break; } catch {} }
  if (tip == null) throw new TransportError("none of your bundlers quotes a priority fee (eth_maxPriorityFeePerGas): nothing was signed", { code: "estimate" });
  if (tip > 2_000_000_000n) tip = 2_000_000_000n;
  const base = snap.baseFeePerGas ?? 0n;
  const fees = { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
  // an owner-chosen paymaster (ERC-7677): its stub data first, so the estimate covers the paymaster's own validation
  const pm = t.paymaster, chainHex = "0x" + Number(profile.chainId).toString(16);
  const rpcDraft = () => PA.toRpcUserOperation(userOp, { gas: { ...fees, verificationGasLimit: 0n, callGasLimit: 0n, preVerificationGas: 0n }, initCode });
  let stub = null;
  if (pm){
    try { stub = await PA.bundlerRequest(pm.url, "pm_getPaymasterStubData", [rpcDraft(), t.entryPoint, chainHex, {}]); }
    catch (e){ throw new TransportError("your paymaster gave no stub data (" + e.message + "): nothing was signed", { code: "paymaster" }); }
    checkPaymaster(stub, pm);
  }
  const withPm = (op, d) => d ? { ...op, paymaster: d.paymaster, paymasterData: d.paymasterData || "0x",
    paymasterVerificationGasLimit: d.paymasterVerificationGasLimit, paymasterPostOpGasLimit: d.paymasterPostOpGasLimit || "0x0" } : op;
  let est = null, why = [];
  for (const b of t.bundlers){
    try { est = await PA.bundlerRequest(b, "eth_estimateUserOperationGas", [withPm(rpcDraft(), stub), t.entryPoint]); break; }
    catch (e){ why.push(new URL(b).host + ": " + e.message); }
  }
  if (!est) throw new TransportError("none of your bundlers estimated this operation (" + why.join("; ") + "): nothing was signed", { code: "estimate" });
  // a bundler's call-gas figure is not trusted alone: the account's own call is measured from the account at the agreed block,
  // and the larger limit is used (an underestimate makes the module revert ExecutionFailed after gas is already spent)
  let own = 0n;
  if (operation === 0 && D.reader.estimateGas){
    try { own = marginUp(await D.reader.estimateGas(snap, { from: profile.safe, to, data, value }), 13n, 10n) + EXECUTION_OVERHEAD; }
    catch (e){ throw new TransportError("the chain endpoints could not measure this call from your account (" + String(e.message || e).slice(0, 160) + "): nothing was signed", { code: "estimate" }); }
  }
  const bundlerCall = marginUp(est.callGasLimit, 13n, 10n);
  const gas = { ...fees,
    verificationGasLimit: marginUp(est.verificationGasLimit, 3n, 2n), callGasLimit: bundlerCall > own ? bundlerCall : own, preVerificationGas: marginUp(est.preVerificationGas, 11n, 10n) };
  for (const k of Object.keys(MAX)) if (gas[k] > MAX[k]) throw new TransportError("the bundler's " + k + " estimate (" + gas[k] + ") is beyond any operation this page sends: nothing was signed", { code: "estimate" });
  let paymasterAndData = "0x", pmGas = 0n;
  if (pm){
    // the final paymaster data for exactly these limits (unless the stub was final); it is part of the hash the owners sign
    let fin = stub;
    if (!stub.isFinal){
      const op = withPm(PA.toRpcUserOperation(userOp, { gas, initCode }), stub);
      try { fin = { ...stub, ...(await PA.bundlerRequest(pm.url, "pm_getPaymasterData", [op, t.entryPoint, chainHex, {}])) }; }
      catch (e){ throw new TransportError("your paymaster declined this operation (" + e.message + "): nothing was signed", { code: "paymaster" }); }
      checkPaymaster(fin, pm);
    }
    const L = await PA.lib(), v = BigInt(fin.paymasterVerificationGasLimit), po = BigInt(fin.paymasterPostOpGasLimit || 0);
    if (v > 1_000_000n || po > 1_000_000n) throw new TransportError("the paymaster's gas limits are beyond any operation this page sends: nothing was signed", { code: "paymaster" });
    paymasterAndData = L.concat([L.getAddress(fin.paymaster), L.pad(L.toHex(v), { size: 16 }), L.pad(L.toHex(po), { size: 16 }), fin.paymasterData || "0x"]);
    pmGas = v + po;
  }
  return { gas, paymasterAndData, needWei: (gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas + pmGas) * gas.maxFeePerGas };
}
/* A paymaster answer must name the paymaster the owner chose, with gas limits for it - nothing else is accepted. */
function checkPaymaster(d, pm){
  if (!d || lower(d.paymaster) !== pm.address) throw new TransportError("your paymaster service answered for " + (d && d.paymaster) + ", not the paymaster you named (" + pm.address + "): nothing was signed", { code: "paymaster" });
  if (d.paymasterVerificationGasLimit == null) throw new TransportError("your paymaster service gave no verification gas limit: nothing was signed", { code: "paymaster" });
}

/** What the account has to pay gas with (agreed): its ETH plus its EntryPoint deposit. */
export async function gasFunds(profile){
  const D = await deps(), PA = D.PA, L = await PA.lib();
  const ep = await entryPoint();
  const snap = await D.reader.snapshot();
  const [balance, deposit] = [await D.reader.balance(snap, profile.safe),
    BigInt(await D.reader.call(snap, ep, L.encodeFunctionData({ abi: PA.ABI.entryPoint, functionName: "balanceOf", args: [L.getAddress(profile.safe)] })))];
  return { balance, deposit, total: balance + deposit, block: snap.number };
}

/**
 * One call made BY the account through its own bundler. `approve(hash) -> Safe signature bytes` is the owners' approval
 * (passkey-account safeApprover). `deploy: true` creates the account in the same operation when it is not deployed yet (its
 * pinned initializer; the call may then be a no-op on the Safe itself). -> { userOpHash, txHash, actualGasCost, block }.
 * Throws TransportError: code "pending" (an earlier outcome is unknown), "prefund" (needWei), "simulation", "refused"
 * (every bundler refused: nothing is pending), "reverted" (included, and the call failed), "unknown" (outcomeUnknown).
 */
export async function sendAsAccount(profile, { to, value = 0n, data = "0x", operation = 0, deploy = false, what = "operation" }, { approve, onPhase = () => {}, timeoutMs = 120000 } = {}){
  await (await import("./platform-addresses.js")).assertPlatformTransactionCurrent(to, data);
  const D = await deps(), PA = D.PA, L = await PA.lib();
  PA.validateAccountProfile(profile);
  if (gasChoice(profile) !== "account") throw new TransportError("this account does not pay its own gas: choose it in Gas first", { code: "choice" });
  const pm = profile.transport.paymaster;
  // 1) an earlier operation whose outcome is unknown
  const prev = await checkPending(profile);
  if (prev.state === "pending") throw new TransportError("an earlier operation of this account (" + prev.what + ", " + prev.userOpHash + ") has no outcome on chain yet: check it before sending another. Nothing was signed.", { code: "pending", userOpHash: prev.userOpHash });
  const ep = await entryPoint();
  let snap = await D.reader.snapshot();
  const code = await D.reader.code(snap, profile.safe), deployed = !!code && code !== "0x";
  let initCode = null;
  if (!deployed){
    if (!deploy) throw new TransportError("this account is not deployed yet: deploy it first", { code: "undeployed" });
    const pred = await PA.prepareSafeCreation(PA.creationOf(profile), { reader: D.reader });
    if (pred.safe !== lower(profile.safe)) throw new TransportError("this account description does not create " + profile.safe + ": nothing was signed", { code: "mismatch" });
    initCode = pred.initCode;
  }
  // 2) the call itself, from the Safe (a deployed account; a new account's first call runs right after its creation)
  if (deployed && operation === 0){
    onPhase("simulate", "checking the call from your account at block " + snap.number);
    try { await D.reader.call(snap, to, data, { from: profile.safe, value }); }
    catch (e){ throw new TransportError((e && e.revert ? "the call would fail from your account" : "the chain endpoints did not agree on the call") + " (" + String(e.message || e).slice(0, 160) + "). Nothing was signed.", { code: "simulation" }); }
  }
  // 3) gas, and whether the account can pay it
  const { gas, needWei, paymasterAndData } = await gasFor(D, profile, { to, value, data, operation, initCode, snap });
  if (pm){
    // the paymaster pays from its EntryPoint deposit (under its own policy, or charging a token: its terms apply)
    const dep = BigInt(await D.reader.call(snap, ep, L.encodeFunctionData({ abi: PA.ABI.entryPoint, functionName: "balanceOf", args: [L.getAddress(pm.address)] })));
    if (dep < needWei) throw new TransportError("your paymaster's EntryPoint deposit (" + fmtEth(dep) + " ETH) cannot cover this operation (up to " + fmtEth(needWei) + " ETH): nothing was signed", { code: "prefund", needWei });
    onPhase("note", pm.kind === "erc20" ? "your paymaster pays the gas and charges a token for it, under its own terms" : "your paymaster sponsors the gas under its own policy");
  } else {
    const funds = await gasFunds(profile);
    if (funds.total < needWei) throw new TransportError("your account needs up to " + fmtEth(needWei) + " ETH for this operation's gas and holds " + fmtEth(funds.total)
      + ". Send ETH to " + profile.safe + " from anywhere first; nothing was signed.", { code: "prefund", needWei });
  }
  // 4) the owners approve exactly this operation
  const prepared = await PA.prepareUserOperation(profile, { to, value, data, operation, initCode, gas, paymasterAndData }, { reader: D.reader });
  onPhase("approve", "approve with your passkey: " + what);
  const userOp = await PA.signUserOperation(prepared, await approve(prepared.operationHash));
  // 5) the exact signed operation through the EntryPoint, at an agreed block
  snap = await D.reader.snapshot();
  const handle = L.encodeFunctionData({ abi: PA.ABI.entryPoint, functionName: "handleOps", args: [[userOp], L.getAddress(profile.safe)] });
  try { await D.reader.call(snap, ep, handle); }
  catch (e){ throw new TransportError("the EntryPoint refuses this operation at block " + snap.number + " (" + String(e.message || e).slice(0, 200) + "). Nothing was sent.", { code: "simulation" }); }
  const userOpHash = await PA.userOperationHash(userOp, { reader: D.reader, snap });
  // 6) recorded before it leaves this page, then sent
  setPending(profile.safe, { userOpHash, nonce: String(prepared.userOp.nonce), fromBlock: snap.number, what, at: D.now() });
  onPhase("send", "sending through your bundler");
  try {
    const r = await PA.sendUserOperation(profile.transport, userOp, { gas, initCode });
    if (lower(r.userOpHash) !== userOpHash) onPhase("note", "the bundler named it " + r.userOpHash + "; this page follows the EntryPoint's hash " + userOpHash);
  } catch (e){
    if (e.delivered === false){ clearPending(profile.safe); throw new TransportError(e.message + " Nothing is pending.", { code: "refused" }); }
    throw new TransportError("your bundlers may have received " + what + " (" + e.message + "). Its outcome is unknown: check it before sending anything else; it is not resent.", { code: "unknown", outcomeUnknown: true, userOpHash });
  }
  // 7) the EntryPoint's own record of the outcome
  onPhase("wait", "waiting for the EntryPoint to record it");
  const deadline = D.now() + timeoutMs;
  for (;;){
    const out = await findOutcome(D, { userOpHash, fromBlock: snap.number });
    if (out.found){
      clearPending(profile.safe);
      if (!out.success) throw new TransportError(what + " was included in " + out.txHash + " but the call failed" + (out.reason ? " (" + out.reason.slice(0, 140) + ")" : "") + "; gas was paid.", { code: "reverted", userOpHash });
      return { userOpHash, txHash: out.txHash, actualGasCost: out.actualGasCost, block: out.block, paymaster: out.paymaster };
    }
    if (D.now() > deadline) throw new TransportError(what + " was sent to your bundler, but the chain has no outcome for it yet (" + userOpHash + "). Check it before sending anything else; it is not resent.", { code: "unknown", outcomeUnknown: true, userOpHash });
    await D.sleep(1500);
  }
}
const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6);
export { fmtEth };

/** Is the dashboard's identity a passkey account that pays its own gas? (no wallet is needed then) */
export async function accountPaysOwnGas(){
  const ID = await import("./identity.js");
  const p = ID.identityProfile();
  return !!p && gasChoice(p) === "account";
}
