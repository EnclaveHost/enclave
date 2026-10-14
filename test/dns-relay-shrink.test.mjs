// relay/dns-relay.js: a route map that suddenly loses most labels (the relay restarting) does not take the apps off DNS
// until a later poll confirms it; a small change applies at once. Driven as a real daemon (see dns-relay.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = (a) => ({ expiresAt: Date.now() + 600000, transport: "enclave-network", addresses: [a] });
const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a sudden drop of most labels is held until a poll confirms it; a small change applies at once", async (t) => {
  let labels = { a1: label("198.51.100.1"), a2: label("198.51.100.2"), a3: label("198.51.100.3"), a4: label("198.51.100.4") };
  const map = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ labels })); });
  map.listen(0, "127.0.0.1"); await once(map, "listening");
  t.after(() => map.close());
  let p, apiPort;
  for (let attempt = 0; attempt < 3 && !p; attempt++) {
    apiPort = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, "relay", "dns-relay.js")], {
      env: { ...process.env, IP_ZONE: "ip.test", APP_ZONE: "app.test", NS_NAME: "ns1.test", ENCLAVES: "https://example.invalid",
             DNS_PORT: String(await freePort()), DNS_API_PORT: String(apiPort), DNS_API_BIND: "127.0.0.1", DNS_TXT_KEY: "11".repeat(32),
             ROUTE_MAP_URL: `http://127.0.0.1:${map.address().port}/v1/network/routes`, NET_POLL_SEC: "1", ROUTE_SHRINK_CONFIRM_MS: "3000" },
      stdio: "ignore" });
    for (let i = 0; i < 100 && child.exitCode == null; i++) {
      const j = await fetch(`http://127.0.0.1:${apiPort}/health`).then((r) => r.json()).catch(() => null);
      if (j?.zones?.app === "app.test" && j.routeLabels === 4) { p = child; break; }
      await sleep(100);
    }
    if (!p) child.kill("SIGKILL");
  }
  assert.ok(p, "dns-relay came up");
  t.after(() => p.kill("SIGKILL"));
  const count = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/health`)).json()).routeLabels;

  const all = labels;
  labels = { a1: all.a1 };                                     // the relay restarts: 4 -> 1
  await sleep(1300);
  assert.equal(await count(), 4, "held while unconfirmed");
  labels = { a1: all.a1, a2: all.a2, a3: all.a3 };             // ... and refills its map: 3 of 4
  await sleep(1300);
  assert.equal(await count(), 4, "still held while the relay refills");
  labels = { a1: all.a1 };
  await sleep(3500);
  assert.equal(await count(), 1, "a drop that persists is applied");

  labels = { a1: labels.a1, a2: label("198.51.100.2") };
  await sleep(1800);
  assert.equal(await count(), 2);
  labels = { a1: labels.a1 };                                  // 2 -> 1: an app going away, not a restart
  await sleep(1800);
  assert.equal(await count(), 1, "losing half or less applies at once");
});
