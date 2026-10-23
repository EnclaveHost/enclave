// cli/lease-gas.mjs - `enclave --independent … lease-gas …`: an app OWNER's budget for app-funded lease gas (design B,
// network/lease-gas-owner.mjs). Independent mode only: every read is an agreeing RPC quorum at one confirmed block.
//
// It never holds a key and never prompts a wallet. Each request is exact and simulated from its sender first; then:
//   - with an external signer (--signer URL --from 0x…, or --signer-mode handoff --from 0x…): the request goes through
//     the SAME independent writer every other command uses (cli/independent.mjs sendQuorumTx -> the signer of
//     cli/independent-signer.mjs): sign mode journals the signed bytes, handoff journals the intent and prints the exact
//     transaction for MetaMask, then `signer attach <intent> <hash>` confirms it against the quorum;
//   - otherwise: the unsigned request is printed (--format tx | metamask | safe) and nothing is sent; re-run `status`
//     after it has mined.
// A Safe owner always gets a Safe transaction (Transaction Builder JSON): its signers execute it, never this CLI.
// The local wallet key (ENCLAVE_KEY / key file) is never used here.
import { formatEther, formatGwei, getAddress, isHex } from "viem";
import * as O from "../network/lease-gas-owner.mjs";

const USAGE = `usage: enclave --independent … lease-gas <command> --lease-gas FILE --lease-gas-digest sha256:…
  status <id…> | --inventory FILE        the reserve, policy, caps, fee, L1, proof and claim-bond gates, runner eligibility
  plan (--ids a,b | --inventory FILE) (--per-app-eth X | --per-app-wei N | --days N) [policy flags] [--payer 0x…]
                                          every app's exact deposit + configure requests (unsigned; nothing is sent)
  deposit <id> (--eth X | --wei N) [--compute-eth X]    anyone may pay; the owner of record is credited
                                          (an owner contract this CLI cannot identify needs --owner-can-act)
  configure <id> [policy flags] [--disable]             the owner of record's policy and caps
  withdraw <id> (--eth X | --wei N | --all) [--as 0x…] [--to 0x…]   from the caller's OWN reserve for <id>
  claimant <id> <operator> (--allow | --deny)           allowlist (claim policy "allowlist")
policy flags: --max-gas-price-gwei G  --max-per-op-eth X  --epoch-cap-eth X  --epoch-sec S  --renew-window S  --min-extension S
              --claim-cooldown S  --max-claims-per-epoch N  --claim-policy any|self-hosted|allowlist  --no-sponsor-release
cost model: --renew-lead-sec S   a rate-0 lease's measured renew lead (default: the renew window, the earliest a sponsored
              renew may land: a rate-0 renew restarts the lease from its own block, so it renews every leaseSec - lead)
output: --format tx (default) | metamask | safe;  --json for machine output
signing: --signer URL --from 0x… | --signer-mode handoff --from 0x… (journaled, existing signer); else unsigned`;

const VAL = ["--lease-gas", "--lease-gas-digest", "--inventory", "--ids", "--per-app-eth", "--per-app-wei", "--days", "--payer", "--eth", "--wei", "--compute-eth",
  "--as", "--to", "--format", "--max-gas-price-gwei", "--max-per-op-eth", "--epoch-cap-eth", "--epoch-sec", "--renew-window", "--min-extension", "--claim-cooldown",
  "--max-claims-per-epoch", "--claim-policy", "--candidate-operator", "--candidate-enclave", "--vault-factory", "--min-days", "--renew-lead-sec"];
const BOOL = ["--all", "--allow", "--deny", "--disable", "--no-sponsor-release", "--reconfigure", "--owner-can-act"];
const ID = /^0x[0-9a-fA-F]{64}$/;
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const eth = (wei) => `${formatEther(BigInt(wei))} ETH`;

/**
 * ctx (from cli/enclave.mjs): { flags, say, jout, json, chain, trust, I (cli/independent.mjs), signer (INDEPENDENT.signer
 * or null), from (opt.from), unsigned, maxFeeGwei, readFile, env, warn, log }
 */
