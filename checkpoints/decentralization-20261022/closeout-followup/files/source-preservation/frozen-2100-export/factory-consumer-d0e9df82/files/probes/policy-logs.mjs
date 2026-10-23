// READ-ONLY, bounded, resumable discovery of PolicyUpdated/PolicyClaimed on the original v1 and v2 vaults, from their
// pinned deployment blocks (contracts/deployments/secret-vault-base.json 52605914, secret-vault-v2-base.json 52613511)
// to the state-impact block. At most 20 requests per attempt and 2 attempts in total (persisted). One filter with both
// addresses and both exact topics; a RANGE refusal halves the span; a RATE refusal stops the attempt (no retry storm).
// Ids found that the state probe did not cover are re-read as state (agreed, pinned block) within the same budget.
//   node probes/policy-logs.mjs   -> evidence/log-cursor.json (resumable), evidence/policy-logs.json
import fs from "node:fs";
import { budgetedRpc, discoverLogs, uncovered, readAgreed, LIVE, EVENTS, ABI, CHAIN_ID, BudgetExhausted } from "../lib/review.mjs";

const V1 = "0x08074300f75e78212ae10ebd14984f78e17811a6", V2 = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const START = "52605914";                     // the earlier (v1) deployment block; v2 deployed at 52613511
const MAX = 20, ATTEMPTS = 2, CONFIRM_RESERVE = 2, INITIAL_SPAN = "100000";
const ev = (f) => new URL(`../evidence/${f}`, import.meta.url);
const state = JSON.parse(fs.readFileSync(ev("state-impact.json"), "utf8"));
if (!state.complete) throw new Error("run the state probe first");
const block = { number: BigInt(state.block.number), hash: state.block.hash };
let cursor = fs.existsSync(ev("log-cursor.json")) ? JSON.parse(fs.readFileSync(ev("log-cursor.json"), "utf8"))
  : { provider: LIVE.logs[0], addresses: [V1, V2], topics: [EVENTS.PolicyUpdated, EVENTS.PolicyClaimed], start: START, next: START, to: state.block.number,
      span: INITIAL_SPAN, covered: [], events: [], stops: [], attempts: [] };
if (cursor.attempts.length >= ATTEMPTS) { console.log(JSON.stringify({ refused: `the ${ATTEMPTS}-attempt limit is used up`, uncovered: uncovered(cursor, cursor.start) })); process.exit(2); }
// resume at the provider's own stated limit when an earlier attempt recorded one (not a guess, its message)
const statedLimits = cursor.stops.map((x) => /limited to (\d+) block range/i.exec(x.message || "")?.[1]).filter(Boolean).map(BigInt);
if (statedLimits.length) { const lim = statedLimits.reduce((a, x) => (x < a ? x : a)); if (lim > BigInt(cursor.span)) cursor.span = lim.toString(); }
const b = budgetedRpc({ max: MAX });
const attempt = { n: cursor.attempts.length + 1, at: new Date().toISOString(), budget: MAX };
let outcome, r = null;
try {
  if (Number(await b.rpc(cursor.provider, "eth_chainId", [])) !== CHAIN_ID) throw new Error("the log provider is not Base");
  r = budgetedRpc({ max: MAX - b.used() - CONFIRM_RESERVE });          // discovery's share of this attempt's budget
  outcome = await discoverLogs({ rpc: r.rpc, url: cursor.provider, addresses: cursor.addresses, topics: cursor.topics, cursor,
    onStep: (c) => fs.writeFileSync(ev("log-cursor.json"), JSON.stringify(c, null, 1) + "\n") });
  // state-confirm ids the state probe did not already read (agreed, at the pinned block)
  const known = new Set(state.rows.map((x) => x.id));
  const fresh = [...new Set(cursor.events.map((e) => e.id))].filter((id) => !known.has(id));
  attempt.idsOutsideCurrentLedger = fresh;
  if (fresh.length) {
    const calls = fresh.flatMap((id) => [{ address: V1, abi: ABI.vault, functionName: "policyOf", args: [id] }, { address: V2, abi: ABI.vault, functionName: "policyOf", args: [id] },
                                         { address: V2, abi: ABI.vault, functionName: "beneficialOwnerOf", args: [id] }]);
    const res = await readAgreed(b.rpc, block, calls);
    attempt.confirmed = fresh.map((id, i) => ({ id, v1: res[3 * i].ok ? { owner: res[3 * i].value[0], policyRev: res[3 * i].value[1].toString() } : null,
      v2: res[3 * i + 1].ok ? { owner: res[3 * i + 1].value[0], policyRev: res[3 * i + 1].value[1].toString() } : null,
      beneficialOwnerNow: res[3 * i + 2].ok ? res[3 * i + 2].value : null }));
  }
} catch (e) {
  outcome = e instanceof BudgetExhausted ? "budget" : "error"; attempt.error = String(e.message).slice(0, 300);
} finally {
  attempt.outcome = outcome; attempt.discoveryRequests = r ? r.used() : 0; attempt.totalRequests = b.used() + attempt.discoveryRequests;
  attempt.requests = [...b.log, ...(r ? r.log : [])];
  cursor.attempts.push(attempt);
  fs.writeFileSync(ev("log-cursor.json"), JSON.stringify(cursor, null, 1) + "\n");
  const gaps = uncovered(cursor, cursor.start);
  const ids = [...new Set(cursor.events.map((e) => e.id))];
  fs.writeFileSync(ev("policy-logs.json"), JSON.stringify({ at: new Date().toISOString(), readOnly: true, provider: new URL(cursor.provider).host,
    addresses: cursor.addresses, topics: cursor.topics, range: [cursor.start, cursor.to], complete: gaps.length === 0, covered: cursor.covered, uncovered: gaps,
    events: cursor.events, ids, attempts: cursor.attempts.map(({ requests, ...a }) => ({ ...a, requests: requests?.length })),
    note: gaps.length ? "PARTIAL: events outside `covered` were not observed; no completeness is claimed for them" : "every block of the range answered by this ONE provider (no second log source agreed)" }, null, 1) + "\n");
  console.log(JSON.stringify({ attempt: attempt.n, outcome, requests: attempt.totalRequests, span: cursor.span, covered: cursor.covered, uncovered: gaps, events: cursor.events.length, ids, stops: cursor.stops.slice(-3) }, null, 1));
  if (gaps.length) process.exitCode = 3;
}
