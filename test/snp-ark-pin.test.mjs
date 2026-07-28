// The AMD root of trust is PINNED, not merely self-consistent.
//
// SEV-SNP verification ends at "the ARK is self-signed", which proves the served
// chain hangs together and nothing more — whoever answers for the cert_chain
// endpoint gets to BE the root. That put the whole hardware-attestation argument
// on TLS to one host: anyone who can answer for kdsintf.amd.com (a mis-issued
// cert, a hijacked route, a rogue CA in the local trust store) serves a
// fabricated ARK+ASK, signs a VCEK for a report they wrote, and both verifiers
// print ✓ down the line. Pinning makes that "compromise KDS AND this repo".
//
// The fixtures are the REAL AMD chains as published by KDS. Milan and Genoa are
// byte-identical to google/go-sev-guest's embedded copies (verify/trust/
// ask_ark_*.pem) — a different host, a different TLS chain, a different party —
// which is what makes the pins corroborated rather than trust-on-first-use.
// Turin has no such second source published yet.
//
//   run: node --test test/snp-ark-pin.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AMD_ARK_SHA256, isPinnedArk, certChain } from "../relay/snp-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const chainPem = (p) => fs.readFileSync(path.join(HERE, "fixtures", "amd", `${p}-cert_chain.pem`), "utf8");
const certsOf = (pem) => pem.split(/(?=-----BEGIN CERTIFICATE-----)/)
  .filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));

const PRODUCTS = ["Milan", "Genoa", "Turin"];

test("every pin is the real AMD root for its product line", () => {
  for (const p of PRODUCTS) {
    const chain = certsOf(chainPem(p));
    const ark = chain[chain.length - 1];
    assert.match(ark.subject, new RegExp(`CN=ARK-${p}`), `${p}: fixture's last cert must be the ARK`);
    assert.ok(ark.verify(ark.publicKey), `${p}: ARK must be self-signed`);
    assert.ok(isPinnedArk(ark, p), `${p}: the pinned sha256 must be this ARK's`);
    // and the intermediate chains to it, i.e. the fixture is a real chain
    assert.ok(chain[0].verify(ark.publicKey), `${p}: ASK must chain to the ARK`);
  }
  assert.equal(AMD_ARK_SHA256.size, PRODUCTS.length);
});

test("a root that is not the pin is refused, however well-formed", () => {
  // The attack shape: a self-consistent chain from a root the attacker owns.
  // Standing in for it is another product line's REAL AMD root — genuinely
  // self-signed, genuinely AMD's, and still not the root for this product, so a
  // "some AMD root will do" bug fails here too.
  const milanArk = certsOf(chainPem("Milan")).at(-1);
  const genoaArk = certsOf(chainPem("Genoa")).at(-1);
  assert.equal(isPinnedArk(milanArk, "Genoa"), false, "Milan's root must not satisfy Genoa");
  assert.equal(isPinnedArk(genoaArk, "Milan"), false);
  // an intermediate is not a root
  assert.equal(isPinnedArk(certsOf(chainPem("Milan"))[0], "Milan"), false);
  // an unknown product line has no pin, so nothing can satisfy it (fail CLOSED:
  // the product name is read out of the peer's own VCEK issuer, so accepting an
  // unpinned root with a warning would be the bypass this closes)
  assert.equal(isPinnedArk(milanArk, "Venice"), false);
});

test("certChain refuses — and does not cache — a chain that is not AMD's", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // Serve Genoa's real chain when Milan is asked for: a perfectly valid AMD
  // chain, for the wrong root. This drives the REAL fetch + pin + cache path,
  // through a REAL Response so the streamed, size-capped reader is the one that
  // runs rather than a hand-rolled stand-in for it.
  globalThis.fetch = async () => { calls++; return new Response(Buffer.from(chainPem("Genoa"), "utf8")); };
  try {
    await assert.rejects(() => certChain("Milan"), /not AMD's pinned root/);
    // a refused chain must NOT be remembered as this product's: the next call
    // re-asks (a cached bad hit would make one bad answer permanent)
    await assert.rejects(() => certChain("Milan"), /not AMD's pinned root/);
    assert.equal(calls, 2, "the refused chain must not have been cached");

    // and the honest case still resolves + caches
    globalThis.fetch = async () => { calls++; return new Response(Buffer.from(chainPem("Turin"), "utf8")); };
    const chain = await certChain("Turin");
    assert.equal(chain.length, 2);
    const before = calls;
    await certChain("Turin");
    assert.equal(calls, before, "a verified chain is cached");
  } finally { globalThis.fetch = realFetch; }
});

test("both verifiers share ONE pin table", () => {
  // A second copy is a second thing to update when AMD adds a product line, and
  // the copy that gets forgotten is the one that fails open. metal/verify.mjs is
  // the BUYER's tool - the place where a silently-unpinned root matters most.
  const src = fs.readFileSync(path.join(REPO, "metal", "verify.mjs"), "utf8");
  assert.match(src, /import\s*\{[^}]*isPinnedArk[^}]*\}\s*from\s*"\.\.\/relay\/snp-verify\.mjs"/,
    "metal/verify.mjs must import the predicate, not re-declare it");
  assert.doesNotMatch(src, /ARK_SHA256\s*=\s*new Map/, "no second pin table");
  assert.match(src, /isPinnedArk\(ark,\s*which\)/, "and it must actually check the served root");
  // the relay side enforces inside certChain, so every caller inherits it
  const relay = fs.readFileSync(path.join(REPO, "relay", "snp-verify.mjs"), "utf8");
  assert.match(relay, /if \(!ark \|\| !isPinnedArk\(ark, product\)\)/);
});

test("an oversized KDS body is refused rather than read into memory", async () => {
  // Answering for KDS is the position the pin already assumes is reachable, so
  // the cheapest attack from there is not a forged cert at all - it is an
  // endless body. A VCEK is ~1.3 KB and a cert_chain ~5 KB; anything near the
  // cap is broken or hostile either way.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.alloc(512 * 1024, 0x41));
  try {
    await assert.rejects(() => certChain("Milan"), /exceeds the \d+-byte cap/);
  } finally { globalThis.fetch = realFetch; }
});