export async function cmdLeaseGas(rest, ctx) {
  const [sub, ...r] = rest;
  if (!sub || sub === "help" || sub === "--help") return ctx.say(USAGE);
  const f = ctx.flags(r, { bool: BOOL, val: VAL });
  const env = ctx.env || {};
  const file = f["lease-gas"] || env.ENCLAVE_LEASE_GAS_FILE, digest = f["lease-gas-digest"] || env.ENCLAVE_LEASE_GAS_DIGEST;
  if (!file) throw new Error("lease-gas needs the reviewed deployment record: --lease-gas FILE --lease-gas-digest sha256:… (nothing is deployed on Base yet)");
  const dep = O.parseDeploymentRecord(ctx.readFileBytes(file), { expectedDigest: digest });
  const chain = ctx.chain;
  const live = await O.verifyDeployment(chain, dep, { pins: ctx.trust?.pins });
  const vaultFactories = factoriesOf(ctx, f);
  const out = { reserve: dep.reserve, executor: dep.executor, record: dep.digest, verifiedAt: live.block, agreeing: `${live.agreeing}/${live.peers}` };
  const fee = await O.marketFee(chain);
  const H = { ctx, f, dep, live, chain, vaultFactories, out, fee };
  switch (sub) {
    case "status": return status(H);
    case "plan": return plan(H);
    case "deposit": return deposit(H);
    case "configure": return configure(H);
    case "withdraw": return withdraw(H);
    case "claimant": return claimant(H);
    default: throw new Error(`unknown lease-gas command ${sub}\n${USAGE}`);
  }
}

function factoriesOf(ctx, f) {
  const list = [];
  const pins = ctx.trust?.pins || {};
  if (pins.sessionVaultFactory && !/^0x0{40}$/i.test(pins.sessionVaultFactory)) list.push({ address: pins.sessionVaultFactory, name: "pinned SessionVault factory" });
  const legacy = ctx.trust?.profile?.contracts?.legacySessionVaultFactory;
  if (legacy) list.push({ address: legacy.address, codeHash: legacy.codeHash, name: "legacy SessionVault factory (reviewed profile)" });
  else if (ctx.chain.chainId === 8453) list.push(O.LEGACY_SESSION_VAULT_FACTORY);
  // an extra factory the operator reviewed themselves (a local test chain, a future factory): address only
  for (const a of String(f["vault-factory"] || "").split(",").map((s) => s.trim()).filter(Boolean)) list.push({ address: getAddress(a), name: "--vault-factory" });
  return list;
}

function idsOf(H) {
  const { f, ctx } = H;
  if (f.inventory) {
    const inv = JSON.parse(ctx.readFileBytes(f.inventory).toString("utf8"));
    const rows = inv.selfHostedDeployments || inv.deployments || [];
    if (!rows.length) throw new Error(`${f.inventory} lists no deployments`);
    return rows.map((d) => ({ id: d.id, inventory: d }));
  }
  const ids = f.ids ? f.ids.split(",").map((s) => s.trim()).filter(Boolean) : f._;
  if (!ids.length) throw new Error("name the deployment id(s), or --inventory FILE");
  for (const id of ids) if (!ID.test(id)) throw new Error(`not a deployment id: ${id}`);
  return ids.map((id) => ({ id }));
}

// the renewal cadence differs by rate (the ledger restarts a rate-0 renew from its own block, extends a paid one from
// leaseUntil): the rate of the live lease when there is one, otherwise unknown and counted conservatively
async function costFor(H, st, policy) {
  const lead = H.f["renew-lead-sec"] !== undefined ? intFlag(H.f["renew-lead-sec"], "--renew-lead-sec") : null;
  return O.costModel({ limits: H.live.limits, policy: policy || st.reserve, effectiveFee: H.fee.effective, l1UpperWei: st.l1.upperBoundWei,
    l1UpperAuthWei: st.l1.upperBoundAuthWei, leaseSec: st.ledger.leaseSec, rate6: O.knownRate6(st), renewLeadSec: lead });
}

