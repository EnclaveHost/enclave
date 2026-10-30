// FAIL-CLOSED signer/sender for the ONE executable C9 maintenance plan (lib/maintenance.mjs). SOURCE ONLY: nothing wires
// it to a key. The caller injects
//   signers.operator = { address, signAuthorization({ chainId, address, nonce }) -> { chainId, address, nonce, r, s, yParity } }
//   signers.sponsor  = { address, signTransaction(tx) -> 0x raw }
// and this module never reads a key, a key path or a production config. It:
//   1. accepts only an EXECUTABLE plan whose every field re-derives from the pins, and a root approval file whose sha256
//      the caller states and whose contents bind the plan hash, the timing profile and every pin;
//   2. re-reads the chain on BOTH providers (code, settled nonces, balance, includable fees, deadline) before signing;
//   3. signs exactly the two authorizations and the two transactions, verifies every signature against the plan;
//   4. writes both raw transactions to a private 0600 journal (O_EXCL, fsynced, directory fsynced) BEFORE any broadcast;
//   5. broadcasts A then B (those bytes only), then verifies on BOTH providers within the maintenance cutoff: receipts,
//      2 confirmations, C9 code/code hash/nonce/balance, raw executor storage, executor views, reserve binding;
//   6. otherwise records a classified recovery state; resume() never signs and only rebroadcasts the journaled bytes.
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, decodeFunctionResult, keccak256, parseTransaction, parseAbi, recoverTransactionAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { pacedTransport, httpRpc, PACING, realClock, Refusal } from "../vendor/publish.mjs";
import { PRODUCTION, checkConfig, createPreparer, authorizations, transaction, designatorOf, timingSha256, sha256, ser, RECOVERY, authorizedSlot, nonceSlot,
  COLD, coldProfileSha256, coldPlanProfile, checkProfile, PLAN_KIND, COLD_PLAN_KIND } from "./maintenance.mjs";

