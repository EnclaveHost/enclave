// A deployment may be CREATED with no money on it. The store's quick-deploy
// modal used to pin its Deploy button off under one cent, and the shared
// on-chain flow paid unconditionally - so a $0 wallet deploy minted the record
// and then died in payForRuntime's "Fund at least $0.01" with a retry offer
// for nothing. Two things hold the new shape together, both source checks
// (the modal needs a DOM this suite doesn't have): the modal's floor comes
// from the account kind (wallet: 0, credit: a cent - the relay refuses a
// credit order that buys no runtime), and the shared flow skips the funding
// step at $0 instead of throwing on it. (The deploy console that once carried
// the same floor in its budget field is gone - the modal is the only entry.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

test("the quick-deploy modal's floor is 0 for a wallet deploy and a cent for credit", () => {
  const src = read("site/js/pages/apps.js");
  const modal = src.slice(src.indexOf("function quickDeploy("), src.indexOf("async function validateWasm("));
  assert.match(modal, /const minUsd = acct \? 0\.01 : 0;/, "the floor follows the account kind");
  assert.match(modal, /min="' \+ minUsd \+ '"/, "the amount input's min attribute IS that floor");
  assert.doesNotMatch(modal, /usd >= 0\.01/, "no hard-coded cent floor survives in the modal");
  // a typed 0 is the decision; a blank box deploys nothing
  assert.match(modal, /const zero = !acct && Number\.isFinite\(raw\) && !\(raw > 0\);/);
  assert.match(modal, /ok: usd > 0 \? usd >= minUsd : zero/);
  assert.match(modal, /const \{ usd, ok \} = amountOf\(\); if \(!ok\) return;/, "the click handler gates on the same rule the button state does");
});

test("the shared on-chain flow skips funding at $0 and only watches a claim when a free box exists", () => {
  const src = read("site/js/pages/deploy.js");
  const flow = src.slice(src.indexOf("export async function deployOnChain("), src.indexOf("function offerRetry("));
  const skip = flow.indexOf("if (!(fund > 0)){\n      w.line(\"ok\", \"[✓] created unfunded");
  const pay = flow.indexOf("await payForRuntime({");
  assert.ok(skip !== -1 && pay !== -1 && skip < pay, "the $0 branch sits in front of the funding call");
  assert.match(flow, /if \(!freeBoxes\.length\)\{[\s\S]{0,400}?return;\s*\}\s*w\.line\("dimln", "    " \+ freeNames \+ " hosts it for nothing/,
    "without a free box there is no claim to wait for; with one, the watch runs");
  // the funding-failure branch (and its retry offer) is untouched for real amounts
  assert.match(flow, /w\.line\("warn", rejected \? "\[x\] funding rejected in wallet\."[\s\S]{0,400}?offerRetry\(w, id, fund, asset\)/);
  // credit deploys still need a budget: the vault funds inside the create op
  assert.match(flow, /if \(!\(fund > 0\)\)\{ w\.line\("warn", "\[!\] credit deploys need a budget/);
});