// ---- status ----------------------------------------------------------------------------------------------------------
async function status(H) {
  const { ctx, f, chain, dep, out } = H;
  const rows = [];
  for (const { id, inventory } of idsOf(H)) {
    const st = await O.appStatus(chain, dep, id, { candidateOperator: f["candidate-operator"], candidateEnclave: f["candidate-enclave"] });
    if (st.unknown) { rows.push({ id, unknown: true }); continue; }
    const kind = await O.ownerKind(chain, st.ledger.owner, { vaultFactories: H.vaultFactories });
    const cost = await costFor(H, st);
    let advice = O.advise(st, { cost, minDays: Number(f["min-days"] || 3) });
    // a known unsupported owner: never advise a deposit or a configuration it could not use (only the facts remain)
    if (kind.kind === "credit-vault") advice = [{ level: "unsupported", text: `the owner of record is a credit vault: ${O.CREDIT_VAULT_UNSUPPORTED}; do not deposit` }, ...advice.filter((x) => x.level === "info")];
    else if (kind.kind === "contract") advice = [{ level: "warn", text: O.UNKNOWN_OWNER_DEPOSIT }, ...advice.filter((x) => x.level === "info")];
    rows.push({ ...st, ownerKind: kindView(kind), cost: costView(cost), advice, inventoryOperator: inventory?.operator });
  }
  const res = { ...out, fee: H.fee, paused: H.live.paused, limits: H.live.limits, apps: rows,
    note: "status is POLICY eligibility at one agreed block, not a promise an operation lands; the money is checked at the actual measured charge" };
  if (ctx.json) return ctx.jout(res);
  ctx.say(`lease-gas reserve ${dep.reserve} (executor ${dep.executor}), verified at block ${H.live.block} by ${out.agreeing} RPCs${H.live.paused ? "  ** PAUSED by the platform **" : ""}`);
  ctx.say(`fee now: base ${formatGwei(H.fee.base)} + priority ${formatGwei(H.fee.priority)} gwei; platform ceiling ${formatGwei(H.live.limits.maxGasPriceCeiling)} gwei; L1 share ${Number(H.live.limits.l1Bps) / 100}% of the oracle's upper bound`);
  for (const a of rows) {
    if (a.unknown) { ctx.say(`\n${a.id}: not a deployment on this ledger`); continue; }
    const r = a.reserve, c = a.cost;
    ctx.say(`\n${a.id}  ${a.ledger.appRef}`);
    ctx.say(`  owner of record ${a.ledger.owner} (${a.ownerKind.kind}${a.ownerKind.detail ? ": " + a.ownerKind.detail : ""}); rate ${a.ledger.rate6} µUSDC/s; lease ${a.ledger.leaseLive ? "LIVE" : "expired"} until ${new Date(a.ledger.leaseUntil * 1000).toISOString()}`);
    ctx.say(`  reserve ${eth(r.balanceWei)}; ${r.configured ? (r.enabled ? "ENABLED" : "configured, DISABLED") : "NOT CONFIGURED"}; claims: ${r.claimPolicy}; release ${r.sponsorRelease ? "sponsored" : "not sponsored"}`);
    if (r.configured) ctx.say(`  caps: ${eth(r.maxPerOpWei)} per op, ${eth(r.epochCapWei)} per ${r.epochSec}s epoch (${eth(r.epochLeftWei)} left, ${r.epochClaims}/${r.maxClaimsPerEpoch} claims); gas price cap ${formatGwei(r.maxGasPrice)} gwei; renew window ${r.renewWindow}s`);
    ctx.say(`  charge now (upper, at ${formatGwei(c.price)} gwei): claim ${eth(c.perOp.claim)}, renew ${eth(c.perOp.renew)}, release ${eth(c.perOp.release)}; ${c.renewsPerDay === null ? `renewals/day not bounded (${c.renewal.basis})` : `~${c.renewsPerDay.toFixed(1)} renewals/day = ${eth(c.renewPerDayWei)}/day (steady state at the fee read now, not a forecast; ${c.renewal.basis})`}`);
    ctx.say(`  L1: upper bound ${eth(a.l1.upperBoundWei)}, charged share ${eth(a.l1.chargedShareWei)}; proof cutover ${a.gates.proofRequiredFrom ? new Date(a.gates.proofRequiredFrom * 1000).toISOString() + (a.gates.proofCutoverPassed ? " (passed)" : "") : "not set"}; ${a.gates.claimBondNote}`);
    if (a.runner) ctx.say(`  runner ${a.runner.operator}: renew ${a.runner.renew.status}, release ${a.runner.release.status}; ${a.runner.delegatedToExecutor ? "delegated to the executor" : "not yet delegated"}; operator ETH ${eth(a.runner.operatorEthWei)}; payout${a.runner.registry?.payoutIsOwner ? " = owner" : " ≠ owner"}`);
    if (a.candidate) ctx.say(`  candidate ${a.candidate.operator}: claim ${a.candidate.claim.status}`);
    for (const x of a.advice) ctx.say(`  ${x.level === "unsupported" ? "✗" : x.level === "action" ? "→" : x.level === "warn" ? "!" : "·"} ${x.text}`);
  }
  ctx.say(`\ncost formula: ${rows.find((x) => x.cost)?.cost.formula || ""}`);
}
const kindView = (k) => ({ kind: k.kind, address: k.address,
  detail: k.kind === "credit-vault" ? `UNSUPPORTED: ${k.label} ${k.factory}${k.bindingVerified ? "" : " (binding not verified)"}` : k.kind === "session-vault" ? `vault of ${k.factoryName}, owner ${k.vaultOwner}` : k.kind === "safe" ? `${k.threshold} of ${k.owners.length}` : k.kind === "eoa-7702" ? `delegated to ${k.delegate}` : k.kind === "contract" ? `unidentified contract, code ${k.codeHash}` : "" });
