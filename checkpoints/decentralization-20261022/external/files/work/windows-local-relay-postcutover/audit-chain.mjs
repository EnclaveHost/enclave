// audit-chain.mjs - READ-ONLY public-chain evidence for the local-relay cutover on minipc. No signer and no send method exist
// here. It reuses main's verified lease authority and verifyLeaseReceipt (the same checks as
// work/lease-relay-activation/audit-paid-leases.mjs).
//   node audit-chain.mjs --expectations expectations.json --cutover cutover.json --minipc minipc.json [--out chain.json]
// The window starts at the REQUIRED cutover marker (root writes cutover.json after 20-activate.ps1 exits 0):
//   { "cutoverBlock": <Base block number at or after the activation>, "activatedAt": "<ISO time 20-activate finished>" }
// That block's quorum-agreed timestamp must not be before activatedAt, so no earlier us-west payment (the SAME payee key,
// then on DigitalOcean) can enter the window. From that block to the agreed authority head:
//   - LeaseGasPaid logs at the pinned reserve are DISCOVERED per provider (an untrusted hint, chunked; absence is never
//     proven);
//   - each event for one of the nine apps is VERIFIED through the quorum: the canonical transaction, a successful receipt,
//     the reviewed reserve/executor code at that block, the operator's delegation, the charge within the signed maximum, the
//     ledger state (verifyLeaseReceipt); the sender is the relay key itself (tx.from = payee);
//   - classified:
//     - moved: payee 0x51ff..., which must ALSO appear as a "[relay] success <hash>" line in minipc's own relay log (the
//       collector's relayLog): that is the local-routing proof;
//     - fallback: the eu-central payee;
//     - anything else fails: another payee, another operator for these apps, a verification error, or a moved-payee event
//       missing from minipc's log (the key used elsewhere).
// Candidates come from log discovery AND from minipc's relay log ("[relay] success <hash>"), so one failing discovery
// provider cannot hide a payment. When the quorum does not agree on a payment, the same verification runs against EACH
// provider alone (diagnostics): a quorum of identical per-provider results verifies it; otherwise it is UNVERIFIED (proof
// not observed: a provider unavailable or lagging) unless every answering provider reports the same definite defect
// (reverted, another lease, unreviewed code, ledger mismatch, charge above the maximum), which FAILS.
// status: LOCAL_VERIFIED (at least one moved payment routed locally, nothing failed, nothing unverified) | PARTIAL (moved
// payments verified, some unverified: re-run) | FALLBACK_ONLY / NO_EVENTS_YET (pending) | UNVERIFIED_ONLY (pending) | FAILED.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.ENCLAVE_MAIN || path.resolve(HERE, "../enclave");
const imp = (p) => import(pathToFileURL(path.join(MAIN, p)).href);
const viem = await imp("node_modules/viem/_esm/index.js");
const { leaseRpcSet, verifiedLeaseAuthority } = await imp("client/lease-executor-authority.mjs");
const { verifyLeaseReceipt, EXECUTOR_ABI, RESERVE_ABI } = await imp("client/lease-executor-client.mjs");
const { parseDeploymentRecord } = await imp("network/lease-gas-owner.mjs");
const lc = (s) => String(s || "").toLowerCase();
// which of main's modules judged the receipts: recorded in every report, and refused when they differ from the TESTED ones
export const AUDIT_CODE = ["client/lease-executor-authority.mjs", "client/lease-executor-client.mjs", "network/lease-gas-owner.mjs"];
export const auditCodeHashes = () => Object.fromEntries(AUDIT_CODE.map((f) => [f, createHash("sha256").update(fs.readFileSync(path.join(MAIN, f))).digest("hex")]));

/** the relay log lines the minipc collector extracted: [{ status, hash, paid }] -> Map(hash -> status) */
export const relayLogIndex = (lines = []) => new Map(lines.filter((l) => /^0x[0-9a-f]{64}$/i.test(String(l?.hash || ""))).map((l) => [lc(l.hash), String(l.status)]));

