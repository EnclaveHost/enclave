// Reading a PRICED registry entry (EnclaveRegistry schema 2) without breaking
// on an unpriced one. Three services decode EnclaveRegistry.getPage() with a
// hand-written tuple — scripts/enclave-discover.mjs, relay/fleet.mjs and
// relay/api-relay.js — and schema 2 APPENDED two uint64 price fields to that
// tuple. A 7-field decode of a 9-field page does not fail loudly: viem walks
// head offsets, so it silently yields wrong endpoints (or throws deep in the
// decoder), which during a registry cutover reads as "the fleet vanished".
//
// This drives the real readRegistry() against a stub RPC serving each shape.
// The other two copies carry byte-identical sniff + tuple code, pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { encodeFunctionResult, decodeFunctionData, toFunctionSelector } from "viem";
import { createFleet, fleetConfig } from "../relay/fleet.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OP = "0x" + "ab".repeat(20);

const TUPLE_V1 = [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" },
  { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" },
  { name: "active", type: "bool" }];
const TUPLE_V2 = [...TUPLE_V1,
  { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }];
// schema 5: proof key + payout wallet + the capability pair. `caps` is what
// stopped a registered row from implying "runs code", so the decode has to
// survive a page that mixes an enclave and a relay.
const TUPLE_V5 = [...TUPLE_V2,
  { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" },
  { name: "caps", type: "uint64" }, { name: "region", type: "string" }];
const abiFor = (tuple) => [
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: tuple }] },
  { type: "function", name: "registrySchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

// one enclave, fresh heartbeat, priced when the shape has room for it
const entry = (now, priced) => ({
  endpoint: "https://kryptos.example", repo: "EnclaveHost/enclave",
  measurement: "0x" + "11".repeat(32), operator: OP,
  registeredAt: BigInt(now - 86400), lastSeen: BigInt(now - 60), active: true,
  ...(priced ? { cpuPricePerSec6: 834n, gpuPricePerSec6: 1667n } : {}),
});

// A registry that speaks `schema`. schema 1 REVERTS registrySchema(), exactly
// as the deployed one does (it has no such function).
// a schema-5 page: one enclave that runs code, one relay that only carries it
const entry5 = (now, { endpoint, caps, region }) => ({
  ...entry(now, true), endpoint,
  proofKey: "0x" + "22".repeat(20), payoutWallet: "0x" + "00".repeat(20),
  caps: BigInt(caps), region,
});

async function stubRegistry(schema) {
  const now = Math.floor(Date.now() / 1000);
  const tuple = schema >= 5 ? TUPLE_V5 : schema >= 2 ? TUPLE_V2 : TUPLE_V1;
  const abi = abiFor(tuple);
  const sel = { schema: toFunctionSelector("function registrySchema() view returns (uint256)"),
                count: toFunctionSelector("function count() view returns (uint256)") };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const answer = (m) => {
        if (m.method === "eth_chainId") return { result: "0x2105" };
        const data = m.params?.[0]?.data || "";
        const rows = schema >= 5
          ? [entry5(now, { endpoint: "https://kryptos.example", caps: 1, region: "" }),
             entry5(now, { endpoint: "https://relay-sjc.example", caps: 2, region: "us-west" })]
          : [entry(now, schema >= 2)];
        if (data.startsWith(sel.schema)) {
          if (schema < 2) return { error: { code: 3, message: "execution reverted" } };
          return { result: encodeFunctionResult({ abi, functionName: "registrySchema", result: BigInt(schema) }) };
        }
        if (data.startsWith(sel.count))
          return { result: encodeFunctionResult({ abi, functionName: "count", result: BigInt(rows.length) }) };
        const { functionName, args } = decodeFunctionData({ abi, data });
        assert.equal(functionName, "getPage");
        const page = Number(args[0]) === 0 ? rows : [];
        return { result: encodeFunctionResult({ abi, functionName: "getPage", result: page }) };
      };
      const one = (m) => ({ jsonrpc: "2.0", id: m.id, ...answer(m) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

// fresh module per case: readRegistry's viem client and its schema cache are
// module state, and the cache is keyed by address (both stubs share one)
async function readVia(url) {
  process.env.BASE_RPC = url;
  const mod = await import(`../scripts/enclave-discover.mjs?rpc=${encodeURIComponent(url)}`);
  return mod.readRegistry("0x" + "cd".repeat(20));
}

test("a PRICED registry decodes, prices and all", async (t) => {
  const { srv, url } = await stubRegistry(2);
  t.after(() => srv.close());
  const rows = await readVia(url);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, "https://kryptos.example", "the fields after the strings still land");
  assert.equal(rows[0].repo, "EnclaveHost/enclave");
  assert.equal(rows[0].operator.toLowerCase(), OP);
  assert.equal(rows[0].cpuPricePerSec6, 834n, "what this enclave charges for its whole node");
  assert.equal(rows[0].gpuPricePerSec6, 1667n);
});

test("an UNPRICED registry (schema 1, the getter reverts) still decodes", async (t) => {
  const { srv, url } = await stubRegistry(1);
  t.after(() => srv.close());
  const rows = await readVia(url);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, "https://kryptos.example");
  assert.equal(rows[0].cpuPricePerSec6, undefined, "no price on the old shape - callers fall back");
});

test("a schema-5 registry decodes the capability pair on both kinds of row", async (t) => {
  const { srv, url } = await stubRegistry(5);
  t.after(() => srv.close());
  const rows = await readVia(url);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endpoint, "https://kryptos.example", "the strings still land past four appended fields");
  assert.equal(rows[0].caps, 1n, "CAP_HOST");
  assert.equal(rows[1].caps, 2n, "CAP_APP_SNI — a relay");
  assert.equal(rows[1].region, "us-west");
  assert.equal(rows[0].cpuPricePerSec6, 834n, "and schema 2's fields are where they always were");
});

/* THE cutover hazard of schema 5. `caps` made "is this box an enclave" an
   explicit question, and the answer for every row written before it is a zero
   — so a reader that takes 0 for "no capabilities" unfollows the entire live
   fleet the moment the new registry deploys. The rule is 0 === CAP_HOST, and
   the contract holds up its half by never leaving caps at 0 on register().

   The other half of the same rule: a RELAY must not enter this list. It runs no
   tenants, answers no /v1/net-map and holds no lease, so a data-plane relay that
   followed one would poll a box with nothing to serve and could splice traffic
   at it. */
test("origins() follows enclaves and legacy rows, never relays", async (t) => {
  const { srv, url } = await stubRegistry(5);
  t.after(() => srv.close());
  const fleet = createFleet(fleetConfig({
    REGISTRY_ADDRESS: "0x" + "ef".repeat(20), BASE_RPC: url, TRUSTED_OPERATORS: OP,
  }));
  await fleet.start();
  t.after(() => fleet.stop());
  assert.deepEqual(fleet.origins(), ["https://kryptos.example"],
    "the relay row is discovered, decoded, and deliberately not followed");
});

/* THE FOURTH COPY. The three getPage decoders are pinned byte-identical below,
   which is why it is easy to forget that supervisor.js decodes the same struct
   through get() with a shape of its own — and its own comment demands that
   every read "ask for exactly what the deployed registry answers", because a
   mismatched tuple throws in viem rather than degrading. A copy that lags a
   schema bump is a cutover outage in whichever service lagged, and the
   supervisor is the one that would stop being able to read its OWN entry. */
test("supervisor.js decodes the registry entry at every schema it may meet", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(sup, /\{ name: "caps", type: "uint64" \}, \{ name: "region", type: "string" \}\] \}\] \}\];/,
    "the get() tuple must carry schema 5's capability pair");
  // one truncation per schema it can still meet, and a chooser that reaches the
  // newest first — `rev >= 4` alone would ask a schema-5 registry for 11 fields
  for (const n of [11, 10, 9])
    assert.ok(sup.includes(`REGISTRY_GET_ABI_AT(${n})`), `no truncation for a ${n}-field registry`);
  assert.match(sup, /rev >= 5 \? REGISTRY_GET_ABI : rev >= 4 \? REGISTRY_GET_ABI_V4/,
    "the ABI chooser must test the newest schema first");
});

