// ONE report format and tier for every Windows launcher (enclave-99's contract and verifier/envelope.mjs:
// "hyperv-partition-domain/v1", "T0-hv"). wmiserve.rs carried its own "hyperv-vbs-partition-v1" until the first
// serving acceptance on nucbox-k11 (run 081904), where the manager's judge refused every report as "report format/tier".
// The JS fake of wmiserve used the judge's name, so no JS test could see it. This reads the Rust source instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "../host/src");
const judge = fs.readFileSync(path.join(HERE, "judge-hv.mjs"), "utf8");
const jsFormat = judge.match(/export const FORMAT = "([^"]+)";/)[1];
const jsTier = judge.match(/export const TIER = "([^"]+)";/)[1];

test("contract.rs's FORMAT_HYPERV and TIER_HYPERV are judge-hv's FORMAT and TIER", () => {
  const c = fs.readFileSync(path.join(SRC, "contract.rs"), "utf8");
  assert.equal(c.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1], jsFormat);
  assert.equal(c.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1], jsTier);
  assert.equal(jsFormat, "hyperv-partition-domain/v1", "the contract's registered name");
});

test("no other Rust file defines its own format or tier, or signs with another hyperv-* name", () => {
  for (const file of fs.readdirSync(SRC).filter((n) => n.endsWith(".rs") && n !== "contract.rs")) {
    const s = fs.readFileSync(path.join(SRC, file), "utf8").replace(/\/\/.*$/gm, "");   // code, not comments
    const own = [...s.matchAll(/const\s+(FORMAT|TIER)\w*\s*:\s*&str\s*=\s*"([^"]+)"/g)].map((m) => m[0]);
    assert.deepEqual(own, [], `${file} defines its own; use crate::report::{FORMAT, TIER}`);
    const names = [...s.matchAll(/"(hyperv-[a-z0-9/.-]+)"/g)].map((m) => m[1]).filter((n) => /v\d+$/.test(n) && n !== jsFormat);
    assert.deepEqual(names, [], `${file} names another report format`);
  }
});
