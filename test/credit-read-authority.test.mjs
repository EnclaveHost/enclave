// /credit/ chain endpoints under the site release's read authority (site/js/core/read-authority.js creditEndpoints, used by
// site/credit/credit.js; scripts/build-site.mjs embeds the same reviewed authority into the credit bundle). Offline: the REAL
// quorum reader (site/js/core/quorum.js) with a fetch stub that records every URL. What this proves: endpoint SELECTION and
// that the quorum is never reduced. It proves nothing about the answers: "own-rpc" is a trusted self-hosted transport, not
// proof verification.   run: node --test test/credit-read-authority.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReadAuthority, creditEndpoints } from "../site/js/core/read-authority.js";
import { createQuorumReader, jsonRpc } from "../site/js/core/quorum.js";
import { embedReadAuthority, READ_AUTHORITY_DECLARATION } from "../scripts/site-read-authority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "site/credit/credit-config.json"), "utf8"));   // the shipped defaults
const OWN = ["https://rpc-a.own-node.example/", "https://rpc-b.own-node.example/base"];
const auth = (rpcs = OWN) => JSON.stringify({ version: 1, mode: "own-rpc", rpcs, trust: "self-hosted-transport" });
const PUBLIC_HOSTS = CONFIG.rpcs.map((u) => new URL(u).host);

test("legacy (no release authority): credit-config.json's endpoints and quorum, exactly as before", () => {
  const e = creditEndpoints({ authority: resolveReadAuthority({ legacy: [] }), config: CONFIG });
  assert.deepEqual(e, { rpcs: CONFIG.rpcs, quorum: CONFIG.quorum, source: "config" });
  assert.equal(CONFIG.quorum, 2, "the shipped credit quorum is 2");
});

test("own-rpc release: ONLY the own endpoints, with the SAME quorum; the shipped public defaults are not used", () => {
  const e = creditEndpoints({ authority: resolveReadAuthority({ text: auth(), legacy: [] }), config: CONFIG });
  assert.deepEqual(e, { rpcs: OWN, quorum: CONFIG.quorum, source: "release-own-rpc" });
  assert.ok(e.rpcs.every((u) => !PUBLIC_HOSTS.includes(new URL(u).host)));
});

test("own-rpc with ONE endpoint is refused: one own RPC never stands in for the quorum, and nothing public is substituted", () => {
  assert.throws(() => creditEndpoints({ authority: resolveReadAuthority({ text: auth([OWN[0]]), legacy: [] }), config: CONFIG }),
    /names 1 endpoint\(s\), but the credit page needs 2 agreeing: refusing/);
});

test("an invalid or mislabelled release authority is refused (no endpoint at all, never the public defaults)", () => {
  for (const text of ['{"version":1}', auth(["https://mainnet.base.org/"]), auth(["http://own.example/"])])
    assert.throws(() => creditEndpoints({ authority: resolveReadAuthority({ text, legacy: [] }), config: CONFIG }), /invalid \(.+\): refusing/);
});

test("the owner's saved endpoints keep precedence over the release (the owner's explicit choice, unchanged)", () => {
  const saved = { rpcs: ["https://x.example/", "https://y.example/"], quorum: 2 };
  for (const text of [null, auth()]) assert.deepEqual(creditEndpoints({ authority: resolveReadAuthority({ text, legacy: [] }), saved, config: CONFIG }), { ...saved, source: "owner" });
  assert.equal(creditEndpoints({ authority: resolveReadAuthority({ legacy: [] }), saved: { rpcs: ["https://x.example/"] }, config: CONFIG }).source, "config",
    "a malformed saved entry (no quorum) is ignored, not trusted");
});

test("integration: the REAL quorum reader built from the own-rpc selection contacts ONLY the own endpoints, and fails without a public fallback", async () => {
  const seen = [];
  const fetchStub = async (url) => { seen.push(String(url)); throw new Error("own node down"); };
  const e = creditEndpoints({ authority: resolveReadAuthority({ text: auth(), legacy: [] }), config: CONFIG });
  const reader = createQuorumReader({ rpcs: e.rpcs, quorum: e.quorum, confirmations: CONFIG.confirmations, maxBlockAgeSeconds: CONFIG.maxBlockAgeSeconds,
    chainId: CONFIG.chainId, rpc: jsonRpc(fetchStub, 1000) });
  assert.deepEqual([...reader.rpcs], OWN); assert.equal(reader.quorum, 2);
  await assert.rejects(Promise.resolve().then(() => reader.snapshot()), "an own-endpoint outage is a refusal");
  assert.ok(seen.length > 0, "the reader tried to read");
  assert.ok(seen.every((u) => OWN.some((o) => u.startsWith(new URL(o).origin))), `only own endpoints were contacted: ${seen}`);
});

test("build seam: the credit bundle embeds the SAME reviewed read authority as the main site (one declaration, one plugin)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/build-site.mjs"), "utf8");
  const credit = src.slice(src.indexOf('entryPoints: [path.join(SITE, "credit/credit.js")]'));
  assert.match(credit.slice(0, 600), /plugins: \[\.\.\.\(READ_AUTH \? \[readAuthorityPlugin\(READ_AUTH\.text, SITE\)\] : \[\]\)\]/,
    "the credit build applies the reviewed read-authority plugin");
  const ra = fs.readFileSync(path.join(ROOT, "site/js/core/read-authority.js"), "utf8");
  assert.equal(ra.split(READ_AUTHORITY_DECLARATION).length - 1, 1, "exactly one replaceable declaration");
  assert.match(embedReadAuthority(ra, auth()), /export const READ_AUTHORITY_TEXT = "/, "the embedding function used by the plugin replaces it");
  assert.match(fs.readFileSync(path.join(ROOT, "site/credit/credit.js"), "utf8"), /creditEndpoints\(\{ authority: resolveReadAuthority\(/, "credit.js selects through creditEndpoints");
});
