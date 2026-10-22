// site/js/core/passkey-account.js without a chain: the owner-selected profile rules, the capability text, the exact Safe
// signature layout, the assertion-shape refusals, the owner-only ERC-4337 transport, and the vendored aa.js bundle. The
// integration against the pinned deployed Safe code is test/site-independent-passkey-aa.test.mjs.
//   run: node --test test/site-independent-passkey-account.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";
import { buildAaVendor, OUT as AA_OUT, MANIFEST as AA_MANIFEST, EXPORTS } from "../scripts/build-aa-vendor.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let PA, AP;
test.before(async () => {
  globalThis.localStorage ??= { m: new Map(), getItem(k){ return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v){ this.m.set(k, String(v)); }, removeItem(k){ this.m.delete(k); } };
  globalThis.sessionStorage ??= globalThis.localStorage; globalThis.location ??= { hostname: "localhost" };
  PA = await import(pathToFileURL(path.join(REPO, "site/js/core/passkey-account.js")).href);
  AP = await import(pathToFileURL(path.join(REPO, "site/js/core/account-providers.js")).href);
  PA._useLibForTests({ ...viem, WebAuthnP256 });
});

const pk = (n, rp) => ({ kind: "passkey", signer: "0x" + n.repeat(20), x: "0x" + n.repeat(32), y: "0x" + n.repeat(32), verifiers: String(0x100n << 160n),
  credentialId: Buffer.from("credential-" + n).toString("base64url"), rpId: rp, label: "key " + n });
const key = (n) => ({ kind: "key", address: "0x" + n.repeat(20), label: "recovery " + n });
const base = (over = {}) => ({ v: 1, provider: "safe-passkey", chainId: 8453, safe: "0x" + "5a".repeat(20), saltNonce: "42", threshold: 1, transport: null,
  owners: [pk("aa", "dash-a.example")], ...over });

test("the vendored aa.js is exactly a fresh build of the repository's viem/ox exports", async () => {
  const { js, manifest } = await buildAaVendor();
  assert.equal(Buffer.compare(fs.readFileSync(AA_OUT), js), 0, "rebuild with: node scripts/build-aa-vendor.mjs");
  assert.deepEqual(JSON.parse(fs.readFileSync(AA_MANIFEST, "utf8")), manifest);
  const B = await import(pathToFileURL(AA_OUT).href);
  for (const n of EXPORTS) assert.ok(n in B, n);
});

test("profile: exact fields, pinned verifiers only, distinct owners, threshold in range, a validated owner transport", () => {
  assert.ok(PA.validateAccountProfile(base()));
  const two = base({ owners: [pk("aa", "a.example"), pk("bb", "b.example"), key("cc")], threshold: 2,
    transport: { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers: ["https://bundler.example.org"] } });
  assert.ok(PA.validateAccountProfile(two));
  for (const [p, re] of [
    [{ ...base(), extra: 1 }, /missing or unknown/], [base({ provider: "coinbase-smart-wallet" }), /unsupported/], [base({ chainId: 1 }), /unsupported/],
    [base({ owners: [] }), /no owners/], [base({ owners: [{ ...pk("aa", "a.example"), verifiers: "1" }] }), /pinned verifiers/],
    [base({ owners: [{ ...pk("aa", "a.example"), rpId: "not a domain" }] }), /RP id/], [base({ owners: [pk("aa", "a.example"), pk("aa", "b.example")] }), /distinct/],
    [base({ threshold: 2 }), /threshold/], [base({ threshold: 0 }), /threshold/], [base({ owners: [{ kind: "relay", address: "0x" + "11".repeat(20) }] }), /passkeys or keys/],
    [base({ transport: { provider: "safe-passkey", entryPoint: AP.PROVIDERS["coinbase-smart-wallet"].entryPoint, bundlers: ["https://b.example.org"] } }), /EntryPoint/],
    [base({ transport: { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers: ["https://x.enclave.host"] } }), /Enclave-operated/],
  ]) assert.throws(() => PA.validateAccountProfile(p), re, JSON.stringify(p).slice(0, 120));
  PA.saveAccountProfile(two, globalThis.localStorage);
  assert.equal(PA.loadAccountProfile(8453, globalThis.localStorage).threshold, 2);
  globalThis.localStorage.setItem(PA.PROFILE_PREFIX + 8453, JSON.stringify({ ...two, threshold: 9 }));
  assert.equal(PA.loadAccountProfile(8453, globalThis.localStorage), null, "an invalid stored profile is ignored, never repaired silently");
});

