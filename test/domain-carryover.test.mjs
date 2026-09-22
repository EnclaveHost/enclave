// A custom hostname's per-name state belongs to whoever owns the hostname NOW (supervisor.js).
//
// This box keeps two maps keyed by hostname alone - the ACME backoff and the report queued for the
// customer - while the thing they are really about is a (deployment, hostname) pair. A customer can
// detach a domain from one deployment and attach it to another at any moment, and both maps used to
// follow the NAME rather than the owner. That gave two defects at once:
//
//   - the previous owner's backoff suppressed the new owner's first attempt ever, for up to the
//     one-hour rate-limit cap, with the escalating failure count carried over on top; and
//   - the previous owner's ACME error - which names their zone and their DNS - was delivered to
//     the new owner's console as a report about THEIR domain.
//
// The supervisor is a monolith that exports nothing, so this drives its DOMAIN_CARRYOVER_SELFTEST
// seam as a child process, the same contract as the ACME_SELFTEST seams. The seam calls the
// production helpers and the production index; it does not restate the ownership rule.
//
//   run: node --test test/domain-carryover.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One seam run. `file` lets a mutant copy be driven by the very same test. */
async function carryover(file = path.join(HERE, "..", "supervisor.js"), mode = "1") {
  const { stdout } = await run(process.execPath, [file], { timeout: 120_000, maxBuffer: 8 << 20,
    env: { ...process.env, SECRET: "test-secret", DOMAIN_CARRYOVER_SELFTEST: mode,
           REACH_SELFTEST: "", ACME_SELFTEST: "", SWEEP_SELFTEST: "", LEDGER_MOVE_SELFTEST: "",
           ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/** The contract, as assertions. Named so the mutant check can demand these EXACT ones fail. */
function scoped({ owner, asA, asB }) {
  assert.equal(owner, "0x" + "bb".repeat(32), "after the move the name resolves to B");
  // The fix must SCOPE the state, not throw it away: a box that forgot every backoff would hammer
  // the CA into a real rate limit.
  assert.equal(asA.blocked, true, "A stays in the backoff it earned");
  assert.equal(asA.failures, 6, "and keeps its escalating failure count");
  assert.deepEqual(asA.report.map((x) => x.hostname), ["shop.example.com"],
    "and still has its own report to deliver");
  assert.equal(asB.blocked, false,
    "B's first attempt ever must reach the CA, not wait out the previous owner's hour");
  assert.equal(asB.failures, 0, "and must start at zero rather than continue A's escalation");
  assert.deepEqual(asB.report, [],
    "and B's customer must never be shown A's CA error about A's zone");
}

test("a name that moves carries neither the backoff nor the report, and the old owner keeps both", async () => {
  scoped(await carryover());
});

// What makes the assertions above worth anything: MUTANT_SUPERVISOR points at a copy with the two
// ownership checks removed, and THE SAME assertions must then fail. Opt-in, so the ordinary run
// stays fast and so no defect is ever injected into the checkout.
test("those assertions depend on the ownership checks", { skip: !process.env.MUTANT_SUPERVISOR }, async () => {
  const r = await carryover(process.env.MUTANT_SUPERVISOR);
  assert.throws(() => scoped(r), assert.AssertionError,
    "with the owner checks removed the new owner visibly inherits the old one's state");
});

// ---- the pump itself, across a move that happens DURING the order ----------------------------
//
// Scoping the READS was not enough, and an audit replaying this exact body proved it: the writes
// resolved the owner AFTER `await acmeIssue`, so a late result of A's order was filed against
// whoever held the name by then - B got A's DNS error as a report about their own domain, and A's
// backoff landed on B's name. The seam stands in for the CA only; the queue, the pump body, the
// index and the retry plan are production.

/** The contract, again as assertions, so the mutant check can demand these exact ones fail. */
function pumpScoped(o) {
  const B = "0x" + "bb".repeat(32), A = "0x" + "aa".repeat(32);

  assert.equal(o.lateFailureAfterMove.owner, B, "the name really did move to B mid-order");
  assert.equal(o.lateFailureAfterMove.report, null,
    "A's CA error must not be filed as a report at all once the name is B's");
  assert.equal(o.lateFailureAfterMove.retry, null,
    "and A's backoff must not land on the name B now holds");

  assert.equal(o.lateSuccessAfterMove.certKept, true,
    "the certificate is still kept: dns-01 proves control of the NAME, so it is good for B too");
  assert.equal(o.lateSuccessAfterMove.report, null,
    "but a success report for an order B never placed is not B's news");

  assert.equal(o.lateFailureAfterABA.owner, A, "A holds the name again at the end");
  assert.equal(o.lateFailureAfterABA.report, null,
    "A -> B -> A is still a move: comparing the owner alone would call this result current");
  assert.equal(o.lateFailureAfterABA.retry, null, "so neither is the backoff");

  assert.equal(o.lateFailureAfterDetach.report, null, "a detached name files nothing");
  assert.equal(o.lateFailureAfterDetach.retry, null);

  // The controls. The fix must not stop an owner who kept the name from getting their own answer.
  assert.equal(o.lateFailureNoMove.report.owner, A, "nothing moved, so A gets its report");
  assert.match(o.lateFailureNoMove.report.error, /dns-01/, "with the CA's reason in it");
  assert.equal(o.lateFailureNoMove.retry.owner, A, "and its backoff");
  assert.equal(o.lateFailureNoMove.retry.failures, 1);
  assert.equal(o.lateSuccessNoMove.report.ok, true, "and a success is still reported");
  assert.equal(o.lateSuccessNoMove.certKept, true);
}

test("a result that lands after the name moved is filed against nobody", { timeout: 180_000 }, async () => {
  pumpScoped(await carryover(undefined, "pump"));
});

test("those assertions depend on capturing the owner BEFORE the await", { skip: !process.env.MUTANT_SUPERVISOR, timeout: 180_000 }, async () => {
  const o = await carryover(process.env.MUTANT_SUPERVISOR, "pump");
  assert.throws(() => pumpScoped(o), assert.AssertionError,
    "reading the owner after the await files A's result against B, which these assertions must catch");
});