test("relay/fleet.mjs and relay/api-relay.js carry the same sniff and tuple", () => {
  // the three copies are separate services with their own ABIs; a drift here
  // is a cutover outage in whichever one lagged, so pin the shared shape
  const discover = fs.readFileSync(path.join(REPO, "scripts", "enclave-discover.mjs"), "utf8");
  const want = discover.slice(discover.indexOf("const ENCLAVE_TUPLE = ["),
                              discover.indexOf("const SCHEMA_ABI = ["));
  assert.ok(want.includes("cpuPricePerSec6"), "the fixture itself must carry the priced tuple");
  for (const f of ["relay/fleet.mjs", "relay/api-relay.js"]) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.ok(src.includes(want), `${f} does not carry the schema-2 tuple`);
    assert.ok(/registrySchema/.test(src) && /_regRev/.test(src), `${f} does not sniff the registry schema`);
  }
});

/* A registry redeploy must not strand the fleet.
   REGISTRY_ADDRESS is a LIVE binding — addressbook.js repoints it inside a
   running process, which is the whole point of the book. Registration, though,
   was guarded by a once-per-process boolean, so a repointed registry left every
   box latched onto the old contract: it never registered on the new one, and
   the new ledger (which reads that contract immutably) rejected every claim
   with "not operator", because an unregistered id reads back as a zero-filled
   entry whose operator is 0x0.

   Nothing self-healed and nothing said why. The boxes stayed healthy, kept
   heartbeating the dead registry, and simply never claimed — every deployment
   sat "Queued" indefinitely. Observed on the live fleet 2026-07-28. */
