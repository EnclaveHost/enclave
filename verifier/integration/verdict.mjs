// verifier/integration/verdict.mjs: the strict command's VERDICT, as a pure function over the test run's TAP output, exit
// status and signal, so it can be tested on real TAP for every path. Fail closed:
//   - a spawn error, a signal death, a report without a plan or without every summary count, counts that do not add
//     up, or entries that do not match the counts: FAILED (malformed, truncated or inconsistent report);
//   - every `not ok` entry at ANY level (a case, a file that crashed or failed to load, a file-level timeout) counts: it
//     is either exactly accounted for by an OPEN finding recorded against the pinned revision it was found on (a
//     case-level `testCodeFailure` whose name the finding lists; never a file or a path), or it is a failure;
//   - cancelled, skipped and todo entries are failures (a todo is an exemption; a skip hides a case; a cancellation is
//     a hang), each named;
//   - the child's exit status must agree with the report: non-zero only when accounted failures exist, zero never with
//     failures;
//   - accounted failures give NOT ACCEPTED (exit 3), a distinct verdict that is never a pass; only a clean, complete,
//     consistent run with exit 0 and nothing accounted is PASS (exit 0). Nothing disappears by name.
const ENTRY = /^(\s*)(not ok|ok) (\d+)(?: - (.*?))?(?: # (SKIP|TODO)(?: (.*))?)?\s*$/;
const COUNTS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

/** Parse the TAP text into entries (with their failureType diagnostics), the top-level plan and the summary counts. */
export function parseTap(out) {
  const entries = [], counts = {}; let plan = null, last = null;
  for (const line of String(out).split("\n")) {
    const m = ENTRY.exec(line);
    if (m) { last = { indent: m[1].length, ok: m[2] === "ok", num: Number(m[3]), name: m[4] ?? "", directive: m[5] || null, failureType: null }; entries.push(last); continue; }
    const p = /^1\.\.(\d+)\s*$/.exec(line); if (p) { plan = Number(p[1]); last = null; continue; }
    const c = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line); if (c) { counts[c[1]] = Number(c[2]); last = null; continue; }
    const f = /^\s+failureType: '([^']+)'\s*$/.exec(line); if (f && last) { last.failureType = f[1]; continue; }
    if (/^\S/.test(line) && !/^#/.test(line)) last = null;   // any other top-level line ends the diagnostics of the last entry
  }
  return { entries, plan, counts, complete: plan !== null && COUNTS.every((k) => Number.isInteger(counts[k])) };
}

const pathLike = (name) => /\.(m?js|cjs|ts)$/.test(name) || name.includes("/") || name.includes("\\");

/**
 * classify({ out, status, signal, error }, { findings, pinCommit })
 *   findings: verifier/integration/findings.json; pinCommit(pinName) -> the commit that pin currently records (or null)
 *   -> { verdict: "PASS" | "NOT ACCEPTED" | "FAILED", exit: 0 | 3 | 1, reasons: [], accounted: [{ name, finding }], lines: [] }
 */