const costView = (c) => ({ price: c.price, effectiveFee: c.effectiveFee, ownerCap: c.ownerCap, ceiling: c.ceiling, priceLimitedBy: c.priceLimitedBy,
  perOp: Object.fromEntries(Object.entries(c.perOp).map(([k, v]) => [k, v.wei])), atOwnerCap: Object.fromEntries(Object.entries(c.atOwnerCap).map(([k, v]) => [k, v.wei])),
  renewsPerDay: c.renewsPerDay === null ? null : Number(c.renewsPerDay.toFixed(2)), renewPerDayWei: c.renewPerDayWei, formula: c.formula,
  renewal: { model: c.renewal.model, rate6: c.renewal.rate6, cycleSec: c.renewal.cycleSec, renewLeadSec: c.renewal.renewLeadSec ?? null,
    renewLeadFrom: c.renewal.renewLeadFrom ?? null, extensionSec: c.renewal.extensionSec ?? null, renewWindow: c.renewal.renewWindow,
    refused: c.renewal.refused ?? null, unbounded: c.renewal.unbounded ?? null, basis: c.renewal.basis } });

// ---- policy from flags -------------------------------------------------------------------------------------------------
function policyFrom(H, current, l1UpperAuthWei) {   // per-op caps are sized for the worst operation: a first claim with its authorization
  const { f } = H;
  const n = (k, d) => (f[k] !== undefined ? intFlag(f[k], `--${k}`) : d);
  const was = current?.configured ? current : null;
  const maxGasPrice = f["max-gas-price-gwei"] !== undefined ? gweiFlag(f["max-gas-price-gwei"]) : was ? was.maxGasPrice : null;
  if (maxGasPrice === null) throw new Error("name the owner's gas price cap: --max-gas-price-gwei G (the most a sponsored operation's gas may be priced at; relays refuse an operation whose cap is below the market fee)");
  if (maxGasPrice > H.live.limits.maxGasPriceCeiling) throw new Error(`--max-gas-price-gwei is above the platform ceiling ${formatGwei(H.live.limits.maxGasPriceCeiling)} gwei (the charge never uses more)`);
  const caps = O.defaultCaps({ limits: H.live.limits, maxGasPrice, l1UpperWei: l1UpperAuthWei, l1UpperAuthWei });
  const p = {
    enabled: !f.disable,
    claimPolicy: O.parseClaimPolicy(f["claim-policy"]) ?? (was ? ["any", "self-hosted", "allowlist"].indexOf(was.claimPolicy) : O.POLICY_DEFAULTS.claimPolicy),
    sponsorRelease: f["no-sponsor-release"] ? false : was ? was.sponsorRelease : O.POLICY_DEFAULTS.sponsorRelease,
    maxClaimsPerEpoch: n("max-claims-per-epoch", was ? was.maxClaimsPerEpoch : O.POLICY_DEFAULTS.maxClaimsPerEpoch),
    maxPerOpWei: f["max-per-op-eth"] !== undefined ? O.parseEthAmount(f["max-per-op-eth"]) : was && f["max-gas-price-gwei"] === undefined ? was.maxPerOpWei : caps.maxPerOpWei,
    epochCapWei: f["epoch-cap-eth"] !== undefined ? O.parseEthAmount(f["epoch-cap-eth"]) : was && f["max-gas-price-gwei"] === undefined ? was.epochCapWei : caps.epochCapWei,
    epochSec: n("epoch-sec", was ? was.epochSec : O.POLICY_DEFAULTS.epochSec),
    renewWindow: n("renew-window", was ? was.renewWindow : O.POLICY_DEFAULTS.renewWindow),
    minExtension: n("min-extension", was ? was.minExtension : O.POLICY_DEFAULTS.minExtension),
    claimCooldown: n("claim-cooldown", was ? was.claimCooldown : O.POLICY_DEFAULTS.claimCooldown),
    maxGasPrice,
  };
  O.checkPolicy(p);
  return p;
}
function intFlag(v, what) { const x = Number(v); if (!Number.isSafeInteger(x) || x < 0) throw new Error(`${what} must be a whole number`); return x; }
function gweiFlag(v) {
  const m = /^(\d{1,6})(?:\.(\d{1,9}))?$/.exec(String(v));
  if (!m) throw new Error("--max-gas-price-gwei must be a decimal number of gwei");
  return BigInt(m[1]) * 10n ** 9n + BigInt((m[2] || "").padEnd(9, "0"));
}
function amountOf(f, { allowAll = false } = {}) {
  const given = ["eth", "wei", ...(allowAll ? ["all"] : [])].filter((k) => f[k] !== undefined);
  if (given.length !== 1) throw new Error(`name the amount: exactly one of --eth X, --wei N${allowAll ? " or --all" : ""}`);
  if (f.all) return "all";
  if (f.wei !== undefined) { if (!/^\d+$/.test(f.wei)) throw new Error("--wei must be an integer"); return BigInt(f.wei); }
  return O.parseEthAmount(f.eth);
}