test("registration re-fires when the address book repoints the registry", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");

  // the guard has to be keyed on WHICH registry we registered with
  assert.match(sup, /function registryRepointed\(\)/,
    "supervisor must be able to tell that the registry moved under it");
  assert.match(sup, /_registeredOn/, "it must remember which registry _registered refers to");

  // EVERY path that short-circuits on _registered must consult it, or that path
  // becomes the one that silently keeps the box on the dead registry
  const shim = /async function registerFromShimCert\(\) \{[\s\S]*?\n\}/.exec(sup);
  assert.ok(shim, "registerFromShimCert not found");
  assert.match(shim[0], /registryRepointed\(\)/,
    "the shim-cert path short-circuits on _registered and must check for a repoint too");

  const onChain = /async function registerOnChain\(endpoint\) \{[\s\S]*?_registeredOn = /.exec(sup);
  assert.ok(onChain, "registerOnChain not found");
  assert.match(onChain[0], /registryRepointed\(\)[\s\S]*?_enclaveId = null/,
    "a repoint must clear the cached enclave id - it does not exist on the new registry");

  // an idle box gets no requests, so the heartbeat is its only chance to notice
  const heartbeat = /setInterval\(async \(\) => \{[\s\S]*?HEARTBEAT_SEC\) \* 1000\)/.exec(sup);
  assert.ok(heartbeat, "registry heartbeat loop not found");
  assert.match(heartbeat[0], /registryRepointed\(\)/,
    "an idle enclave must notice a repoint from its heartbeat, not only from traffic");
});

/* A failed schema sniff must not be cached as "rev 1".
   registryRev() picks WHICH register() ABI the box calls: rev 1 takes 3 args,
   rev 2 takes 5, rev 3 takes 6. Caching a failed read as rev 1 is therefore
   unrecoverable — the box calls a 3-arg register() that does not exist on a
   schema-2/3 registry, every attempt reverts, and no retry can heal it because
   the wrong answer is cached.

   Cost metal0 its registration outright on 2026-07-28: it sniffed one second
   after boot with the RPC not yet warm, cached rev 1, and then logged
   "self-registration failed: register reverted" forever while the rest of the
   fleet registered normally. */
test("a failed registry schema sniff is not cached, and the cache is per-registry", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  const fn = /async function registryRev\(\) \{[\s\S]*?\n\}/.exec(sup);
  assert.ok(fn, "registryRev not found");

  // only a revert may be cached as rev 1
  assert.match(fn[0], /revert/i, "must distinguish a revert from an RPC failure");
  assert.doesNotMatch(fn[0], /\}\s*catch\s*\{\s*_registryRev = 1;\s*\}/,
    "a bare catch that caches rev 1 is the bug this test exists for");
  assert.match(fn[0], /throw e/, "a non-revert failure must propagate so the caller retries");

  // and the cache must be keyed on the registry it was sniffed against, since
  // the address book repoints REGISTRY_ADDRESS inside a running process
  assert.match(fn[0], /_registryRevOf/, "the sniff must be cached per registry address");

  // every caller has to tolerate the throw
  for (const caller of ["syncRegisteredPrice", "syncRegisteredProofKey"]) {
    const re = new RegExp(`${caller}\\(id\\)\\.catch\\(`);
    assert.match(sup, re, `${caller} must be called with a .catch so a sniff failure is retryable`);
  }
});
