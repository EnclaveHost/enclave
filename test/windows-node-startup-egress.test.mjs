// startupEgressReady: an app whose privacy config asks for startup egress gets its sealed secrets only once its private
// route is up. A host whose TUNA agent has not enrolled yet has NO privacy config (tuna-enroll writes it with the first
// app), and that must not hold every secrets app (2026-10-12: nucbox-k11-4's first claim sat "pending: ENOENT").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startupEgressReady } from "../windows/node/startup-egress.mjs";

const ID = "0x" + "ab".repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-egress-"));
const configFile = path.join(dir, "privacy-config.json"), routeFile = path.join(dir, "egress-routes.json");

test("no privacy config yet: nothing waits", () => {
  assert.equal(startupEgressReady(ID, { configFile, routeFile }), true);
});

test("an app configured for startup egress waits for its route, then goes", () => {
  fs.writeFileSync(configFile, JSON.stringify({ version: 2, apps: [{ deploymentId: ID, startupEgress: true }] }));
  assert.throws(() => startupEgressReady(ID, { configFile, routeFile }));              // no routes file yet: pending
  const now = Date.now();
  fs.writeFileSync(routeFile, JSON.stringify({ version: 1, expiresAt: now + 60_000, apps: { [ID]: { proxies: ["127.0.0.1:9050"] } } }));
  assert.equal(startupEgressReady(ID, { configFile, routeFile, now }), true);
  fs.writeFileSync(routeFile, JSON.stringify({ version: 1, expiresAt: now + 60_000, apps: {} }));
  assert.equal(startupEgressReady(ID, { configFile, routeFile, now }), false);
});

test("an app the config does not name never waits", () => {
  assert.equal(startupEgressReady("0x" + "cd".repeat(32), { configFile, routeFile }), true);
});