// ---- one request: simulate, then the existing signer or the unsigned output ---------------------------------------------
async function deliver(H, req) {
  const { ctx, f, chain } = H;
  const sim = await O.simulate(chain, req);
  const fmt = f.format || (req.via === "safe" ? "safe" : "tx");
  if (!["tx", "metamask", "safe"].includes(fmt)) throw new Error("--format must be tx, metamask or safe");
  if (req.via === "safe" || fmt === "safe") {
    if (req.via !== "safe") throw new Error("--format safe is for a Safe owner of record; this owner sends a plain transaction");
    const batch = O.safeBatch([req], chain.chainId);
    const res = { ...H.out, prepared: req.what, via: "safe", safe: req.safe, safeTransactionBuilder: batch, simulated: sim, notes: req.notes };
    if (ctx.json) return ctx.jout(res);
    ctx.say(`\nNOT SENT. ${req.notes.join("\n")}\nSafe ${req.safe.safe}, nonce ${req.safe.safeNonce}, simulated from the Safe at block ${sim.block}:`);
    return ctx.say(JSON.stringify(batch, big, 2));
  }
  // the existing independent writer + external signer (sign journals the bytes; handoff journals the intent and prints)
  if (ctx.signer) {
    if (!req.from || ctx.signer.address && req.from.toLowerCase() !== String(ctx.signer.address).toLowerCase())
      throw new Error(`this request must come from ${req.from}; the configured signer is --from ${ctx.from}`);
    const receipt = await ctx.I.sendQuorumTx(chain, { account: ctx.signer, to: req.to, data: req.data, value: req.value, maxFeeGwei: ctx.maxFeeGwei, log: ctx.log || (() => {}) });
    const res = { ...H.out, done: req.what, transactionHash: receipt.transactionHash, block: receipt.blockNumber, agreeing: receipt.agreeing };
    return ctx.json ? ctx.jout({ ...res, ...(receipt.evidence ? { evidence: receipt.evidence } : {}) })
      : ctx.say(`${req.what}: ${receipt.evidence ? "sent" : "mined"} ${receipt.transactionHash} (block ${receipt.blockNumber}, ${ctx.I.receiptLine(receipt)})`);
  }
  const tx = fmt === "metamask" ? O.walletParams(req, chain.chainId) : { chainId: chain.chainId, from: req.from, to: req.to, value: req.value, data: req.data };
  const res = { ...H.out, unsigned: tx, label: req.what, via: req.via, inner: req.inner, simulated: sim, notes: req.notes };
  if (ctx.json) return ctx.jout(res);
  ctx.say(`\n${req.what} - UNSIGNED, NOT SENT. ${req.notes.join(" ")}`);
  ctx.say(sim.simulated ? `simulated from ${req.from} at agreed block ${sim.block} (${sim.agreeing} RPCs)` : sim.why);
  ctx.say(fmt === "metamask" ? `eth_sendTransaction params (your wallet adds nonce and fees):\n${JSON.stringify(tx, big, 2)}` : JSON.stringify(tx, big, 2));
}

