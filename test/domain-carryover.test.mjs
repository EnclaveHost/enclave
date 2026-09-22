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
async function carryover(file = path.join(HERE, "..", "supervisor.js")) {
  const { stdout } = await run(process.execPath, [file], { timeout: 60_000, maxBuffer: 8 << 20,
    env: { ...process.env, SECRET: "test-secret", DOMAIN_CARRYOVER_SELFTEST: "1",
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
