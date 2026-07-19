// EnclaveFeatured site surface — the Apps page hand-encodes campaign calls
// (place / fund / withdraw / settle / setActive) and decodes Campaign[] pages
// with the minimal codec in js/core/chain.js. Campaign is the platform's first
// STATIC struct (no strings), which ABI-encodes arrays INLINE with no
// per-element offset table — these tests pin the codec's static path (and the
// pre-existing dynamic path) against viem, and the hand-copied FEAT_SEL map
// against the checked-in ABI.
//
//   run: node --test test/featured.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, encodeAbiParameters, toFunctionSelector } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { encCall, decodeStructArray, FEAT_SEL, CAMPAIGN_SCHEMA, APP_SCHEMA } = await import(path.join(REPO, "site/js/core/chain.js"));
const ABI = JSON.parse(fs.readFileSync(path.join(REPO, "contracts", "EnclaveFeatured.abi.json"), "utf8"));

const APP_ID = "0x" + "ab".repeat(32);
const ADV = "0x1111111111111111111111111111111111111111";
const eq = (got, want) => assert.equal(got.toLowerCase(), want.toLowerCase());

test("FEAT_SEL selectors match the compiled ABI (viem-derived)", () => {
  const byName = Object.fromEntries(ABI.filter((f) => f.type === "function").map((f) => [f.name, toFunctionSelector(f).slice(2)]));
  const expect = {
    campaignCount: "campaignCount", getCampaignsPage: "getCampaignsPage", getCampaign: "getCampaign",
    featuredSchema: "featuredSchema", maxBidPerView6: "maxBidPerView6",
    place: "place", fund: "fund", fundAuth: "fundWithAuthorization",
    withdraw: "withdraw", setActive: "setActive", settle: "settle",
  };
  for (const [key, fn] of Object.entries(expect))
    assert.equal(FEAT_SEL[key], byName[fn], `FEAT_SEL.${key} vs ABI ${fn}`);
});

test("campaign call encodings match viem", () => {
  const viem = (functionName, args) => encodeFunctionData({ abi: ABI, functionName, args });
  eq(encCall(FEAT_SEL.place, [{ t: "bytes32", v: APP_ID }, { t: "uint", v: 2500 }]), viem("place", [APP_ID, 2500n]));
  eq(encCall(FEAT_SEL.fund, [{ t: "bytes32", v: APP_ID }, { t: "uint", v: 10_000_000 }]), viem("fund", [APP_ID, 10_000_000n]));
  eq(encCall(FEAT_SEL.withdraw, [{ t: "bytes32", v: APP_ID }, { t: "uint", v: 0 }]), viem("withdraw", [APP_ID, 0n]));
  eq(encCall(FEAT_SEL.settle, [{ t: "bytes32", v: APP_ID }, { t: "uint", v: 1234 }]), viem("settle", [APP_ID, 1234n]));
  eq(encCall(FEAT_SEL.setActive, [{ t: "bytes32", v: APP_ID }, { t: "bool", v: false }]), viem("setActive", [APP_ID, false]));
  eq(encCall(FEAT_SEL.getCampaignsPage, [{ t: "uint", v: 0 }, { t: "uint", v: 100 }]), viem("getCampaignsPage", [0n, 100n]));
});

const CAMPAIGN_ABI = { type: "tuple[]", components: [
  { name: "appId", type: "bytes32" }, { name: "advertiser", type: "address" },
  { name: "bidPerView6", type: "uint256" }, { name: "balance6", type: "uint256" },
  { name: "spent6", type: "uint256" }, { name: "createdAt", type: "uint64" }, { name: "active", type: "bool" },
]};

test("Campaign[] (static tuples, inline layout) decodes against a viem encoding", () => {
  const rows = [
    { appId: APP_ID, advertiser: ADV, bidPerView6: 2500n, balance6: 25_000_000n, spent6: 1_000_000n, createdAt: 1_770_000_000n, active: true },
    { appId: "0x" + "cd".repeat(32), advertiser: "0x2222222222222222222222222222222222222222", bidPerView6: 100n, balance6: 0n, spent6: 0n, createdAt: 1_770_000_001n, active: false },
  ];
  const hex = encodeAbiParameters([CAMPAIGN_ABI], [rows]);
  const got = decodeStructArray(hex, CAMPAIGN_SCHEMA);
  assert.equal(got.length, 2);
  eq(got[0].appId, APP_ID);
  eq(got[0].advertiser, ADV);
  assert.equal(got[0].bidPerView6, 2500);
  assert.equal(got[0].balance6, 25_000_000);
  assert.equal(got[0].spent6, 1_000_000);
  assert.equal(got[0].createdAt, 1_770_000_000);
  assert.equal(got[0].active, true);
  assert.equal(got[1].active, false);
  assert.equal(got[1].balance6, 0);
  assert.equal(decodeStructArray(encodeAbiParameters([CAMPAIGN_ABI], [[]]), CAMPAIGN_SCHEMA).length, 0, "empty page");
});

test("dynamic tuples (catalog App[]) still route through the offset table", () => {
  const APP_ABI = { type: "tuple[]", components: [
    { name: "appId", type: "bytes32" }, { name: "publisher", type: "address" },
    { name: "slug", type: "string" }, { name: "name", type: "string" }, { name: "description", type: "string" },
    { name: "versionCount", type: "uint256" }, { name: "createdAt", type: "uint64" },
    { name: "updatedAt", type: "uint64" }, { name: "active", type: "bool" },
  ]};
  const rows = [{ appId: APP_ID, publisher: ADV, slug: "hello", name: "Hello", description: "d", versionCount: 3n, createdAt: 1n, updatedAt: 2n, active: true }];
  const got = decodeStructArray(encodeAbiParameters([APP_ABI], [rows]), APP_SCHEMA);
  assert.equal(got.length, 1);
  assert.equal(got[0].slug, "hello");
  assert.equal(got[0].versionCount, 3);
  assert.equal(got[0].active, true);
});