async function ownerOf(H, id) {
  const st = await O.appStatus(H.chain, H.dep, id);
  if (st.unknown) throw new Error(`${id} is not a deployment on this ledger`);
  return { st, kind: await O.ownerKind(H.chain, st.ledger.owner, { vaultFactories: H.vaultFactories }) };
}

async function deposit(H) {
  const { f, ctx, dep } = H;
  const id = oneId(f);
  const amount = amountOf(f);
  const computeWei = f["compute-eth"] !== undefined ? O.parseEthAmount(f["compute-eth"]) : 0n;
  const { st, kind } = await ownerOf(H, id);
  if (kind.kind === "credit-vault") throw O.creditVaultRefusal(kind, `a deposit for ${id}`);   // it would be stranded
  if (kind.kind === "contract" && !f["owner-can-act"]) throw O.unknownOwnerRefusal(kind, `a deposit for ${id}`);   // it may be stranded
  const req = O.depositRequest({ reserve: dep.reserve, id, amountWei: amount + computeWei, computeWei, from: ctx.from || (kind.kind.startsWith("eoa") ? kind.address : kind.kind === "session-vault" ? kind.vaultOwner : null) });
  req.notes.push(`credited to the reserve of the owner of record ${st.ledger.owner} (${kind.kind}); the payer gets nothing back from it except through that owner`);
  if (kind.kind === "contract") req.notes.push("--owner-can-act: the payer confirmed this contract can send configure and withdraw to the reserve itself; no request for it is prepared here");
  if (kind.kind === "safe" && !ctx.from) return deliver(H, { ...req, via: "safe", from: kind.address, safe: { safe: kind.address, to: req.to, value: req.value, data: req.data, operation: 0, safeNonce: kind.safeNonce, threshold: kind.threshold, owners: kind.owners } });
  return deliver(H, req);
}

async function configure(H) {
  const { f, ctx, dep } = H;
  const id = oneId(f);
  const { st, kind } = await ownerOf(H, id);
  const p = policyFrom(H, st.reserve, st.l1.upperBoundAuthWei);
  const req = O.ownerRequest({ reserve: dep.reserve, kind, call: O.ownerCall("configure", { id, policy: p }), from: kind.kind === "safe" ? null : ctx.from });
  const cost = await costFor(H, st, p);
  req.notes.push(`policy: ${p.enabled ? "enabled" : "DISABLED"}, claims ${O.claimPolicyName(p.claimPolicy)}, release ${p.sponsorRelease ? "sponsored" : "not sponsored"}, `
    + `per op ≤ ${eth(p.maxPerOpWei)}, ≤ ${eth(p.epochCapWei)} per ${p.epochSec}s, gas price ≤ ${formatGwei(p.maxGasPrice)} gwei; `
    + `at today's fee a renew charges ≤ ${eth(cost.perOp.renew.wei)}, a claim ≤ ${eth(cost.perOp.claim.wei)}`);
  return deliver(H, req);
}

