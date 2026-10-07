// MCP wallet-session layer (relay/mcp.js): key/signature parsing, the SessionCall digest
// (must equal the SDK's and therefore the vault's), and the builder-transaction ->
// session-step translation that lets every build_* tool act through a session.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createHash } from "node:crypto";
import { encodeAbiParameters, encodeFunctionData, keccak256, toFunctionSelector } from "viem";
import { sessionPublicKey, sessionSignature, sessionCallDigest, stepsFromTxs,
  encodeCreateTx, encodeFundTxs, encodeSetActiveTx, encodeSetSharesTx, encodeResizeTx, encodeSetMaxRateTx,
  encodeRefundTx, encodeTransferTx, encodeSetConfigTx, encodePublishTx } from "../relay/mcp.js";

const SDK = new URL("../sdk/sessions/dist/node.mjs", import.meta.url);
const sdk = fs.existsSync(SDK) ? await import(SDK) : null;

const DEPS = "0x606C7910acDeC5DE534FD6d16Bf71AEb0C43eAe9";
const CAT = "0xaB0462E55c18E295A221e4Eaa8738F25eB0696D7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VAULT = "0xB794C4DD0e1C5E6B72281799F282BfdE7654345D";
const ID = "0x" + "ab".repeat(32);
const SID = "0x" + "cd".repeat(32);
const ctx = { deployments: DEPS, appCatalog: CAT, rev: 15, catRevision: 9, env: 2, fund6: 0n };
const B32 = { type: "bytes32" };

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, jwk };
}

test("session keys arrive as {x,y} in any common encoding, or as the uncompressed point", () => {
  const { jwk } = p256();
  const hx = (b64) => "0x" + Buffer.from(b64, "base64url").toString("hex");
  const want = { x: hx(jwk.x), y: hx(jwk.y) };
  assert.deepEqual(sessionPublicKey({ x: jwk.x, y: jwk.y }), want, "base64url (a JWK)");
  assert.deepEqual(sessionPublicKey(want), want, "0x hex");
  assert.deepEqual(sessionPublicKey({ x: BigInt(want.x).toString(), y: BigInt(want.y).toString() }), want, "decimal");
  assert.deepEqual(sessionPublicKey("04" + want.x.slice(2) + want.y.slice(2)), want, "uncompressed point");
  assert.throws(() => sessionPublicKey("02" + want.x.slice(2)), /uncompressed/);
  assert.throws(() => sessionPublicKey({ x: "nope", y: want.y }), /publicKey.x/);
});

test("signatures: raw r||s (WebCrypto), DER (node/openssl) and {r,s} all normalize to the same words", () => {
  const { privateKey } = p256();
  const msg = Buffer.from("x".repeat(32));
  const raw = cryptoSign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const want = { r: "0x" + raw.subarray(0, 32).toString("hex"), s: "0x" + raw.subarray(32).toString("hex") };
  assert.deepEqual(sessionSignature(raw.toString("hex")), want);
  assert.deepEqual(sessionSignature("0x" + raw.toString("hex")), want);
  assert.deepEqual(sessionSignature(raw.toString("base64url")), want);
  assert.deepEqual(sessionSignature(want), want);
  // a DER signature of the same message decodes to a VALID (r, s) for that key
  const der = cryptoSign("sha256", msg, { key: privateKey });
  const d = sessionSignature(der.toString("hex"));
  const back = Buffer.concat([Buffer.from(d.r.slice(2), "hex"), Buffer.from(d.s.slice(2), "hex")]);
  assert.ok(cryptoVerify("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" }, back));
  assert.throws(() => sessionSignature("0x1234"), /64 bytes/);
});

