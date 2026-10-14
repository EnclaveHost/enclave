// A domain running another version of its deployment is not adopted (windows/node/isolation-client.mjs staleVersion,
// used by host.mjs before reconcile): an owner's setAppRef to a new catalog version or component replaces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IsolationManagerClient } from "../windows/node/isolation-client.mjs";

const APP = "0x" + "f1".repeat(32), NAME = "0x" + "38".repeat(32);
const client = (rows) => ({ findByName: async (n) => rows.find((r) => r.name === n) || null });
const derive = (version, cid = "bafy-v" + version) => ({ catalog: { app: APP, version }, cid });

test("the same version is adopted; another version, app or component is stale", async () => {
  const running = [{ id: "hvold", name: NAME, catalog: { app: APP, version: 1 }, cid: "bafy-v1" }];
  assert.equal(await IsolationManagerClient.staleVersion(client(running), NAME, derive(1)), null);
  assert.match(await IsolationManagerClient.staleVersion(client(running), NAME, derive(2)), /^hvold runs version 1 -> 2, component bafy-v1… -> bafy-v2…$/);
  assert.match(await IsolationManagerClient.staleVersion(client(running), NAME, derive(1, "bafy-other")), /component/);
  assert.match(await IsolationManagerClient.staleVersion(client(running), NAME, { catalog: { app: "0x" + "aa".repeat(32), version: 1 }, cid: "bafy-v1" }), /catalog app/);
});

test("nothing running, a manager that does not say its version, or no catalog asked: not second-guessed", async () => {
  assert.equal(await IsolationManagerClient.staleVersion(client([]), NAME, derive(2)), null);
  assert.equal(await IsolationManagerClient.staleVersion(client([{ id: "hv", name: NAME, catalog: null, cid: null }]), NAME, derive(2)), null);
  assert.equal(await IsolationManagerClient.staleVersion(client([{ id: "hv", name: NAME, catalog: { app: APP, version: 1 } }]), NAME, {}), null);
});