async function withdraw(H) {
  const { f, ctx, dep, chain } = H;
  const id = oneId(f);
  // the reserve is keyed to the CALLER (a previous owner withdraws its own); default: the current owner of record
  const { st } = await ownerOf(H, id);
  const who = f.as ? getAddress(f.as) : st.ledger.owner;
  const kind = await O.ownerKind(chain, who, { vaultFactories: H.vaultFactories });
  const mine = await chain.read(dep.reserve, O.OWNER_ABI, "reserveOf", [id, who]);
  let amount = amountOf(f, { allowAll: true });
  if (amount === "all") amount = BigInt(mine.balanceWei);
  if (amount === 0n) throw new Error(`the reserve of ${who} for ${id} is empty`);
  if (amount > BigInt(mine.balanceWei)) throw new Error(`the reserve of ${who} for ${id} holds ${eth(mine.balanceWei)}, less than ${eth(amount)}`);
  // where the ETH goes: the vault cannot receive ETH (no receive()), so a vault's withdrawal goes to its owner's wallet
  const to = f.to ? getAddress(f.to) : kind.kind === "session-vault" ? kind.vaultOwner : who;
  if (kind.kind === "session-vault" && to.toLowerCase() === kind.address.toLowerCase()) throw new Error("a SessionVault cannot receive ETH: withdraw to its owner's wallet (the default) or another --to");
  const req = O.ownerRequest({ reserve: dep.reserve, kind, call: O.ownerCall("withdraw", { id, amountWei: amount, to }), from: kind.kind === "safe" ? null : ctx.from });
  return deliver(H, req);
}

async function claimant(H) {
  const { f, ctx, dep } = H;
  const [id, operator] = f._;
  if (!ID.test(id || "") || !operator) throw new Error("usage: lease-gas claimant <id> <operator> --allow | --deny");
  if (!!f.allow === !!f.deny) throw new Error("say --allow or --deny");
  const { kind } = await ownerOf(H, id);
  return deliver(H, O.ownerRequest({ reserve: dep.reserve, kind, call: O.ownerCall("claimant", { id, operator, allowed: !!f.allow }), from: kind.kind === "safe" ? null : ctx.from }));
}

function oneId(f) {
  const id = f._[0];
  if (!ID.test(id || "") || f._.length !== 1) throw new Error("name exactly one deployment id (0x + 64 hex)");
  return id;
}

