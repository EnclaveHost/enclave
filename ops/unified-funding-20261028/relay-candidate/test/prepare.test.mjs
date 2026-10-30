// OFFLINE, static (relay-r1): proves the patched host copy is insert-only over the pinned original. Run
// `python3 prepare.py` first; these tests FAIL (they do not skip) when its outputs are missing.
// The patched sessions.mjs is NOT executed here (it imports bare "viem" and ./snp-verify.mjs, which exist only in
// source/relay/); its runtime wiring is therefore unproven by these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PIN = "457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d";
const SRC = here("../../../../relay/sessions.mjs");
const PATCHED = here("../patched/relay/sessions.mjs");
const OPEN = "// >>> funding-r1", CLOSE = "// <<< funding-r1";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const need = (p) => { assert.ok(existsSync(p), `${p} is missing: run python3 prepare.py`); return readFileSync(p, "utf8"); };

function split(text) {
  const kept = [], blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.includes(OPEN)) { assert.equal(cur, null, "nested funding-r1 block"); cur = [line]; continue; }
    if (line.includes(CLOSE)) { assert.notEqual(cur, null, "unopened funding-r1 block"); cur.push(line); blocks.push(cur.join("\n")); cur = null; continue; }
    if (cur) cur.push(line); else kept.push(line);
  }
  assert.equal(cur, null, "unterminated funding-r1 block");
  return { kept: kept.join("\n"), blocks };
}

test("static: source/relay/sessions.mjs is the pinned original", () => {
  assert.equal(sha(readFileSync(SRC)), PIN);
});

test("static: removing every marked block reproduces the original byte for byte (old routes unchanged)", () => {
  const { kept, blocks } = split(need(PATCHED));
  assert.equal(kept, readFileSync(SRC, "utf8"));
  assert.equal(blocks.length, 5);
});

test("static: the hunks route only /funding*, keep open disabled, and add no key/wallet/queue", () => {
  const { blocks } = split(need(PATCHED));
  const all = blocks.join("\n");
  assert.ok(all.includes('if (path === "/funding" || path.startsWith("/funding/")) return funding.route(method, path, body, ctx);'));
  assert.ok(all.includes("ownerManagement: false"));
  assert.ok(all.includes("simulateAndSend: (req) => simulateAndSend(req)"));
  for (const re of [/new\s+TxQueue/, /createWalletClient/, /privateKeyToAccount/, /body\./, /ownerManagement:\s*true/, /sendTransaction/]) {
    assert.doesNotMatch(all, re);
  }
  const src = readFileSync(SRC, "utf8");
  assert.doesNotMatch(src, /["'`]\/funding/);       // no original endpoint is shadowed by the new prefix
});

test("static: the drop-in funding-route copy differs from the stage file only by its two imports", () => {
  const stage = readFileSync(here("../funding-route.mjs"), "utf8");
  const copy = need(here("../patched/relay/funding-route.mjs"));
  const expect = stage.replace('from "../../source/node_modules/viem/_esm/index.js";', 'from "viem";')
    .replace('from "./generated/funding-abi.mjs";', 'from "./funding-abi.mjs";');
  assert.equal(copy, expect);
  assert.equal(need(here("../patched/relay/funding-abi.mjs")), need(here("../generated/funding-abi.mjs")));
});

test("static: the generated ABI carries the artifact Grant tuple with all three gas limits", async () => {
  const { fundingSessionVaultFactoryAbi, fundingSessionVaultAbi } = await import("../generated/funding-abi.mjs");
  const openFor = fundingSessionVaultFactoryAbi.find((x) => x.type === "function" && x.name === "openFor");
  const names = openFor.inputs[1].components.map((c) => c.name);
  for (const k of ["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]) assert.ok(names.includes(k));
  assert.ok(fundingSessionVaultAbi.some((x) => x.type === "event" && x.name === "GasFunded"));
  const m = JSON.parse(need(here("../generated/PREPARE-MANIFEST.json")));
  assert.equal(m.source["relay/sessions.mjs"], PIN);
  assert.equal(m.outputs["patched/relay/sessions.mjs"], sha(readFileSync(PATCHED)));
});
