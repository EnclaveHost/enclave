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

/** Issue, sign and present, the way the console does: the server's message, signed verbatim. */
async function login(nonces, { signer = acct, tamper = (m) => m, address = acct.address } = {}) {
  const nonce = nonces.issue(address);
  const { message } = siweMessage({ address, nonce, ...P });
  nonces.bind(nonce, message);
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
  n.bind(nonce, message);
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
  // One refusal covers all of them now: the message must BE the one this box issued, so a changed
  // field is simply not that message. The per-field codes are gone deliberately - they existed to
  // report which field was wrong, and reporting that is only meaningful if the others are optional.
  for (const [what, tamper] of [
    ["domain", (m) => m.replace("enclave.host wants", "evil.example wants")],
    ["uri", (m) => m.replace("URI: https://enclave.host", "URI: https://evil.example")],
    ["chain", (m) => m.replace("Chain ID: 8453", "Chain ID: 1")],
  ]) {
    const r = await login(nonceStore(), { tamper });
    assert.equal(r.error, "invalid_message", `a ${what} we did not issue must not sign anyone in`);
    assert.equal(r.address, undefined);
  }
});

test("an expired message is refused even with a live nonce", async () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);
  const past = new Date(Date.now() - 3600_000);
  const { message } = siweMessage({ address: acct.address, nonce, ...P, issuedAt: past });
  n.bind(nonce, message);
  const signature = await acct.signMessage({ message });
  const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.error, "expired");
});

test("a nonce issued for one address does not sign in another", async () => {
  const n = nonceStore();
  const nonce = n.issue(acct.address);                 // issued FOR acct
  const { message } = siweMessage({ address: other.address, nonce, ...P });   // but names other
  n.bind(nonce, message);                              // as if it had been issued that way
  const signature = await other.signMessage({ message });
  const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.error, "address_mismatch");
});

test("an unknown or expired nonce is refused", async () => {
  const n = nonceStore();
  const { message } = siweMessage({ address: acct.address, nonce: "deadbeef", ...P });
  const signature = await acct.signMessage({ message });
  assert.equal((await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage })).error, "bad_nonce");

  // An aged nonce now reads as `bad_nonce` rather than `expired`, because the nonce is taken and
  // checked FIRST - it has to be, so that a failed attempt consumes it. Both windows are the same
  // ten minutes anyway, so the two conditions arrive together; the code reports whichever it
  // reaches, and it reaches the nonce.
  let t = Date.now();
  const n2 = nonceStore({ now: () => t });
  const nonce = n2.issue(acct.address);
  const m2 = siweMessage({ address: acct.address, nonce, ...P }).message;
  n2.bind(nonce, m2);
  t += 11 * 60_000;
  const s2 = await acct.signMessage({ message: m2 });
  const aged = await verifyLogin({ message: m2, signature: s2, nonces: n2, ...P, verifyMessage, now: t });
  assert.equal(aged.error, "bad_nonce");
  assert.equal(aged.address, undefined);
  assert.equal(n2.take(nonce), null, "and it is gone, so no replay with a fresh message either");
});

test("A MESSAGE THIS BOX DID NOT ISSUE IS NOT A LOGIN, however well it parses", async () => {
  // The audit's finding. Validating each field only IF PRESENT looks conservative - it cannot lock
  // out a format we never emitted - and what it actually permits is a signature over something the
  // user was never shown. An arbitrary sentence, an address line and a FRESH, GENUINE nonce:
  // no domain, no URI, no chain, no statement of purpose. ERC-4361 requires those fields precisely
  // so that what is signed says who is asking and what for.
  const n = nonceStore();
  const nonce = n.issue(acct.address);
  n.bind(nonce, siweMessage({ address: acct.address, nonce, ...P }).message);
  const forged = `Please confirm you are you.\n${acct.address}\n\nNonce: ${nonce}\n`;
  const signature = await acct.signMessage({ message: forged });
  const r = await verifyLogin({ message: forged, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.address, undefined, "this must NOT sign anybody in");
  assert.equal(r.error, "invalid_message");
});

test("even a single altered character in the issued message is refused", async () => {
  for (const tamper of [
    (m) => m.replace("Sign in to Enclave.", "Sign in to Enclave!"),
    (m) => m + "\nextra: line",
    (m) => m.replace("Version: 1", "Version: 2"),
    (m) => m.replace(/Issued At: \S+/, "Issued At: 2020-01-01T00:00:00.000Z"),
    (m) => m.replace("Chain ID: 8453", "Chain ID: 8453 "),
  ]) {
    const r = await login(nonceStore(), { tamper });
    assert.equal(r.error, "invalid_message", "the signed message must be the one we issued");
  }
});

test("trailing whitespace alone does not lock a legitimate client out", async () => {
  const r = await login(nonceStore(), { tamper: (m) => m + "\n" });
  assert.equal(r.address, acct.address.toLowerCase());
});

test("a nonce with no challenge behind it refuses rather than falling back to parsing", async () => {
  // There is no safe way to accept a message whose fields nobody issued, so a store that kept no
  // challenge refuses instead of reverting to the permissive parse.
  const n = nonceStore();
  const nonce = n.issue(acct.address);              // deliberately NOT bound
  const { message } = siweMessage({ address: acct.address, nonce, ...P });
  const signature = await acct.signMessage({ message });
  const r = await verifyLogin({ message, signature, nonces: n, ...P, verifyMessage });
  assert.equal(r.error, "invalid_message");
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