// ---- plan: every app's exact requests, with an owner-chosen amount -----------------------------------------------------
async function plan(H) {
  const { f, ctx, dep, chain } = H;
  const apps = [];
  let refCost = null;
  for (const { id, inventory } of idsOf(H)) {
    const st = await O.appStatus(chain, dep, id);
    if (st.unknown) { apps.push({ id, unknown: true }); continue; }
    const kind = await O.ownerKind(chain, st.ledger.owner, { vaultFactories: H.vaultFactories });
    if (kind.kind === "credit-vault" || kind.kind === "contract") {   // no reviewed owner path: listed with the reason, nothing prepared, no amount
      const refused = kind.kind === "credit-vault" ? O.creditVaultRefusal(kind, "a deposit or configuration") : O.unknownOwnerRefusal(kind, "a deposit or configuration");
      apps.push({ id, appRef: st.ledger.appRef, owner: st.ledger.owner, ownerKind: kindView(kind), rate6: st.ledger.rate6, leaseLive: st.ledger.leaseLive,
        leaseUntil: st.ledger.leaseUntil, runnerOperator: st.ledger.runnerOperator, inventoryOperator: inventory?.operator, refused: refused.message, steps: [] });
      continue;
    }
    const p = policyFrom(H, st.reserve, st.l1.upperBoundAuthWei);
    const cost = await costFor(H, st, p);
    refCost = refCost || cost;
    const amount = O.budgetAmount({ perAppWei: f["per-app-wei"], perAppEth: f["per-app-eth"], days: f.days }, cost);
    const payer = f.payer ? getAddress(f.payer) : kind.kind.startsWith("eoa") ? kind.address : kind.kind === "session-vault" ? kind.vaultOwner : kind.address;
    const steps = [];
    const dreq = O.depositRequest({ reserve: dep.reserve, id, amountWei: amount.wei, from: payer });
    steps.push(await planned(chain, kind.kind === "safe" && !f.payer ? { ...dreq, via: "safe" } : dreq, "deposit"));
    if (!st.reserve.configured || f.reconfigure || !st.reserve.enabled) {
      const creq = O.ownerRequest({ reserve: dep.reserve, kind, call: O.ownerCall("configure", { id, policy: p }) });
      steps.push(await planned(chain, creq, "configure"));
    }
    if (p.claimPolicy === 1 && st.runner?.registry && !st.runner.registry.payoutIsOwner)
      steps.push({ step: "note", text: `claim policy self-hosted: the current runner's payout wallet ${st.runner.registry.payoutWallet} is not the owner; its renewals stay sponsored (renew needs no claimant check) but a re-claim by it would be refused` });
    apps.push({ id, appRef: st.ledger.appRef, owner: st.ledger.owner, ownerKind: kindView(kind), rate6: st.ledger.rate6, leaseLive: st.ledger.leaseLive,
      leaseUntil: st.ledger.leaseUntil, runnerOperator: st.ledger.runnerOperator, inventoryOperator: inventory?.operator, reserveNow: st.reserve.balanceWei,
      configuredNow: st.reserve.configured, amount: { wei: amount.wei, eth: formatEther(amount.wei), basis: amount.basis },
      lastsDaysAtTodaysFee: cost.renewPerDayWei ? Number((st.reserve.balanceWei + amount.wei) * 10n / cost.renewPerDayWei) / 10 : null, policy: p, steps });
  }
  // what each sender needs, and has (agreed)
  const bySender = {};
  for (const a of apps) for (const s of a.steps || []) if (s.from) {
    const k = s.from.toLowerCase();
    bySender[k] = bySender[k] || { from: s.from, via: new Set(), requests: 0, valueWei: 0n };
    bySender[k].via.add(s.via); bySender[k].requests++; bySender[k].valueWei += BigInt(s.value);
  }
  for (const s of Object.values(bySender)) { s.via = [...s.via]; s.balanceWei = await chain.balance(s.from); s.enough = s.balanceWei >= s.valueWei; }
  const res = { ...H.out, title: "lease-gas enrollment plan - UNSIGNED, nothing sent", fee: H.fee, apps,
    senders: Object.values(bySender), totalWei: apps.reduce((m, a) => m + (a.amount?.wei || 0n), 0n),
    costModel: refCost ? costView(refCost) : null,
    notes: ["every request was simulated from its sender at an agreed block; re-run the plan right before signing (owners, leases and fees move)",
      "the ledger rows are not touched: ids, storage and rates stay as they are; this only funds and enables the separate gas reserve",
      "the claim bond (USDC collateral) and proof-of-time checkpoints are not lease gas and are not paid from this reserve"] };
  if (ctx.json || f.format) return ctx.jout(res);
  ctx.say(`lease-gas plan for ${apps.length} apps (UNSIGNED; nothing is sent). Fee now ${formatGwei(H.fee.effective)} gwei.`);
  for (const a of apps) {
    if (a.unknown) { ctx.say(`${a.id}: not a deployment on this ledger`); continue; }
    if (a.refused) { ctx.say(`\n${a.id} ${a.appRef} - owner ${a.owner} (${a.ownerKind.kind}): REFUSED - ${a.refused}`); continue; }
    ctx.say(`\n${a.id} ${a.appRef} - owner ${a.owner} (${a.ownerKind.kind}); rate ${a.rate6}; lease ${a.leaseLive ? "live" : "expired"}; deposit ${a.amount.eth} ETH (${a.amount.basis}); lasts ~${a.lastsDaysAtTodaysFee} days at today's fee`);
    for (const s of a.steps) ctx.say(s.step === "note" ? `  · ${s.text}` : `  ${s.step}: ${s.via} from ${s.from} to ${s.to} value ${s.value} ${s.simulated ? "(simulated ok)" : `(NOT simulated: ${s.simError})`}\n    data ${s.data}`);
  }
  for (const s of res.senders) ctx.say(`\nsender ${s.from}: ${s.requests} requests, ${eth(s.valueWei)} total value, holds ${eth(s.balanceWei)}${s.enough ? "" : "  ** NOT ENOUGH **"}`);
  ctx.say(`\ntotal deposits ${eth(res.totalWei)}`);
}
async function planned(chain, req, step) {
  let sim;
  try { sim = await O.simulate(chain, req); } catch (e) { sim = { simulated: false, simError: e.message }; }
  return { step, via: req.via, from: req.from, to: req.to, value: req.value, data: req.data, inner: req.inner, safe: req.safe, what: req.what, notes: req.notes,
    simulated: !!sim.simulated, simBlock: sim.block, simError: sim.simError };
}