test("capabilities say exactly what the owners can and cannot rely on - and never call one RP independence", () => {
  const one = PA.accountCapabilities(base()).join("\n");
  assert.match(one, /One owner: losing it loses the account/); assert.match(one, /Every passkey is under dash-a.example/);
  assert.match(one, /no ERC-4337 transport chosen/); assert.match(one, /No Enclave account, relay, RP, bundler or paymaster/);
  const multi = PA.accountCapabilities(base({ owners: [pk("aa", "a.example"), pk("bb", "b.example"), key("cc")], threshold: 2 })).join("\n");
  assert.match(multi, /3 owner\(s\): 2 passkey\(s\) under 2 RP id\(s\) \(a.example, b.example\), 1 recovery key\(s\); 2 of 3/);
  assert.doesNotMatch(multi, /Every passkey is under/); assert.match(multi, /Recovery keys work without any website/);
  assert.match(PA.accountCapabilities(base({ owners: [pk("aa", "a.example"), key("cc")], threshold: 1 })).join("\n"), /Any single owner controls the account alone/);
  assert.match(PA.accountCapabilities(base({ owners: [pk("aa", "a.example"), key("cc")], threshold: 2 })).join("\n"), /No spare owner/);
});

test("Safe signature bytes: ascending owners; contract signatures as {r: signer, s: offset, v: 0} + length || data; ECDSA verbatim", async () => {
  const hi = "0x" + "f0".repeat(20), lo = "0x" + "0a".repeat(20), mid = "0x" + "77".repeat(20);
  const dHi = "0x" + "ab".repeat(70), dLo = "0x" + "cd".repeat(33);
  const ecdsa = "0x" + "11".repeat(64) + "1f";
  const out = await PA.safeSignatures([{ signer: hi, data: dHi }, { signer: mid, ecdsa }, { signer: lo, data: dLo }]);
  const h = out.slice(2), word = (i) => h.slice(i * 2, i * 2 + 64);
  // static part: 3 x 65 bytes in ascending owner order (lo, mid, hi)
  assert.equal(word(0), "0".repeat(24) + lo.slice(2)); assert.equal(BigInt("0x" + word(32)), 195n); assert.equal(h.slice(128, 130), "00");
  assert.equal("0x" + h.slice(130, 260), ecdsa);
  assert.equal(word(130), "0".repeat(24) + hi.slice(2)); assert.equal(BigInt("0x" + word(162)), 195n + 32n + 33n); assert.equal(h.slice(388, 390), "00");
  // dynamic part: lo's then hi's data, each length-prefixed
  assert.equal(BigInt("0x" + word(195)), 33n); assert.equal("0x" + h.slice(2 * 227, 2 * 227 + 66), dLo);
  assert.equal(BigInt("0x" + word(260)), 70n); assert.equal("0x" + h.slice(2 * 292), dHi);
});

test("the SafeMessage hash equals Safe v1.4.1's own construction from its literal constants (CompatibilityFallbackHandler)", async () => {
  // Safe.sol: DOMAIN_SEPARATOR_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
  // CompatibilityFallbackHandler.sol: SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)"); messageData = 0x19 0x01 || domainSeparator || keccak(abi.encode(SAFE_MSG_TYPEHASH, keccak(message)))
  const DOMAIN = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218", MSG = "0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca";
  assert.equal(viem.keccak256(viem.toBytes("EIP712Domain(uint256 chainId,address verifyingContract)")), DOMAIN);
  assert.equal(viem.keccak256(viem.toBytes("SafeMessage(bytes message)")), MSG);
  const safe = "0x" + "5a".repeat(20), digest = viem.keccak256("0x1234");
  const ds = viem.keccak256(viem.encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [DOMAIN, 8453n, safe]));
  const sm = viem.keccak256(viem.encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [MSG, viem.keccak256(viem.encodeAbiParameters([{ type: "bytes32" }], [digest]))]));
  assert.equal(await PA.safeMessageHash(safe, 8453, digest), viem.keccak256(viem.concat(["0x1901", ds, sm])));
  assert.notEqual(await PA.safeMessageHash(safe, 1, digest), await PA.safeMessageHash(safe, 8453, digest), "bound to the chain");
  assert.notEqual(await PA.safeMessageHash("0x" + "5b".repeat(20), 8453, digest), await PA.safeMessageHash(safe, 8453, digest), "bound to the account");
});

