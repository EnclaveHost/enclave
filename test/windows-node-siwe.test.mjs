// Proving a wallet to this box. The refusals are the subject: a login route that is loose in any
// of these places is a login route that signs somebody else in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { nonceStore, siweMessage, verifyLogin } from "../windows/node/siwe.mjs";

const acct = privateKeyToAccount("0x" + "11".repeat(32));
const other = privateKeyToAccount("0x" + "22".repeat(32));
const P = { domain: "enclave.host", uri: "https://enclave.host", chainId: 8453 };

/** Issue, sign and present, the way the console does. */
async function login(nonces, { signer = acct, tamper = (m) => m, address = acct.address } = {}) {
  const nonce = nonces.issue(address);
  const { message } = siweMessage({ address, nonce, ...P });
  const sent = tamper(message);
  const signature = await signer.signMessage({ message: sent });
  return verifyLogin({ message: sent, signature, nonces, ...P, verifyMessage });
}

test("a real signature over this box's own message signs in", async () => {
  const n = nonceStore();
  const r = await login(n);
  assert.equal(r.address, acct.address.toLowerCase());
});

test("the nonce is single-use, and is spent even by a FAILED attempt", async () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);
  const { message } = siweMessage({ address: acct.address, nonce, ...P });
  // Wrong signer: the attempt fails...
  const badSig = await other.signMessage({ message });
  const bad = await verifyLogin({ message, signature: badSig, nonces: n, ...P, verifyMessage });
  assert.equal(bad.error, "bad_signature");
  // ...and the nonce is gone, so it cannot be ground against with the right one.
  const goodSig = await acct.signMessage({ message });
  const after = await verifyLogin({ message, signature: goodSig, nonces: n, ...P, verifyMessage });
  assert.equal(after.error, "bad_nonce", "a nonce that survives a failed attempt can be ground");
});

test("a signature by somebody else over a well-formed message is refused", async () => {
  const n = nonceStore();
  const r = await login(n, { signer: other });
  assert.equal(r.error, "bad_signature");
});

test("a message naming another domain, uri or chain is not a login HERE", async () => {
  for (const [what, tamper, code] of [
    ["domain", (m) => m.replace("enclave.host wants", "evil.example wants"), "bad_domain"],
    ["uri", (m) => m.replace("URI: https://enclave.host", "URI: https://evil.example"), "bad_uri"],
    ["chain", (m) => m.replace("Chain ID: 8453", "Chain ID: 1"), "bad_chain"],
  ]) {
    const n = nonceStore();
    const r = await login(n, { tamper });
    assert.equal(r.error, code, `a ${what} we did not issue must not sign anyone in`);
  }
});

test("an expired message is refused even with a live nonce", async () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);
  const past = new Date(Date.now() - 3600_000);
  const { message } = siweMessage({ address: acct.address, nonce, ...P, issuedAt: past });
  const signature = await acct.signMessage({ message });
  const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.error, "expired");
});

test("a nonce issued for one address does not sign in another", async () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);                 // issued FOR acct
  const { message } = siweMessage({ address: other.address, nonce, ...P });   // but names other
  const signature = await other.signMessage({ message });
  const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.error, "address_mismatch");
});

test("an unknown or expired nonce is refused", async () => {
  const n = nonceStore();
  const { message } = siweMessage({ address: acct.address, nonce: "deadbeef", ...P });
  const signature = await acct.signMessage({ message });
  assert.equal((await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage })).error, "bad_nonce");

  // An aged nonce cannot be isolated from an aged MESSAGE for a message this box issued: both
  // windows are the same ten minutes, and the message check runs first. So the refusal is
  // "expired" rather than "bad_nonce" - accurate either way, and worth recording rather than
  // asserting a code the code cannot produce.
  let t = Date.now();
  const n2 = nonceStore({ now: () => t });
  const nonce = n2.issue(acct.address);
  t += 11 * 60_000;
  const m2 = siweMessage({ address: acct.address, nonce, ...P }).message;
  const s2 = await acct.signMessage({ message: m2 });
  const aged = await verifyLogin({ message: m2, signature: s2, nonces: n2, ...P, verifyMessage, now: t });
  assert.equal(aged.error, "expired");
  assert.equal(aged.address, undefined);
  // ...and the nonce really is dead underneath, which is what stops a replay with a fresh message.
  assert.equal(n2.take(nonce), null);
});

test("malformed input is refused rather than thrown", async () => {
  const n = nonceStore();
  for (const [message, signature] of [
    [null, "0x"], ["", ""], ["no nonce here", "0x11"], [42, "0x11"], ["x", null],
    ["nothing that looks like an address\nNonce: abc\n", "0x11"],
  ]) {
    const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
    assert.ok(r.error, `${JSON.stringify(message)} must be refused`);
    assert.equal(r.address, undefined);
  }
});

test("the nonce map is bounded, oldest first", () => {
  const n = nonceStore();
  const first = n.issue(acct.address);
  for (let i = 0; i < 5000; i++) n.issue(acct.address);
  assert.ok(n.size <= 4096, `holding ${n.size}`);
  assert.equal(n.take(first), null, "the oldest went first, which is also what would expire first");
});

test("the message this box issues is the platform's, field for field", () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);
  const m = siweMessage({ address: acct.address, nonce, ...P });
  assert.match(m.message, /^enclave\.host wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\n/);
  assert.match(m.message, /\nSign in to Enclave\. This signature is free and will not move funds\.\n/);
  assert.match(m.message, /\nURI: https:\/\/enclave\.host\nVersion: 1\nChain ID: 8453\nNonce: [0-9a-f]+\n/);
  assert.match(m.message, /\nIssued At: .+\nExpiration Time: .+$/);
  assert.equal(m.version, "1");
});