const lc = (x) => String(x ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
const refuse = (code, message) => { throw new Refusal(code, message); };
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const EXECUTOR_ABI = parseAbi(["function nonceOf(bytes32 id) view returns (uint64)", "function authorizationCharged() view returns (bool)"]);
const RESERVE_ABI = parseAbi(["function executor() view returns (address)", "function delegationCodeHash() view returns (bytes32)"]);
export const APPROVAL_KIND = "enclave-operator-7702-maintenance/approval";
export const COLD_APPROVAL_KIND = "enclave-operator-7702-maintenance/approval-cold";
export const REQUIRED_ROLES = Object.freeze(["c9-key-holder", "sponsor-owner"]);

/** The executable plan must re-derive exactly from the pins: nothing in it is trusted as given. A plan is bound to ONE profile. */
export function checkExecutablePlan(cfg, plan, profile = "live") {
  const cold = checkProfile(profile);
  if (plan?.kind !== (cold ? COLD_PLAN_KIND : PLAN_KIND) || plan.executable !== true) refuse("plan", `not an executable ${profile} plan (an observation is NEVER executable)`);
  if (cold ? JSON.stringify(plan.profile) !== JSON.stringify(coldPlanProfile()) : plan.profile !== undefined) refuse("plan_profile", `the plan's profile is not the reviewed ${profile} profile`);
  if (cold && (plan.quiesce?.mode !== "cold" || plan.quiesce?.cold?.profile !== COLD.marker)) refuse("plan_profile", "the cold plan carries no root cold-shutdown facts");
  if (!cold && plan.quiesce?.mode !== undefined) refuse("plan_profile", "a live plan cannot carry cold-shutdown facts");
  const p = plan.pins;
  for (const [k, v] of [["chainId", cfg.chainId], ["operator", cfg.operator], ["executor", cfg.executor], ["sponsor", cfg.sponsor], ["delegationCodeHash", cfg.delegationCodeHash],
    ["valueWei", cfg.valueWei.toString()], ["feeCapWei", cfg.feeCapWei.toString()]])
    if (lc(p?.[k]) !== lc(v)) refuse("plan_pins", `plan pin ${k} differs from the reviewed value`);
  if (plan.timing?.sha256 !== timingSha256(cfg.timing)) refuse("plan_timing", "the plan's timing profile is not the reviewed one");
  const N = BigInt(plan.observed.operatorNonce), s = BigInt(plan.observed.sponsorNonce);
  const want = authorizations(cfg, N);
  plan.authorizationsToSign.forEach((a, i) => { if (JSON.stringify(a.tuple) !== JSON.stringify(want[i].tuple) || a.digest !== want[i].digest) refuse("plan_auth", `authorization ${i} differs from the derived one`); });
  if (plan.authorizationsToSign.length !== 2 || plan.transactions.length !== 2) refuse("plan_shape", "exactly two authorizations and two transactions");
  let total = 0n;
  const txs = ["A", "B"].map((w, i) => {
    const u = plan.transactions[i].unsigned;
    const t = transaction(cfg, w, { s, N, maxFeePerGas: u.maxFeePerGas, maxPriorityFeePerGas: u.maxPriorityFeePerGas });
    const derived = ser({ ...t.tx, authorizationList: [{ ...t.auth.tuple, signature: `authorizationsToSign[${i}]` }] });
    if (JSON.stringify(derived) !== JSON.stringify(u)) refuse("plan_tx", `transaction ${w} differs from the derived one`);
    const f = plan.transactions[i].fee;
    if (BigInt(f.l2MaxWei) !== t.tx.gas * t.tx.maxFeePerGas || BigInt(f.totalWei) !== BigInt(f.l2MaxWei) + BigInt(f.l1UpperBoundWei) + BigInt(f.operatorFeeWei)) refuse("plan_fee", `transaction ${w}'s fee bound does not add up`);
    total += BigInt(f.totalWei);
    return t.tx;
  });
  if (total !== BigInt(plan.fees.totalBoundWei) || total > cfg.feeCapWei) refuse("fee_cap", `the plan's bounded fees ${total} exceed the cap ${cfg.feeCapWei} (or do not add up)`);
  if (!plan.quiesce || plan.quiesce.providedBy !== "root") refuse("plan", "the plan carries no root quiescence facts");
  return { N, s, txs, total };
}

/** The approval file: its sha256 is stated by the caller (root), and its contents bind the plan and every pin. */
export function checkApproval(cfg, plan, planHash, approvalText, approvalSha256, nowSec, profile = "live") {
  const cold = checkProfile(profile);
  if (!approvalText || "0x" + sha256(approvalText) !== lc(approvalSha256)) refuse("approval", "the approval file's sha256 is not the one stated for this run");
  let a; try { a = JSON.parse(approvalText); } catch { refuse("approval", "the approval file is not JSON"); }
  if (a.kind !== (cold ? COLD_APPROVAL_KIND : APPROVAL_KIND) || a.approvedBy !== "root") refuse("approval", `not a root approval for this ${profile} maintenance`);
  if (cold ? a.profile !== COLD.marker || a.coldProfileSha256 !== coldProfileSha256() : a.profile !== undefined || a.coldProfileSha256 !== undefined)
    refuse("approval", `the approval does not bind the reviewed ${profile} profile`);
  if (lc(a.planHash) !== lc(planHash)) refuse("approval", "the approval names another plan");
  if (a.timingProfileSha256 !== timingSha256(cfg.timing)) refuse("approval", "the approval does not bind the reviewed timing profile");
  for (const [k, v] of [["chainId", cfg.chainId], ["operator", cfg.operator], ["executor", cfg.executor], ["sponsor", cfg.sponsor], ["valueWei", cfg.valueWei.toString()], ["feeCapWei", cfg.feeCapWei.toString()]])
    if (lc(a[k]) !== lc(v)) refuse("approval", `the approval's ${k} differs from the reviewed value`);
  const roles = new Set((a.humanApprovals || []).filter((h) => h && h.by && h.at).map((h) => h.role));
  for (const r of REQUIRED_ROLES) if (!roles.has(r)) refuse("approval", `the human approval of the ${r} is missing`);
  if (!Number.isSafeInteger(a.expiresAt) || nowSec > a.expiresAt) refuse("approval", "the approval has expired");
  return a;
}

// ---- the journal: one private, exclusive, fsynced record per plan ----
export function journalStore(dir, fsImpl = fs) {
  const file = (h) => path.join(dir, `${h}.json`);
  const ensure = () => {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fsImpl.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) refuse("journal", `${dir} must be a private 0700 directory owned by this user`);
  };
  const fsyncDir = () => { const fd = fsImpl.openSync(dir, "r"); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } };
  const writeAt = (target, rec, flag) => {
    const fd = fsImpl.openSync(target, flag, 0o600);
    try { fsImpl.writeFileSync(fd, JSON.stringify(rec, big, 1) + "\n"); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  };
  return {
    file,
    exists: (h) => fsImpl.existsSync(file(h)),
    others: (h) => (fsImpl.existsSync(dir) ? fsImpl.readdirSync(dir).filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f) && f !== `${h}.json`) : []),
    create(h, rec) { ensure(); writeAt(file(h), rec, "wx"); fsyncDir(); },                     // O_EXCL: an existing record wins
    update(h, rec) { ensure(); const tmp = path.join(dir, `.${h}.${process.pid}.${Date.now()}.tmp`); writeAt(tmp, rec, "wx"); fsImpl.renameSync(tmp, file(h)); fsyncDir(); },
    read: (h) => JSON.parse(fsImpl.readFileSync(file(h), "utf8")),
  };
}

