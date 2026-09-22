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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// THE PRODUCTION ARTICLE, not a copy of it. A test that reimplements the parser proves the copy
// works and goes green while the real one drifts.
import { parseAbiReply, featureFlags } from "../windows/node/appframe.mjs";
import { Host } from "../windows/node/host.mjs";

const readAbi = parseAbiReply;
const flags = featureFlags;

/** The real Host.features(), asked of a box whose enclave reported this bitmask. */
function boxFlags(features) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-abi-"));
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
                       enclaveAppAbi: 5, enclaveAppWorlds: 7, enclaveAppFeatures: features });
  const f = h.features();
  return { mem64: f.mem64, set: f.set, p3: f.p3, coopThreads: f.coopThreads };
}

test("an OLD enclave answering two words advertises no features at all", () => {
  const r = readAbi("4 7");
  assert.equal(r.abi, 4);
  assert.equal(r.worlds, 7, "the worlds it does report are still read");
  assert.equal(r.features, 0, "a missing third word is NOT a wildcard");
  assert.deepEqual(flags(r.features), { mem64: false, set: false, p3: false, coopThreads: false },
    "every capability reads as absent, so the box sells less than it can do rather than more");
  assert.deepEqual(boxFlags(r.features), { mem64: false, set: false, p3: false, coopThreads: false },
    "and the BOX itself advertises none of them - this is what the fleet reads");
});

test("a current enclave's features are read, and only the bits it set", () => {
  const r = readAbi("5 7 1");
  assert.equal(r.features, 1);
  assert.deepEqual(flags(r.features), { mem64: true, set: false, p3: false, coopThreads: false });
  assert.deepEqual(boxFlags(r.features), { mem64: true, set: false, p3: false, coopThreads: false },
    "the box advertises exactly the bits its enclave set, through the real features()");
  // set:true is the one that must stay false until Pulley has atomic instructions. A box that
  // advertised it would take a lease on an app it then cannot compile.
  assert.equal(flags(readAbi("5 7 1").features).set, false);
});

test("garbage in the features word is not a capability", () => {
  for (const reply of ["5 7 nonsense", "5 7 -1", "5 7 ", "5 7 NaN"]) {
    const f = flags(readAbi(reply).features);
    assert.equal(f.set, false, `${JSON.stringify(reply)} must not sell shared-everything threads`);
    assert.equal(f.p3, false, `${JSON.stringify(reply)} must not sell wasip3`);
    assert.equal(boxFlags(readAbi(reply).features).set, false, `${JSON.stringify(reply)}: nor may the box`);
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
  assert.deepEqual(boxFlags(r.features), { mem64: false, set: false, p3: false, coopThreads: false });
});

test("the bit MEANINGS are the runtime's, and the box reads them the same way", () => {
  // If windows/enclave-rt/src/lib.rs renumbers a bit, this is what catches it: the node's map and
  // the runtime's constants have to agree, and only one of them is in this repo's JS.
  assert.deepEqual(flags(1), { mem64: true, set: false, p3: false, coopThreads: false });
  assert.deepEqual(flags(2), { mem64: false, set: true, p3: false, coopThreads: false });
  assert.deepEqual(flags(4), { mem64: false, set: false, p3: true, coopThreads: false });
  assert.deepEqual(flags(8), { mem64: false, set: false, p3: false, coopThreads: true });
  assert.deepEqual(flags(15), { mem64: true, set: true, p3: true, coopThreads: true });
  // ...and the box agrees, through its own features().
  assert.deepEqual(boxFlags(15), { mem64: true, set: true, p3: true, coopThreads: true });
});