const DEFINITE = /reverted|another lease|unreviewed|does not show|exceeds|payee this host never signed|not a canonical lease|does not call this operator|wrong lease chain|did not consume|no LeaseGasPaid/;
/** verifyLeaseReceipt against ONE provider: its own answer or its own error */
async function perPeer(rpc, args) {
  return Promise.all(rpc.peers.map(async (p, i) => {
    const one = { ...rpc, peers: [p], agree: async (members, read) => ({ value: await read(members[0]), members }) };
    try { const v = await verifyLeaseReceipt({ ...args, rpc: one }); return { index: i, ok: true, key: `${v.blockHash}:${v.chargedWei}:${lc(v.payee)}`, v }; }
    catch (e) { return { index: i, ok: false, error: String(e?.shortMessage || e?.message || e).slice(0, 200) }; }
  }));
}

export async function auditChain({ clients, recordBytes, digest, expect, cutover, relayLog = [], allowLoopbackHttp = false, confirmations, chunk = 500n, timeoutMs = 60_000 }) {
  const deployment = parseDeploymentRecord(recordBytes, { expectedDigest: digest });
  if (!cutover || !Number.isSafeInteger(cutover.cutoverBlock) || cutover.cutoverBlock < 0 || !cutover.activatedAt || Number.isNaN(Date.parse(cutover.activatedAt)))
    throw new Error("the cutover marker is required: { cutoverBlock: <block number>, activatedAt: <ISO time 20-activate finished> }");
  const rpc = leaseRpcSet(clients, { quorum: expect.quorum, allowLoopbackHttp, timeoutMs });
  const { pins, block: head } = await verifiedLeaseAuthority({ clients, deployment, quorum: expect.quorum, allowLoopbackHttp, confirmations, timeoutMs });
  const from = BigInt(cutover.cutoverBlock);
  if (from > head.number) return { status: "NO_EVENTS_YET", reason: `the cutover block ${from} is beyond the agreed head ${head.number}`, events: [], absenceProven: false };
  const { value: cb } = await rpc.agree(rpc.peers, async (p) => { const b = await p.client.getBlock({ blockNumber: from }); return { hash: lc(b.hash), timestamp: b.timestamp }; }, "the cutover block");
  if (Number(cb.timestamp) * 1000 < Date.parse(cutover.activatedAt))
    throw new Error(`the cutover block ${from} (${new Date(Number(cb.timestamp) * 1000).toISOString()}) is BEFORE the activation (${cutover.activatedAt}): earlier payments by the same payee key would enter the window`);
  const apps = new Set(expect.apps.map(lc)), moved = lc(expect.relay.payee), fallback = lc(expect.fallbackPayee), operator = lc(expect.operator);
  const logIdx = relayLogIndex(relayLog);
  const discovery = [], logs = [];
  for (let s = from; s <= head.number; s += chunk) {
    const e = s + chunk - 1n < head.number ? s + chunk - 1n : head.number;
    const r = await Promise.allSettled(rpc.peers.map((p) => rpc.request(p.client, "eth_getLogs", [{ address: pins.reserve, fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) }])));
    discovery.push({ fromBlock: String(s), toBlock: String(e), providers: r.map((x, i) => ({ index: i, status: x.status, count: x.status === "fulfilled" ? x.value.length : undefined,
      error: x.status === "rejected" ? String(x.reason?.shortMessage || x.reason?.message || x.reason).slice(0, 160) : undefined })) });
    for (const x of r) if (x.status === "fulfilled") logs.push(...x.value);
  }
  // minipc's relay log names its own successful sends: their receipts are candidates too (the window is still enforced)
  const discoveredTx = new Set(logs.map((l) => lc(l.transactionHash)));
  const fromLog = [];
  for (const [hash, st] of logIdx) {
    if (st !== "success" || discoveredTx.has(hash)) continue;
    const got = await rpc.agree(rpc.peers, async (p) => { const rc = await p.client.getTransactionReceipt({ hash }); return { block: String(rc.blockNumber), logs: rc.logs.map((g) => ({ address: lc(g.address), topics: g.topics, data: g.data, logIndex: Number(g.logIndex), transactionHash: lc(g.transactionHash), blockNumber: String(g.blockNumber) })) }; }, "a relay-logged receipt").catch(() => null);
    if (!got) { fromLog.push({ hash, found: "receipt not agreed" }); continue; }
    if (BigInt(got.value.block) < from || BigInt(got.value.block) > head.number) { fromLog.push({ hash, found: `block ${got.value.block} outside the window` }); continue; }
    fromLog.push({ hash, found: "added" });
    logs.push(...got.value.logs.filter((g) => g.address === lc(pins.reserve)));
  }
  if (!discovery.every((d) => d.providers.some((p) => p.status === "fulfilled")) && !fromLog.length && !logs.length)
    throw new Error("no log discovery provider answered and minipc's relay log names no payment: nothing could be examined");
  const seen = new Set(), events = [], failures = [], unverified = [];
  for (const log of logs) {
    const k = lc(log.transactionHash) + ":" + Number(log.logIndex);
    if (seen.has(k)) continue; seen.add(k);
    let ev; try { ev = viem.decodeEventLog({ abi: RESERVE_ABI, topics: log.topics, data: log.data }); } catch { continue; }
    if (ev.eventName !== "LeaseGasPaid" || !apps.has(lc(ev.args.id))) continue;
    const base = { deployment: lc(ev.args.id), kind: Number(ev.args.kind), transactionHash: lc(log.transactionHash), payee: lc(ev.args.payee), operator: lc(ev.args.operator) };
    try {
      if (lc(ev.args.operator) !== operator) throw new Error(`operator ${ev.args.operator} is not minipc's ${expect.operator}`);
      const { value: tx } = await rpc.agree(rpc.peers, async (p) => { const t = await p.client.getTransaction({ hash: log.transactionHash }); return { from: lc(t.from), input: t.input }; }, "the lease transaction");
      const call = viem.decodeFunctionData({ abi: EXECUTOR_ABI, data: tx.input });
      if (call.functionName !== "lease") throw new Error("not a lease call");
      const want = call.args[0];
      if (lc(want.id) !== base.deployment || Number(want.kind) !== base.kind) throw new Error("the call is another lease than the event");
      if (tx.from !== base.payee) throw new Error(`sent by ${tx.from}, not by the payee relay key ${base.payee}`);
      if (base.payee !== moved && base.payee !== fallback) throw new Error(`payee ${base.payee} is neither the moved nor the fallback relay`);
      const args = { pins, operator: ev.args.operator, hash: log.transactionHash,
        want: { ...want, kind: Number(want.kind), nonce: BigInt(want.nonce), deadline: BigInt(want.deadline), maxChargeWei: BigInt(want.maxChargeWei) }, payees: [moved, fallback] };
      let v;
      try { v = await verifyLeaseReceipt({ ...args, rpc }); }
      catch (qe) {
        const peers = await perPeer(rpc, args);
        const groups = new Map(); for (const x of peers.filter((x) => x.ok)) groups.set(x.key, [...(groups.get(x.key) || []), x]);
        const agreed = [...groups.values()].find((g) => g.length >= rpc.required);
        if (agreed) v = agreed[0].v;
        else {
          const answered = peers.filter((x) => !x.ok && DEFINITE.test(x.error));
          const diag = peers.map((x) => ({ index: x.index, ok: x.ok, error: x.error }));
          if (!peers.some((x) => x.ok) && answered.length >= rpc.required && new Set(answered.map((x) => x.error)).size === 1)
            throw Object.assign(new Error(`every answering provider reports: ${answered[0].error}`), { diag });
          throw Object.assign(new Error(`proof not observed: ${String(qe.message).slice(0, 120)}`), { unverified: true, diag });
        }
      }
      if (!(v.chargedWei > 0n)) throw new Error("no app reserve charge");
      const e = { ...base, blockNumber: String(v.blockNumber), chargedWei: String(v.chargedWei), relay: base.payee === moved ? "moved" : "fallback" };
      if (e.relay === "moved") {
        e.minipcRelayLog = logIdx.get(base.transactionHash) || "absent";
        if (e.minipcRelayLog !== "success") throw Object.assign(new Error(`moved-payee payment ${base.transactionHash} is not a "[relay] success" line in minipc's relay log: it was not routed through minipc's relay`), { event: e });
      }
      events.push(e);
    } catch (err) {
      const rec = { ...base, ...(err.event || {}), error: String(err.message).slice(0, 300), ...(err.diag ? { providers: err.diag } : {}) };
      if (err.unverified) { rec.minipcRelayLog = logIdx.get(base.transactionHash) || "absent"; unverified.push(rec); } else failures.push(rec);
    }
  }
  const movedOk = events.filter((e) => e.relay === "moved"), fb = events.filter((e) => e.relay === "fallback");
  const status = failures.length ? "FAILED" : movedOk.length ? (unverified.length ? "PARTIAL" : "LOCAL_VERIFIED") : unverified.length ? "UNVERIFIED_ONLY" : fb.length ? "FALLBACK_ONLY" : "NO_EVENTS_YET";
  const perApp = [...apps].map((id) => ({ id, moved: movedOk.filter((e) => e.deployment === id).map((e) => e.kind), fallback: fb.filter((e) => e.deployment === id).map((e) => e.kind) }));
  return { status, absenceProven: false, discoveryIsUntrusted: true, quorum: rpc.required, reserve: pins.reserve,
    window: { fromBlock: String(from), fromBlockHash: cb.hash, fromBlockTime: new Date(Number(cb.timestamp) * 1000).toISOString(), toBlock: String(head.number), toBlockHash: head.hash, activatedAt: cutover.activatedAt },
    counts: { moved: movedOk.length, fallback: fb.length, unverified: unverified.length, failed: failures.length }, perApp, events, unverified, failures, discovery, relayLogCandidates: fromLog };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), opt = {}; for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, "")] = a[i + 1];
  const expect = JSON.parse(fs.readFileSync(opt.expectations || path.join(HERE, "expectations.json"), "utf8"));
  if (!opt.cutover) { console.error("refused: --cutover cutover.json is required (root writes it after 20-activate.ps1 exits 0)"); process.exit(2); }
  const cutover = JSON.parse(fs.readFileSync(opt.cutover, "utf8"));
  const minipc = opt.minipc ? JSON.parse(fs.readFileSync(opt.minipc, "utf8")) : null;
  if (!minipc) { console.error("refused: --minipc minipc.json is required (the relay log is the local-routing proof)"); process.exit(2); }
  const recordBytes = fs.readFileSync(path.join(HERE, "deployment.json"));
  if (createHash("sha256").update(recordBytes).digest("hex") !== expect.deploymentRecordSha256) throw new Error("the reviewed deployment record changed");
  const clients = expect.rpcs.map((url) => viem.createPublicClient({ transport: viem.http(url, { retryCount: 0, timeout: 60_000 }) }));
  const code = auditCodeHashes(), tested = expect.auditCode || {};
  const drift = Object.keys(code).filter((f) => tested[f] && tested[f] !== code[f]);
  if (drift.length && opt["accept-code-drift"] !== "yes") { console.error(`refused: main's ${drift.join(", ")} differ from the tested audit code (expectations.auditCode); review, then pass --accept-code-drift yes`); process.exit(2); }
  const r = await auditChain({ clients, recordBytes, digest: "sha256:" + expect.deploymentRecordSha256, expect, cutover, relayLog: minipc.relayLog || [] });
  const text = JSON.stringify({ at: new Date().toISOString(), auditCode: code, auditCodeDrift: drift, ...r }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n";
  if (opt.out) fs.writeFileSync(opt.out, text, { flag: "wx" });
  console.log(text);
  process.exitCode = r.status === "FAILED" ? 1 : r.status === "LOCAL_VERIFIED" ? 0 : 3;
}
