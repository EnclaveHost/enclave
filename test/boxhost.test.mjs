// The naming scheme for self-hosted (tunnel-attached) enclaves. These pin the
// three properties the scheme exists for — a box's name must not be able to
// collide with a platform subdomain, be squatted by another operator, or be
// shaped like a human word someone could phish with — plus the one property
// that makes it implementable: a name resolves to an operator with a single
// registry read, no scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxLabel, boxHostOf, boxOrigin, isBoxHost, boxLabelOfHost, boxZone } from "../relay/boxhost.js";

const ZONE = "box.enclave.host";
const OP_A = "0x390e2e0e0bc34b7f428f1e31c9b6770d5028ecc1";
const OP_B = "0x" + "bb".repeat(20);

test("a minted label is e + 16 hex, never the seller's string", async () => {
  const l = await boxLabel(OP_A, "metal0", ZONE);
  assert.match(l, /^e[0-9a-f]{16}$/);
  assert.ok(!l.includes("metal0"), "the friendly name must not survive into the identity");
  assert.equal(await boxLabel(OP_A, "metal0", ZONE), l, "derivation is deterministic");
});

test("the seller cannot land on a platform subdomain, whatever they call the box", async () => {
  // The objection this scheme answers: names are seller-supplied, and app/api/
  // www/mcp are real hosts. Two defenses, and BOTH must hold — the dedicated
  // zone, and a label that is never the seller's string in the first place.
  for (const evil of ["app", "api", "www", "mcp", "enclave"]) {
    const host = boxHostOf(await boxLabel(OP_A, evil, ZONE), ZONE);
    assert.ok(host.endsWith("." + ZONE), "every box name lives under the box zone");
    assert.ok(!/^(app|api|www|mcp|enclave)\./.test(host), `"${evil}" must not become a bare subdomain`);
  }
});

test("no phishable label can exist in the zone", async () => {
  // Even inside a dedicated zone, support.box.enclave.host would be a problem.
  // Minted labels are e + hex, so no word-shaped name is reachable at all.
  for (const word of ["support", "official", "billing", "admin"])
    assert.equal(isBoxHost(`${word}.${ZONE}`, ZONE), false, `${word}.${ZONE} must not read as one of ours`);
  assert.equal(isBoxHost(boxHostOf(await boxLabel(OP_A, "support", ZONE), ZONE), ZONE), true,
    "…while a properly minted box IS recognized");
});

test("two operators who pick the same friendly name get different boxes", async () => {
  const a = await boxLabel(OP_A, "metal0", ZONE);
  const b = await boxLabel(OP_B, "metal0", ZONE);
  assert.notEqual(a, b, "the operator address is in the preimage: no cross-operator squatting");
});

test("one operator's boxes are distinct, and the label is the whole identity", async () => {
  assert.notEqual(await boxLabel(OP_A, "metal0", ZONE), await boxLabel(OP_A, "metal1", ZONE));
  // The registry id is keccak(origin) and the origin is computable from the
  // attach name ALONE — this is what keeps name->operator a single get()
  // instead of a scan over every registered enclave.
  const l = await boxLabel(OP_A, "metal0", ZONE);
  assert.equal(boxOrigin(l, ZONE), `https://${l}.${ZONE}`);
  assert.equal(boxLabelOfHost(`${l}.${ZONE}`, ZONE), l, "the host round-trips back to the attach name");
});

test("a host outside the zone is never ours, however it is dressed", () => {
  const minted = "e0123456789abcdef";
  assert.equal(isBoxHost(`${minted}.evil.example`, ZONE), false);
  assert.equal(isBoxHost(`${minted}.${ZONE}.evil.example`, ZONE), false, "zone must be the SUFFIX, not a substring");
  assert.equal(isBoxHost(`sub.${minted}.${ZONE}`, ZONE), false, "no nesting under a minted label");
  assert.equal(isBoxHost(ZONE, ZONE), false, "the apex itself is not a box");
  // trailing dot and :port are normal in a Host header and must not fool it
  assert.equal(isBoxHost(`${minted}.${ZONE}.`, ZONE), true);
  assert.equal(isBoxHost(`${minted}.${ZONE}:443`, ZONE), true);
  assert.equal(isBoxHost(`E0123456789ABCDEF.${ZONE.toUpperCase()}`, ZONE), true, "Host case is not significant");
});

test("bad input yields no name rather than a wrong one", async () => {
  assert.equal(await boxLabel(OP_A, "metal0", null), null, "no zone configured = scheme off, not a bare label");
  assert.equal(await boxLabel("not-an-address", "metal0", ZONE), null);
  assert.equal(await boxLabel(OP_A, "", ZONE), null, "an empty name would collide every box onto one host");
  assert.equal(await boxLabel(OP_A, "a.b", ZONE), null, "a dot would silently add a namespace level");
  assert.equal(await boxLabel(OP_A, "x".repeat(65), ZONE), null);
  assert.equal(boxHostOf("metal0", ZONE), null, "an unminted label has no host");
  assert.equal(boxZone({}), null, "unset BOX_ZONE reads as off");
  assert.equal(boxZone({ BOX_ZONE: ".Box.Enclave.Host." }), ZONE, "zone is normalized, not trusted verbatim");
});

test("the operator address is compared as bytes, not as text", async () => {
  // A checksummed address and its lowercase form are the SAME operator; if the
  // preimage were the string, one box would answer on two different hosts and
  // its registry id would depend on how the config happened to be typed.
  const mixed = "0x390E2E0E0bc34b7F428f1E31c9b6770d5028ECC1";
  assert.equal(await boxLabel(mixed, "metal0", ZONE), await boxLabel(OP_A, "metal0", ZONE));
});
