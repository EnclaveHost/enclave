// The ABI query is a HANDSHAKE, and both directions of version mismatch must fail closed.
//
// The enclave gate answers `appabi` with "<abi> <worlds> <features>". The features word is new: an
// older enclave image answers with two words, and an older HOST binary hands the enclave a
// two-word buffer. Neither may produce a box that advertises a capability its image does not have,
// and neither may produce an out-of-bounds write.
//
// The C half of that contract (EE_ABI_QUERY_MAGIC, windows/enclave-engine/ee-rt.h) is tested by
// build: the enclave writes only as many words as the caller declared it owns. This file tests the
// JS half - how the node reads the reply - because that is what decides what the box SELLS.
import { test } from "node:test";
import assert from "node:assert/strict";

/** Exactly agent.mjs's parse of the `appabi` reply. */
function readAbi(reply) {
  const [abiStr, worldsStr, featStr] = String(reply).trim().split(/\s+/);
  const abi = Number(abiStr) || 0;
  const feat = Number(featStr);
  return { abi, worlds: Number(worldsStr) || (abi >= 1 ? 1 : 0),
           features: Number.isInteger(feat) && feat >= 0 ? feat : 0 };
}

/** Exactly host.mjs features(): the platform capability flags, off the bitmask and nothing else. */
const flags = (features) => ({
  mem64: !!(Number(features) & 1), set: !!(Number(features) & 2),
  p3: !!(Number(features) & 4), coopThreads: !!(Number(features) & 8),
});

test("an OLD enclave answering two words advertises no features at all", () => {
  const r = readAbi("4 7");
  assert.equal(r.abi, 4);
  assert.equal(r.worlds, 7, "the worlds it does report are still read");
  assert.equal(r.features, 0, "a missing third word is NOT a wildcard");
  assert.deepEqual(flags(r.features), { mem64: false, set: false, p3: false, coopThreads: false },
    "every capability reads as absent, so the box sells less than it can do rather than more");
});

test("a current enclave's features are read, and only the bits it set", () => {
  const r = readAbi("5 7 1");
  assert.equal(r.features, 1);
  assert.deepEqual(flags(r.features), { mem64: true, set: false, p3: false, coopThreads: false });
  // set:true is the one that must stay false until Pulley has atomic instructions. A box that
  // advertised it would take a lease on an app it then cannot compile.
  assert.equal(flags(readAbi("5 7 1").features).set, false);
});

test("garbage in the features word is not a capability", () => {
  for (const reply of ["5 7 nonsense", "5 7 -1", "5 7 ", "5 7 NaN"]) {
    const f = flags(readAbi(reply).features);
    assert.equal(f.set, false, `${JSON.stringify(reply)} must not sell shared-everything threads`);
    assert.equal(f.p3, false, `${JSON.stringify(reply)} must not sell wasip3`);
  }
  // "-1" is the one worth spelling out. It PARSES as a number, and every bitwise test downstream
  // would then be true - the box would advertise shared-everything threads off a reply that says
  // nothing of the kind. The enclave cannot send it today (ee_rt_features returns a u32 the host
  // prints with %u), but "the only writer is trusted" is not a reason to parse loosely when the
  // value decides what gets sold. It reads as no features.
  assert.equal(flags(readAbi("5 7 -1").features).mem64, false);
  assert.equal(flags(readAbi("5 7 -1").features).set, false);
  // A fractional word is not a bitmask either.
  assert.deepEqual(flags(readAbi("5 7 1.5").features), { mem64: false, set: false, p3: false, coopThreads: false });
});

test("a reply that is not a number at all leaves the box selling nothing", () => {
  const r = readAbi("err no app runtime");
  assert.equal(r.abi, 0);
  assert.equal(r.features, 0);
  assert.deepEqual(flags(r.features), { mem64: false, set: false, p3: false, coopThreads: false });
});