export function createSender({ cfg = PRODUCTION, fixture = false, rpc = httpRpc(15_000), clock = realClock, pacing = PACING, signers, journalDir, pollMs = 4_000, profile = "live" } = {}) {
  checkConfig(cfg);
  if (checkProfile(profile) && fixture) throw Error("the cold profile has no fixture mode: production pins only");
  if (!fixture) for (const k of Object.keys(PRODUCTION)) if (JSON.stringify(cfg[k], big) !== JSON.stringify(PRODUCTION[k], big)) throw Error(`config ${k} must be the production value`);
  if (!journalDir) throw Error("a journal directory is required");
  const rpcs = [...cfg.rpcs];
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw Error("exactly two distinct RPCs");
  const J = journalStore(journalDir);
  const io = () => {
    const t = pacedTransport({ rpc, pacing: { ...pacing, maxRequests: 100, timeBudgetMs: 120_000, freshnessMs: 120_000 }, clock });
    const both = (m, p) => Promise.all(rpcs.map((u) => t.send(u, m, p)));
    const agree = async (what, m, p) => { const r = await both(m, p); if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) refuse("rpc_disagree", `the providers disagree on ${what}`); return r[0]; };
    return { both, agree, send: (u, m, p) => t.send(u, m, p) };
  };
  const nowSec = () => Math.floor(clock.now() / 1000);

  // ---- fresh pre-signing checks on both providers, at the latest block ----
  async function preflight(plan, N, s, total) {
    const quiesce = {...plan.quiesce, leases: plan.quiesce.leases.map(l => ({id:l.id, expiry:l.leaseUntil}))};
    const fresh = (await createPreparer({cfg, fixture, rpc, clock, pacing, profile}).prepare({quiesce})).plan;   // cold facts re-validated at a fresh block
    if (JSON.stringify(fresh.observed.storage) !== JSON.stringify(plan.observed.storage) || JSON.stringify(fresh.observed.executorViews) !== JSON.stringify(plan.observed.executorViews)) refuse('state_changed', 'Executor state changed after preparation');
    for (let i=0;i<2;i++) {
      const f=fresh.transactions[i], p=plan.transactions[i];
      if (BigInt(f.unsigned.maxFeePerGas)>BigInt(p.unsigned.maxFeePerGas) || BigInt(f.unsigned.maxPriorityFeePerGas)>BigInt(p.unsigned.maxPriorityFeePerGas) || BigInt(f.fee.l1UpperBoundWei)>BigInt(p.fee.l1UpperBoundWei) || BigInt(f.fee.operatorFeeWei)>BigInt(p.fee.operatorFeeWei)) refuse('fees', 'Fresh L1/L2/operator fee bound exceeds the approved plan; prepare again');
    }
    const { both, agree } = io();
    if ((await both("eth_chainId", [])).some((x) => Number(x) !== cfg.chainId)) refuse("chain", "a provider is not on the pinned chain");
    const latest = await both("eth_getBlockByNumber", ["latest", false]);
    const ts = Math.min(...latest.map((b) => Number(BigInt(b.timestamp)))), base = latest.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a));
    if (ts > plan.broadcastDeadline) refuse("stale_plan", `the plan's broadcast deadline ${plan.broadcastDeadline} has passed (chain time ${ts}): prepare again`);
    if (lc(await agree("C9 code", "eth_getCode", [cfg.operator, "latest"])) !== designatorOf(cfg.executor)) refuse("operator_code", "C9 is no longer delegated to exactly the reviewed executor");
    for (const [who, a, want] of [["C9", cfg.operator, N], ["sponsor", cfg.sponsor, s]]) {
      const l = (await both("eth_getTransactionCount", [a, "latest"])).map(BigInt), p = (await both("eth_getTransactionCount", [a, "pending"])).map(BigInt);
      if ([...l, ...p].some((x) => x !== want)) refuse("nonce", `the ${who}'s nonce moved since the plan (want ${want}, latest ${l}, pending ${p}): nothing was signed`);
    }
    if (lc(await agree("sponsor code", "eth_getCode", [cfg.sponsor, "latest"])) !== "0x") refuse("sponsor_code", "the sponsor has code");
    const bal = BigInt(await agree("sponsor balance", "eth_getBalance", [cfg.sponsor, "latest"]));
    if (bal < cfg.valueWei + total) refuse("sponsor_balance", `the sponsor holds ${bal} wei, less than V + bounded fees`);
    const u = plan.transactions[0].unsigned;
    if (base + BigInt(u.maxPriorityFeePerGas) > BigInt(u.maxFeePerGas)) refuse("fees", "the current base fee no longer fits the planned fee cap: prepare again (the cap is not raised)");
  }

  // ---- sign exactly the plan, verify every signature ----
  async function signAll(plan, N, s, txs) {
    if (lc(signers?.operator?.address) !== lc(cfg.operator) || lc(signers?.sponsor?.address) !== lc(cfg.sponsor)) refuse("signer", "the injected signers are not C9 and the sponsor");
    const auths = [];
    for (const a of plan.authorizationsToSign) {
      const sig = await signers.operator.signAuthorization({ ...a.tuple });
      const signed = { chainId: a.tuple.chainId, address: a.tuple.address, nonce: a.tuple.nonce, r: sig.r, s: sig.s, yParity: sig.yParity };
      if (sig.chainId !== a.tuple.chainId || lc(sig.address ?? sig.contractAddress) !== lc(a.tuple.address) || Number(sig.nonce) !== a.tuple.nonce) refuse("signer", "the operator signed another tuple");
      if (lc(await recoverAuthorizationAddress({ authorization: signed })) !== lc(cfg.operator)) refuse("signer", "an authorization is not signed by C9");
      auths.push(signed);
    }
    const raw = {}, hash = {};
    for (const [i, w] of ["A", "B"].entries()) {
      const tx = { ...txs[i], authorizationList: [auths[i]] };
      const r = await signers.sponsor.signTransaction(tx);
      const p = parseTransaction(r);
      if (lc(await recoverTransactionAddress({ serializedTransaction: r })) !== lc(cfg.sponsor)) refuse("signer", `transaction ${w} is not signed by the sponsor`);
      const same = p.type === "eip7702" && p.chainId === tx.chainId && p.nonce === tx.nonce && lc(p.to) === lc(tx.to) && (p.value ?? 0n) === tx.value && (p.data ?? "0x") === tx.data
        && p.gas === tx.gas && p.maxFeePerGas === tx.maxFeePerGas && p.maxPriorityFeePerGas === tx.maxPriorityFeePerGas && !(p.accessList?.length)
        && p.authorizationList?.length === 1 && lc(p.authorizationList[0].address) === lc(auths[i].address) && p.authorizationList[0].nonce === auths[i].nonce
        && p.authorizationList[0].chainId === auths[i].chainId && lc(p.authorizationList[0].r) === lc(auths[i].r) && lc(p.authorizationList[0].s) === lc(auths[i].s);
      if (!same) refuse("signer", `the signed transaction ${w} differs from the plan`);
      raw[w] = r; hash[w] = keccak256(r);
    }
    return { raw, hash };
  }

  // ---- read the outcome on both providers ----
  async function observeOutcome(plan, rec) {
    const { both, agree } = io();
    const N = BigInt(plan.observed.operatorNonce);
    const receipts = {};
    for (const w of ["A", "B"]) {
      const r = await both("eth_getTransactionReceipt", [rec.hash[w]]);
      if (r.every((x) => !x)) { receipts[w] = null; continue; }
      if (!r[0] || !r[1] || lc(r[0].blockHash) !== lc(r[1].blockHash) || r[0].blockNumber !== r[1].blockNumber || r[0].status !== r[1].status) return { settled: false, why: `the providers do not yet agree on ${w}'s receipt` };
      receipts[w] = { status: r[0].status, block: BigInt(r[0].blockNumber), blockHash: lc(r[0].blockHash) };
    }
    const heads = (await both("eth_blockNumber", [])).map(BigInt);
    const code = lc(await agree("C9 code", "eth_getCode", [cfg.operator, "latest"]));
    const nonce = BigInt(await agree("C9 nonce", "eth_getTransactionCount", [cfg.operator, "latest"]));
    const balance = BigInt(await agree("C9 balance", "eth_getBalance", [cfg.operator, "latest"]));
    const sponsorNonce = BigInt(await agree("sponsor nonce", "eth_getTransactionCount", [cfg.sponsor, "latest"]));
    const o = { receipts, heads, code, nonce, balance, sponsorNonce };
    const conf = (w) => receipts[w] && heads.every((h) => h - receipts[w].block >= 2n);
    // Base may return preconfirmation receipts with a zero block hash before eth_getCode/latest catches up.
    // Neither restoration nor a stale authorization is established until receipts are canonical and deep enough.
    if (["A", "B"].some(w => receipts[w] && (!/^0x[0-9a-f]{64}$/.test(receipts[w].blockHash) || /^0x0{64}$/.test(receipts[w].blockHash) || !conf(w))))
      return { ...o, state: "pending-confirmations", why: "receipt not yet canonical with two confirmations" };
    // classification (RECOVERY states)
    if (receipts.A?.status === "0x0") return { ...o, state: "a-reverted" };
    if (receipts.A && !receipts.B) return { ...o, state: code === "0x" ? "a-mined-b-missing" : (code === designatorOf(cfg.executor) ? "b-stale" : "unexpected-code") };
    if (receipts.A && receipts.B && code === "0x") return { ...o, state: "b-stale" };
    if (receipts.A && receipts.B && code === designatorOf(cfg.executor) && conf("A") && conf("B")) {
      const problems = [];
      if (keccak256(code) !== cfg.delegationCodeHash) problems.push("code hash");
      if (nonce !== N + 2n) problems.push(`C9 nonce ${nonce} (want ${N + 2n})`);
      if (balance < BigInt(plan.observed.operatorBalanceWei) + cfg.valueWei) problems.push("C9 was not funded by V");
      const st = plan.observed.storage;
      if (lc(await agree("authorized slot", "eth_getStorageAt", [cfg.operator, authorizedSlot(cfg), "latest"])) !== lc(st.authorized)) problems.push("authorized slot");
      for (const [id, v] of Object.entries(st.nonces || {})) if (lc(await agree("nonce slot", "eth_getStorageAt", [cfg.operator, nonceSlot(cfg, id), "latest"])) !== lc(v)) problems.push(`nonce slot ${id.slice(0, 10)}`);
      const call = async (to, abi, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: await agree(`${fn}`, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, "latest"]) });
      const v = plan.observed.executorViews;
      if (v.authorizationCharged !== null && (await call(cfg.operator, EXECUTOR_ABI, "authorizationCharged")) !== v.authorizationCharged) problems.push("authorizationCharged");
      for (const [id, want] of Object.entries(v.nonceOf || {})) if ((await call(cfg.operator, EXECUTOR_ABI, "nonceOf", [id])).toString() !== want) problems.push(`nonceOf ${id.slice(0, 10)}`);
      if (lc(await call(cfg.reserve, RESERVE_ABI, "executor")) !== lc(cfg.executor) || (await call(cfg.reserve, RESERVE_ABI, "delegationCodeHash")) !== cfg.delegationCodeHash) problems.push("reserve binding");
      return { ...o, state: problems.length ? "verify-mismatch" : "verified", problems };
    }
    return { ...o, state: receipts.A || receipts.B ? "pending-confirmations" : "not-mined" };
  }

  async function awaitOutcome(plan, rec, startSec) {
    const end = startSec + cfg.timing.maintenanceCutoffSec;
    for (;;) {
      let o;
      try { o = await observeOutcome(plan, rec); } catch (e) { if (!(e instanceof Refusal) || e.code !== "rpc_disagree") throw e; o = { state: "unsettled", why: e.message }; }
      if (["verified", "a-reverted", "b-stale", "verify-mismatch", "unexpected-code"].includes(o.state)) return o;
      if (nowSec() >= end) return { ...o, state: o.state === "pending-confirmations" || o.state === "unsettled" ? o.state : (o.receipts?.A ? "a-mined-b-missing" : "not-mined"), cutoff: true };
      await clock.sleepUntil(clock.now() + pollMs);
    }
  }
  const summarize = (o) => ser({ state: o.state, cutoff: !!o.cutoff, problems: o.problems || [], receipts: o.receipts, code: o.code, nonce: o.nonce, balance: o.balance,
    recovery: RECOVERY.find((r) => r.state === o.state) || null });

  async function broadcast(rec, which) {
    const { send } = io();
    const out = [];
    for (const u of rpcs) {
      try { const h = lc(await send(u, "eth_sendRawTransaction", [rec.raw[which]])); out.push({ rpc: new URL(u).host, result: h === rec.hash[which] ? "accepted" : "answered another hash" }); }
      catch (e) { out.push({ rpc: new URL(u).host, result: e instanceof Refusal ? e.code : "refused or unreachable" }); }   // never the remote body
    }
    return out;
  }

  /** The one run: approval -> fresh checks -> sign -> journal -> broadcast A, B -> verify (or a classified recovery state). */
  async function run({ planText, approvalText, approvalSha256 }) {
    const planHash = "0x" + sha256(planText);
    const plan = JSON.parse(planText);
    const { N, s, txs, total } = checkExecutablePlan(cfg, plan, profile);
    checkApproval(cfg, plan, planHash, approvalText, approvalSha256, nowSec(), profile);
    if (J.exists(planHash)) refuse("journal", "this plan was already signed: use resume (this sender never signs twice)");
    if (J.others(planHash).length) refuse("journal", "another maintenance journal exists in this directory: resolve it first");
    await preflight(plan, N, s, total);
    const { raw, hash } = await signAll(plan, N, s, txs);
    const rec = { planHash, approvalSha256: lc(approvalSha256), signedAt: new Date(clock.now()).toISOString(), broadcastDeadline: plan.broadcastDeadline,
      nonces: { operator: N.toString(), sponsor: s.toString() }, raw, hash, status: "signed", broadcasts: [] };
    J.create(planHash, rec);                                                               // durable BEFORE any broadcast
    if (nowSec() > plan.broadcastDeadline) refuse('stale_plan', 'Signing passed the broadcast deadline; journal retained, nothing broadcast');
    const start = nowSec();
    rec.broadcasts.push({ which: "A", at: new Date(clock.now()).toISOString(), results: await broadcast(rec, "A") });
    rec.broadcasts.push({ which: "B", at: new Date(clock.now()).toISOString(), results: await broadcast(rec, "B") });
    rec.status = "broadcast"; J.update(planHash, rec);
    const o = await awaitOutcome(plan, rec, start);
    rec.status = o.state === "verified" ? "verified" : "recovery-required"; rec.outcome = summarize(o); J.update(planHash, rec);
    return { planHash, status: rec.status, outcome: rec.outcome };
  }

  /** Never signs. Re-reads the chain; with rebroadcast, re-sends ONLY the journaled bytes whose nonces are still open. */
  async function resume({ planText, rebroadcast = false }) {
    const planHash = "0x" + sha256(planText);
    const plan = JSON.parse(planText);
    const { N } = checkExecutablePlan(cfg, plan, profile);
    if (!J.exists(planHash)) refuse("journal", "no journal for this plan: nothing was signed");
    const rec = J.read(planHash);
    for (const w of ["A", "B"]) if (keccak256(rec.raw[w]) !== rec.hash[w]) refuse("journal", "the journal's raw bytes do not hash to its record");
    const before = await observeOutcome(plan, rec).catch((e) => ({ state: "unsettled", why: e.message }));
    if (before.state === "verified") { rec.status = "verified"; rec.outcome = summarize(before); J.update(planHash, rec); return { planHash, status: "verified", outcome: rec.outcome }; }
    if (rebroadcast) {
      const { both } = io();
      const sponsorNonce = (await both("eth_getTransactionCount", [cfg.sponsor, "latest"])).map(BigInt).reduce((a, x) => (x < a ? x : a));
      const c9 = BigInt((await both("eth_getTransactionCount", [cfg.operator, "latest"]))[0]);
      const chainTs = Math.min(...(await both("eth_getBlockByNumber", ["latest", false])).map((b) => Number(BigInt(b.timestamp))));
      const sent = [];
      // A: only while its nonce is open, C9 untouched (nonce N, delegated) and before the deadline; never after B's restoration window opened
      if (sponsorNonce <= BigInt(rec.nonces.sponsor) && c9 === N && lc(before.code) === designatorOf(cfg.executor) && chainTs <= plan.broadcastDeadline)
        sent.push({ which: "A", results: await broadcast(rec, "A") });
      else sent.push({ which: "A", skipped: "A's nonce is used, C9 moved, or the broadcast deadline passed" });
      // B: restoring is always wanted while the sponsor's s+1 is open (a stale authorization makes it a harmless no-op)
      if (sponsorNonce <= BigInt(rec.nonces.sponsor) + 1n) sent.push({ which: "B", results: await broadcast(rec, "B") });
      else sent.push({ which: "B", skipped: "B's nonce is used" });
      rec.broadcasts.push({ resumeAt: new Date(clock.now()).toISOString(), sent });
    }
    const o = await awaitOutcome(plan, rec, nowSec());
    rec.status = o.state === "verified" ? "verified" : "recovery-required"; rec.outcome = summarize(o); J.update(planHash, rec);
    return { planHash, status: rec.status, outcome: rec.outcome };
  }
  return { run, resume };
}