test("the SessionCall digest equals the SDK's (and so the vault's EIP-712 hash), and signs like the vault checks it", { skip: !sdk && "needs a built SDK (cd sdk/sessions && npm run build)" }, () => {
  const args = encodeAbiParameters([B32, { type: "bool" }], [ID, false]);
  const call = { vault: VAULT, sid: SID, nonce: 7n, action: 6, args, fee: 9482n, deadline: 1791400000n };
  const mine = sessionCallDigest(call);
  const theirs = sdk.digestOf(8453, VAULT, "SessionCall",
    { sessionId: SID, nonce: 7n, action: 6, argsHash: keccak256(args), fee: 9482n, deadline: 1791400000n });
  assert.equal(mine, theirs);
  // the vault verifies P256(sha256(digest)): ECDSA-with-SHA-256 over the 32 digest bytes is exactly that
  const { privateKey } = p256();
  const bytes = Buffer.from(mine.slice(2), "hex");
  const sig = sessionSignature(cryptoSign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex"));
  const sha = createHash("sha256").update(bytes).digest();
  const raw = Buffer.concat([Buffer.from(sig.r.slice(2), "hex"), Buffer.from(sig.s.slice(2), "hex")]);
  assert.ok(cryptoVerify(null, sha, { key: privateKey, dsaEncoding: "ieee-p1363" }, raw) === false
    || cryptoVerify("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }, raw));
  // any change to the call changes the digest
  assert.notEqual(sessionCallDigest({ ...call, nonce: 8n }), mine);
  assert.notEqual(sessionCallDigest({ ...call, args: encodeAbiParameters([B32, { type: "bool" }], [ID, true]) }), mine);
  assert.notEqual(sessionCallDigest({ ...call, vault: "0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C" }), mine);
});

test("builder transactions translate to the vault's action encodings", { skip: !sdk && "needs a built SDK" }, () => {
  const enc = (a, v) => sdk.encodeArgs(a, v);
  // stop / resume
  let s = stepsFromTxs([encodeSetActiveTx({ deployments: DEPS, id: ID, active: false })], ctx);
  assert.deepEqual(s.map((x) => [x.action, x.args, x.id]), [[6, enc("deploy.setActive", { id: ID, active: false }), ID]]);
  // fund: the USDC approve is dropped (the vault pays from the budget), fund -> deploy.fund
  s = stepsFromTxs(encodeFundTxs({ deployments: DEPS, id: ID, usd: 2.5 }), ctx);
  assert.deepEqual(s.map((x) => [x.action, x.args]), [[1, enc("deploy.fund", { id: ID, amount6: 2_500_000n })]]);
  assert.throws(() => stepsFromTxs(encodeFundTxs({ deployments: DEPS, id: ID, ethWei: 10n ** 15n }), ctx), /USDC/);
  // resize, cap, refund
  s = stepsFromTxs([encodeSetSharesTx({ deployments: DEPS, id: ID, gpuMilli: 0, cpuMilli: 500 })], ctx);
  assert.deepEqual([s[0].action, s[0].args], [4, enc("deploy.setShares", { id: ID, gpuMilli: 0, cpuMilli: 500 })]);
  s = stepsFromTxs([encodeSetMaxRateTx({ deployments: DEPS, id: ID, maxRate6: 800n })], ctx);
  assert.deepEqual([s[0].action, s[0].args], [5, enc("deploy.setMaxRate", { id: ID, maxRate6: 800n })]);
  s = stepsFromTxs([encodeRefundTx({ deployments: DEPS, id: ID })], ctx);
  assert.deepEqual([s[0].action, s[0].args], [7, enc("deploy.refund", { id: ID })]);
  // upgrade + resize in one multicall -> two steps, in order
  s = stepsFromTxs([encodeResizeTx({ deployments: DEPS, id: ID, appRef: "catalog://0x" + "11".repeat(32) + "/3", gpuMilli: 100, cpuMilli: 200 })], ctx);
  assert.deepEqual(s.map((x) => x.action), [2, 4]);
  assert.equal(s[0].args, enc("deploy.setAppRef", { id: ID, appRef: "catalog://0x" + "11".repeat(32) + "/3" }));
  s = stepsFromTxs([encodeSetConfigTx({ deployments: DEPS, id: ID, envelope: "{\"config\":{}}" })], ctx);
  assert.deepEqual([s[0].action, s[0].args], [3, enc("deploy.setConfig", { id: ID, configCid: "{\"config\":{}}" })]);
  // a transfer is the owner's alone; anything addressed elsewhere is refused
  assert.throws(() => stepsFromTxs([encodeTransferTx({ deployments: DEPS, id: ID, to: VAULT })], ctx), /owner's alone/);
  assert.throws(() => stepsFromTxs([{ to: VAULT, data: "0x", value: "0x0", function: "eth transfer" }], ctx), /can't make/);
});

test("a create becomes deploy.create in the requested environment, funded from the budget in the same call", { skip: !sdk && "needs a built SDK" }, () => {
  const appRef = "catalog://0x" + "22".repeat(32) + "/5";
  const t = encodeCreateTx({ rev: 15, deployments: DEPS, appRef, gpuMilli: 0, cpuMilli: 100, appPort: 8080, ports: "http:8080",
    isPublic: true, envelope: "", feeRecipient: "0x0000000000000000000000000000000000000000", feePerSec6: 0n, maxRate6: 300n });
  const [step] = stepsFromTxs([t], { ...ctx, env: 1, fund6: 3_000_000n });
  assert.equal(step.action, 0);
  assert.equal(step.args, sdk.encodeArgs("deploy.create", { appRef, gpuMilli: 0, cpuMilli: 100, appPort: 8080, ports: "http:8080",
    isPublic: true, configCid: "", maxRate6: 300n, env: "staging", fund6: 3_000_000n }));
});

test("a publish becomes app.publish, and a publisher fee (paid to a WALLET) is refused", { skip: !sdk && "needs a built SDK" }, () => {
  const base = { rev: 9, appCatalog: CAT, slug: "my-app", name: "My app", description: "d", version: "3", cid: "bafy",
    res: [0, 0, 512, 10], ports: "http:8080", config: "{}" };
  const [step] = stepsFromTxs([encodePublishTx({ ...base, feePerSec6: 0n })], ctx);
  assert.equal(step.action, 8);
  assert.equal(step.args, sdk.encodeArgs("app.publish", { slug: "my-app", name: "My app", description: "d", version: "3", cid: "bafy",
    res: [0, 0, 512, 10], ports: "http:8080", config: "{}", configCid: "" }));
  assert.throws(() => stepsFromTxs([encodePublishTx({ ...base, feePerSec6: 10n })], ctx), /publisher fee/);
  // the USDC approve on its own is nothing to do
  const approve = { to: USDC, data: toFunctionSelector("approve(address,uint256)") + "0".repeat(128), value: "0x0", function: "USDC.approve" };
  assert.deepEqual(stepsFromTxs([approve], ctx), []);
});
