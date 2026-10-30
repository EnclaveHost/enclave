// STATIC proof of the PATCHED COPY written by prepare.py (run `python3 prepare.py` first). The patched sessions.mjs is
// never executed here; these tests only read text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(STAGE, "..", "..", "source", "relay", "sessions.mjs");
const PIN = "457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const src = readFileSync(SOURCE, "utf8");
const patched = readFileSync(join(STAGE, "patched", "relay", "sessions.mjs"), "utf8");
const BLOCK = /^[ \t]*\/\/ >>> funding-r2[^\n]*\n(?:(?![ \t]*\/\/ >>> )[^\n]*\n)*?[ \t]*\/\/ <<< funding-r2\n/gm;
const blocks = patched.match(BLOCK) ?? [];

test("the source is the pinned original and is not modified", () => {
  assert.equal(sha(readFileSync(SOURCE)), PIN);
  assert.ok(!src.includes("funding-r2"));
});

test("removing every marked block reproduces the original byte for byte", () => {
  const stripped = patched.replace(BLOCK, "");
  assert.equal(sha(Buffer.from(stripped)), PIN);
  assert.equal(stripped, src);
  assert.equal(blocks.length, 5, "header + import + construction + route dispatch + init");
});

test("the host hook wires the ACTUAL host helpers and nothing new", () => {
  const all = blocks.join("");
  for (const need of [
    "ownerManagement: true, rateOwner: (owner, op, commit) => rateOwner(owner, op, commit),",
    "simulateAndSend: (req) => simulateAndSend(req) });",
    "pc, relayer: account.address, store, log, now,",
    'if (path === "/funding" || path.startsWith("/funding/")) return funding.route(method, path, body, ctx);',
    "funding: fundingManifestFromEnv(process.env),",
  ]) assert.equal(all.split(need).length - 1, 1, need);
  for (const banned of ["privateKey", "TxQueue", "wc", "getTransactionCount", "nonce", "quotePolicy: {", "fundingQuotePolicy:", "/owner\"", "/end\""]) {
    assert.ok(!all.includes(banned), `a marked block mentions ${banned}`);
  }
});

test("the helpers the hook calls are real host function declarations, declared state precedes the hook", () => {
  assert.equal(src.split("  function rateOwner(owner, op, commit = false) {\n").length - 1, 1);
  assert.equal(src.split("  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate }) {\n").length - 1, 1);
  const hook = patched.indexOf("const funding = createFundingRoute(");
  assert.ok(patched.indexOf("const ownerOpsCount = new Map();") < hook);
  assert.ok(patched.indexOf("store.data.revokedVaults ??= {};") < hook);
  assert.ok(patched.indexOf("const queue = new TxQueue(") < hook);
});

test("the original /owner and /end handlers carry no marked block (the only route() insert is the first line)", () => {
  const routeAt = patched.indexOf("  async function route(method, path, body, ctx) {\n");
  const ownerAt = patched.indexOf('if (method === "POST" && path === "/owner") {');
  const endAt = patched.indexOf('if (method === "POST" && path === "/end") {');
  const after = patched.indexOf("    throw httpError(404, \"not_found\", \"no such sessions endpoint\");");
  assert.ok(routeAt > 0 && ownerAt > routeAt && endAt > ownerAt && after > endAt);
  assert.ok(!patched.slice(ownerAt, after).includes("funding-r2"));
});

test("the drop-in route copy differs from the stage route only by its two imports", () => {
  const route = readFileSync(join(STAGE, "funding-route.mjs"), "utf8");
  const copy = readFileSync(join(STAGE, "patched", "relay", "funding-route.mjs"), "utf8");
  const expect = route.replace('from "../../source/node_modules/viem/_esm/index.js";', 'from "viem";')
    .replace('from "./generated/funding-abi.mjs";', 'from "./funding-abi.mjs";');
  assert.equal(copy, expect);
  assert.equal(readFileSync(join(STAGE, "patched", "relay", "funding-abi.mjs"), "utf8"),
    readFileSync(join(STAGE, "generated", "funding-abi.mjs"), "utf8"));
});

test("the prepare manifest records link references, runtime sizes and grant fields", () => {
  const m = JSON.parse(readFileSync(join(STAGE, "generated", "PREPARE-MANIFEST.json"), "utf8"));
  assert.equal(m.source["relay/sessions.mjs"], PIN);
  for (const lib of ["FundingGasLib", "FundingSessionVaultLib"]) assert.ok(Object.keys(m.vaultLinkReferences).some((k) => k.endsWith(`:${lib}`)));
  for (const n of Object.values(m.runtimeBytes)) assert.ok(n > 0 && n <= 24576);
  for (const f of ["maxGasUsdcPerOp", "maxUsdcPerEth6", "maxEthPerOp"]) assert.ok(m.grantFields.includes(f));
});
