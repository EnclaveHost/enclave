// A private deployment is served to its owner and nobody else — and only taken at all when this
// box can prove who is asking.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Host } from "../windows/node/host.mjs";
import { claimPolicy } from "../windows/node/chain.mjs";
import { initSessionKey, mint, addressFor, appAudience, APP_COOKIE } from "../windows/node/session.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-priv-"));
const key = initSessionKey({ dir });
const OWNER = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const STRANGER = "0x1111111111111111111111111111111111111111";
const ENCLAVE = "0x" + "ee".repeat(32);
const ID = "0x" + "ab".repeat(32);
const roomy = { slots: 4, slotsFree: 3, cpuShareFree: 0.75, ramMbFree: 81920, cpuGflops: 1000,
                gpuShareFree: 0.9, cardGb: 8 };
const dep = (o = {}) => ({ id: ID, owner: OWNER, appRef: "catalog://0x" + "cd".repeat(32) + "/1",
  configCid: "", gpuMilli: 0, cpuMilli: 10, isPublic: true, active: true,
  createdAt: 1, leaseUntil: 0, runner: "0x" + "0".repeat(64), ...o });
const ctx = (o = {}) => ({ ownerAllow: OWNER, enclaveId: ENCLAVE, appsEnabled: true, capacity: roomy, ...o });
const version = (o = {}) => ({ cid: "bafy", version: "1.0.0", memMb: 512, cpuGflops: 10, config: "",
                               approval: 1, yanked: false, ...o });

test("a private deployment is refused when this box cannot prove who is asking", () => {
  const r = claimPolicy(dep({ isPublic: false }), ctx({ privateOk: false }));
  assert.match(String(r), /no session key to verify its owner with/);
});

test("...and taken when it can", () => {
  assert.equal(claimPolicy(dep({ isPublic: false }), ctx({ privateOk: true })), null);
});

test("devDeploy: a PENDING version runs on a private deployment, never on a public one", () => {
  const pending = version({ approval: 0 });
  // A stranger's public deployment of a pending version stays refused, here as on the fleet.
  assert.match(String(claimPolicy(dep({ owner: STRANGER }), ctx({ privateOk: true, version: pending }))),
               /awaiting the catalog owner's approval/);
  // A PRIVATE one is the publisher testing their own app.
  assert.equal(claimPolicy(dep({ owner: STRANGER, isPublic: false }), ctx({ privateOk: true, version: pending })), null);
  // ...and without a session key it is refused for the same reason a private deployment is.
  assert.match(String(claimPolicy(dep({ owner: STRANGER, isPublic: false }), ctx({ privateOk: false, version: pending }))),
               /no session key/);
  // A REJECTED or YANKED version is refused whatever else is true.
  assert.match(String(claimPolicy(dep({ isPublic: false }), ctx({ privateOk: true, version: version({ approval: 2 }) }))),
               /rejected by the catalog owner/);
  assert.match(String(claimPolicy(dep({ isPublic: false }), ctx({ privateOk: true, version: version({ yanked: true }) }))),
               /yanked by its publisher/);
});

// ---- the data path -----------------------------------------------------------------------

function box() {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, sessionKid: key.kid });
  return h;
}

test("privateOwner answers only for a deployment this box knows to be private", () => {
  const h = box();
  assert.equal(h.privateOwner(ID), null, "a deployment we do not hold is not ours to call private");
  h.records.set(ID, { id: ID, status: "running", isPublic: true, owner: OWNER.toLowerCase() });
  assert.equal(h.privateOwner(ID), null, "a public one needs no gate");
  h.records.set(ID, { id: ID, status: "running", isPublic: false, owner: OWNER.toLowerCase() });
  assert.equal(h.privateOwner(ID), OWNER.toLowerCase());
});

test("the owner gets in with a session; a stranger and an anonymous caller do not", () => {
  const owner = mint(key, { subject: OWNER, ttlSec: 600 });
  const stranger = mint(key, { subject: STRANGER, ttlSec: 600 });
  assert.equal(addressFor(key, { authorization: `Bearer ${owner}` }, ID), OWNER.toLowerCase());
  assert.equal(addressFor(key, { authorization: `Bearer ${stranger}` }, ID), STRANGER.toLowerCase());
  assert.equal(addressFor(key, {}, ID), null);
  assert.equal(addressFor(key, { authorization: "Bearer not-a-token" }, ID), null);
  // The gate compares the recovered address to the record's owner; a stranger's VALID token is
  // still not this deployment's owner.
  assert.notEqual(addressFor(key, { authorization: `Bearer ${stranger}` }, ID), OWNER.toLowerCase());
});

test("a browser reaches a private app with the app-origin cookie, bound to that deployment", () => {
  const cookie = mint(key, { subject: OWNER, audience: appAudience(ID), ttlSec: 600 });
  assert.equal(addressFor(key, { cookie: `${APP_COOKIE}=${cookie}` }, ID), OWNER.toLowerCase());
  const elsewhere = "0x" + "cd".repeat(32);
  assert.equal(addressFor(key, { cookie: `${APP_COOKIE}=${cookie}` }, elsewhere), null,
    "a cookie for one deployment must not open another on the same box");
});

test("a box with no session key advertises neither private deployments nor devDeploy", () => {
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test",
                       appsEnabled: true, cpuPricePerSec6: 12, log: () => {} });
  assert.equal(h.features().devDeploy, false);
  assert.equal(h.availability().session, null);
  assert.equal(box().features().devDeploy, true);
  assert.equal(box().availability().session.keyIn, "host-process",
    "and where the key lives is published, not implied");
});