test("a passkey assertion becomes the signer's signature only if it is over exactly this challenge, with UP and UV", async () => {
  const challenge = viem.keccak256("0x01"), b64 = Buffer.from(challenge.slice(2), "hex").toString("base64url");
  const authData = (flags) => "0x" + "00".repeat(32) + flags + "00000001";
  const a = (cdj, flags = "05") => ({ metadata: { authenticatorData: authData(flags), clientDataJSON: cdj }, signature: { r: 5n, s: 7n } });
  const good = '{"type":"webauthn.get","challenge":"' + b64 + '","origin":"https://dash-a.example","crossOrigin":false}';
  const enc = await PA.passkeyContractSignature(a(good), challenge);
  const [ad, fields, r, s] = viem.decodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], enc);
  assert.equal(ad, authData("05")); assert.equal(fields, '"origin":"https://dash-a.example","crossOrigin":false'); assert.equal(r, 5n); assert.equal(s, 7n);
  for (const [cdj, flags, re] of [
    [good.replace(b64, b64.slice(0, -1) + (b64.endsWith("A") ? "B" : "A")), "05", /exact challenge/],
    ['{"challenge":"' + b64 + '","type":"webauthn.get"}', "05", /exact challenge/],
    [good.replace("webauthn.get", "webauthn.create"), "05", /exact challenge/],
    [good, "01", /verification/], [good, "04", /presence/]])
    await assert.rejects(PA.passkeyContractSignature(a(cdj, flags), challenge), re);
});

test("user operations: only with the owner's transport; sent to the owner's bundlers in order, nothing else; paymaster fields split for v0.7", async () => {
  await assert.rejects(PA.prepareUserOperation(base(), { to: "0x" + "11".repeat(20), gas: {} }), (e) => e.code === "no-transport");
  const transport = { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers: ["https://one.example.org/rpc", "https://two.example.net/rpc"] };
  const gas = { verificationGasLimit: 1n, callGasLimit: 2n, preVerificationGas: 3n, maxFeePerGas: 4n, maxPriorityFeePerGas: 5n };
  const op = { sender: "0x" + "5a".repeat(20), nonce: 9n, callData: "0x1234", signature: "0xabcd",
    paymasterAndData: "0x" + "99".repeat(20) + "00".repeat(15) + "0a" + "00".repeat(15) + "0b" + "cafe" };
  const seen = [];
  const fetchImpl = async (url, init) => { const j = JSON.parse(init.body); seen.push([url, j.method, j.params[1], j.params[0]]);
    if (url.includes("one")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "AA21 didn't pay prefund" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "77".repeat(32) })); };
  const r = await PA.sendUserOperation(transport, op, { fetchImpl, gas });
  assert.equal(r.bundler, transport.bundlers[1]);
  assert.deepEqual(seen.map((s) => s.slice(0, 3)), [[transport.bundlers[0], "eth_sendUserOperation", transport.entryPoint], [transport.bundlers[1], "eth_sendUserOperation", transport.entryPoint]]);
  const sentOp = seen[1][3];
  assert.equal(sentOp.paymaster, "0x" + "99".repeat(20)); assert.equal(sentOp.paymasterVerificationGasLimit, "0xa"); assert.equal(sentOp.paymasterPostOpGasLimit, "0xb");
  assert.equal(sentOp.paymasterData, "0xcafe"); assert.equal(sentOp.nonce, "0x9"); assert.equal(sentOp.verificationGasLimit, "0x1");
  let calls = 0;
  await assert.rejects(PA.sendUserOperation(transport, op, { fetchImpl: async () => { calls++; throw new Error("down"); }, gas }),
    (e) => e.code === "transport" && /one.example.org: down; two.example.net: down/.test(e.message) && /Nothing else was tried/.test(e.message)
      && e.delivered === "unknown", "unreachable bundlers may have received it: unknown, never 'not sent'");
  await assert.rejects(PA.sendUserOperation(transport, op, { fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "AA25 invalid account nonce" } })), gas }),
    (e) => e.code === "transport" && e.delivered === false, "every bundler answered with a refusal: nothing is pending");
  assert.equal(calls, 2, "exactly the owner's two bundlers, nothing more");
  await assert.rejects(PA.sendUserOperation({ ...transport, bundlers: ["https://aa.enclave.host"] }, op, { fetchImpl, gas }), /Enclave-operated/);
});

test("the account panel never submits silently: every prepared call is offered with a gas payer the owner picks, and a profile is saved only on an explicit click", () => {
  const ui = fs.readFileSync(path.join(REPO, "site/js/core/account-ui.js"), "utf8");
  assert.match(ui, /Send with my connected wallet \(it only pays gas\)/); assert.match(ui, /Copy calldata for any submitter/);
  assert.ok(ui.indexOf("saveAccountProfile(profile)") > ui.indexOf('acct-save'), "saved from the Save button's handler");
  assert.doesNotMatch(ui, /RelayClient|relayRoot|api\.enclave\.host|\/v1\/account|\/billing\//, "no relay or hosted account call on this path");
  const signIn = ui.slice(ui.indexOf("async function signIn"));
  assert.ok(signIn.indexOf("verifyOwnerSubmission") < signIn.indexOf("offer(["), "checked by the contracts before it is offered for sending");
});
