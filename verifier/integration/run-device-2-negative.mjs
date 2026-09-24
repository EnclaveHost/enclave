#!/usr/bin/env node
// verifier/integration/run-device-2-negative.mjs: the NEGATIVE CONTROL for the repeat device run (run 2, owner's ae209496,
// fixture pvm-client-activation-device-2): the original carrier-side copy assertion, the very code the run-3 acceptance
// passes (test/helpers/pvm-device-state-copy.mjs), is run against run 2 and MUST FAIL with its exact reason, because run
// 2's copies are null (finding F3, closed by run 3). Invoked separately from the strict acceptance command, which itself
// has no expected failure: a failing test there is a failure. Exit 0 only when the assertion fails on run 2 exactly as
// recorded (the historical failure reproduces); 1 if it passes (the record would be wrong) or fails otherwise.
import path from "node:path";
import { assertCarrierCopyEqualsLog } from "../../test/helpers/pvm-device-state-copy.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const F = path.join(REPO, "test", "fixtures", "verifier", "pvm-client-activation-device-2");
try { assertCarrierCopyEqualsLog(F); }
catch (e) {
  const expectedMessage = /^base-stream: exchanges\.jsonl 'after' is MISSING or wrong \(carrier-side copy\)/;
  const nullCopy = e.actual && typeof e.actual === "object" && ["gen", "serial", "policyFp", "nextPolicyFp", "releaseFp", "active"].every((k) => e.actual[k] === null);
  if (e.code === "ERR_ASSERTION" && expectedMessage.test(e.message) && nullCopy) { console.log(`device-2 negative control: the original assertion FAILS on run 2 exactly as recorded (${e.message.split("\n")[0]}; the copy is all null): the historical failure reproduces, never accepted`); process.exit(0); }
  console.error(`device-2 negative control: the assertion failed, but NOT as recorded: ${e.message.split("\n").slice(0, 3).join(" | ")}`); process.exit(1);
}
console.error("device-2 negative control: the original assertion PASSED on run 2: the historical failure record is wrong"); process.exit(1);