export function classify({ out, status, signal = null, error = null }, { findings = {}, pinCommit = () => null } = {}) {
  const reasons = [], lines = [], accounted = [];
  const failed = (m) => reasons.push(m);
  if (error) failed(`the test run could not be started: ${error.message || error}`);
  if (signal) failed(`the test run was terminated by signal ${signal}`);
  const tap = parseTap(out);
  if (!tap.complete) failed(`malformed or truncated report: ${tap.plan === null ? "no plan line" : "plan present"}; counts present: ${COUNTS.filter((k) => Number.isInteger(tap.counts[k])).join(",") || "none"}`);
  const c = tap.counts, E = tap.entries;
  if (tap.complete) {
    if (c.tests !== c.pass + c.fail + c.cancelled + c.skipped + c.todo) failed(`counts do not add up: tests ${c.tests} != pass ${c.pass} + fail ${c.fail} + cancelled ${c.cancelled} + skipped ${c.skipped} + todo ${c.todo}`);
    if (c.suites !== 0) failed(`the acceptance suites are flat; the report says suites ${c.suites}`);
    const top = E.filter((e) => e.indent === 0);
    if (top.length !== tap.plan) failed(`the plan says ${tap.plan} top-level entries, the report has ${top.length}`);
    top.forEach((e, i) => { if (e.num !== i + 1) failed(`top-level entry ${e.num} out of sequence (expected ${i + 1}): ${e.name}`); });
    if (E.length !== c.tests) failed(`the report has ${E.length} entries, the counts say tests ${c.tests}`);
  }
  // findings that may account for a failure: open, recorded against exactly the pinned revision, naming cases (never paths)
  const applicable = Object.entries(findings).filter(([, f]) => f.status === "open" && pinCommit(f.pin) === f.knownOn);
  for (const [id, f] of applicable) for (const n of f.cases || []) if (pathLike(n)) failed(`finding ${id} names a file or path as a case (${n}): refused, a finding accounts for exact case-level failures only`);
  const okEntries = E.filter((e) => e.ok), notOk = E.filter((e) => !e.ok);
  for (const e of E) {
    if (e.directive === "TODO") { failed(`todo entry (an exemption, none allowed): ${e.name}`); continue; }
    if (e.directive === "SKIP") { failed(`skipped entry (a skip is a failure here): ${e.name}`); continue; }
    if (e.ok) continue;
    if (e.failureType === "cancelledByParent" || e.failureType === "testTimeoutFailure") { failed(`cancelled or timed out (${e.failureType}): ${e.name}`); continue; }
    if (e.indent !== 0 && e.failureType === "subtestsFailed") { failed(`a parent entry failed through its subtests: ${e.name}`); continue; }
    const hit = e.failureType === "testCodeFailure" && !pathLike(e.name) ? applicable.find(([, f]) => (f.cases || []).includes(e.name)) : null;
    if (hit) accounted.push({ name: e.name, finding: hit[0] }); else failed(`unaccounted failing entry (${e.failureType || "no failureType"}): ${e.name}`);
  }
  if (tap.complete) {
    const failEntries = notOk.filter((e) => e.directive !== "TODO" && e.failureType !== "cancelledByParent"), cancelledEntries = notOk.filter((e) => e.failureType === "cancelledByParent");
    if (c.fail !== failEntries.length) failed(`count mismatch: the report says fail ${c.fail}, it lists ${failEntries.length} failing entries`);
    if (c.cancelled !== cancelledEntries.length) failed(`count mismatch: the report says cancelled ${c.cancelled}, it lists ${cancelledEntries.length}`);
    if (c.todo !== E.filter((e) => e.directive === "TODO").length) failed(`count mismatch: todo ${c.todo} vs ${E.filter((e) => e.directive === "TODO").length} entries`);
    if (c.skipped !== okEntries.filter((e) => e.directive === "SKIP").length) failed(`count mismatch: skipped ${c.skipped} vs ${okEntries.filter((e) => e.directive === "SKIP").length} entries`);
    if (c.pass !== okEntries.filter((e) => !e.directive).length) failed(`count mismatch: pass ${c.pass} vs ${okEntries.filter((e) => !e.directive).length} passing entries`);
  }
  const anyFailureRecorded = notOk.length > 0;
  if (!signal && !error) {
    if (status !== 0 && !anyFailureRecorded) failed(`the test run exited ${status} with no failing entry in its report`);
    if (status === 0 && notOk.some((e) => e.directive !== "TODO")) failed(`the test run exited 0 although its report lists failing entries`);
    if (status !== 0 && reasons.length === 0 && accounted.length === 0) failed(`the test run exited ${status}`);
  }
  // an open applicable finding whose cases all pass is a wrong record: never a pass
  let wrongRecord = 0;
  for (const [id, f] of applicable) { const still = (f.cases || []).filter((n) => accounted.some((a) => a.name === n)); if (!still.length) { wrongRecord++; lines.push(`finding ${id} is recorded open against ${String(f.knownOn).slice(0, 12)} but its cases pass there: correct or close the entry`); } }
  for (const [id, f] of Object.entries(findings)) if (f.status === "open" && pinCommit(f.pin) !== f.knownOn) lines.push(`finding ${id} is recorded against ${String(f.knownOn).slice(0, 12)}, no longer pinned as ${f.pin}: its cases are required with no exemption`);
  if (reasons.length) return { verdict: "FAILED", exit: 1, reasons, accounted, lines };
  if (accounted.length || wrongRecord) { for (const a of accounted) lines.push(`open finding ${a.finding} still reproduces: ${a.name}`); return { verdict: "NOT ACCEPTED", exit: 3, reasons: [`${accounted.length} accounted failure(s) of ${new Set(accounted.map((a) => a.finding)).size + wrongRecord} open finding(s); not a clean pass`], accounted, lines }; }
  return { verdict: "PASS", exit: 0, reasons: [], accounted, lines };
}
