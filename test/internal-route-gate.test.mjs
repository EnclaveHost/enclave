// /internal/* must be reachable only from the box itself — and "loopback" is
// not that test on a box with a proxy in front of it.
//
// FOUND IN PRODUCTION 2026-07-30. The gate read req.socket.remoteAddress, which
// is 127.0.0.1 for every request Caddy forwards, so a public curl of
//   https://api.enclave.host/internal/tls-ask?domain=<host>
// was answered: 200 for a real deployment subdomain, 400 for junk. That is an
// unauthenticated existence oracle, and once custom domains could be asked
// about, a "which hostnames does this platform serve" oracle — the exact
// cross-tenant disclosure the domains API refuses by design.
//
// The discriminator under test: Caddy GENERATES its on-demand `ask` request, so
// it carries no forwarding headers, while anything it PROXIES carries them. A
// request that looks proxied is refused even from loopback.
//
//   run: node --test test/internal-route-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { bootDaemon } from "./helpers/daemon.mjs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");

async function startRelay(t, env = {}) {
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port),
             API_RELAY_BIND: "127.0.0.1", RPC_FALLBACKS: "0",
             FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-gate-${port}.json`), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => child.kill("SIGKILL"));
  return `http://127.0.0.1:${port}`;
}

const ask = (origin, domain, headers = {}) =>
  fetch(`${origin}/internal/tls-ask?domain=${encodeURIComponent(domain)}`, { headers })
    .then((r) => r.status);

test("a request that looks PROXIED is refused, even arriving from loopback", async (t) => {
  const origin = await startRelay(t);
  // the shape a public request has after Caddy forwards it: loopback socket,
  // forwarding headers attached
  for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
                   "x-forwarded-port", "x-real-ip", "forwarded", "via"]) {
    const status = await ask(origin, "cc1f4f3f.app.enclave.host", { [h]: "203.0.113.7" });
    assert.equal(status, 403, `${h} present should be refused`);
  }
  // …and the header alone does it: the same request without them gets past the
  // gate (whatever it then answers about the domain is a different question)
  const clean = await ask(origin, "cc1f4f3f.app.enclave.host");
  assert.notEqual(clean, 403, "Caddy's own ask carries no forwarding headers and must still work");
});

test("no answer about ANY hostname leaks to a proxied caller", async (t) => {
  const origin = await startRelay(t);
  // the disclosure that mattered: attached vs not, ours vs not, real vs junk —
  // every one of them must be the same 403, carrying nothing
  const proxied = { "x-forwarded-for": "198.51.100.4" };
  const seen = new Set();
  for (const d of ["cc1f4f3f.app.enclave.host", "enclave.host", "shop.example.com",
                   "definitely-not-attached.example.org", "", "not a hostname"]) {
    const r = await fetch(`${origin}/internal/tls-ask?domain=${encodeURIComponent(d)}`, { headers: proxied });
    seen.add(`${r.status}:${(await r.text()).trim()}`);
  }
  assert.deepEqual([...seen], ["403:forbidden"], "the refusal must be identical for every input");
});

test("INTERNAL_TOKEN replaces the heuristic with a credential", async (t) => {
  const TOKEN = "s3cr3t-internal-token";
  const origin = await startRelay(t, { INTERNAL_TOKEN: TOKEN });
  // with a token configured, absence of forwarding headers is no longer enough
  assert.equal(await ask(origin, "cc1f4f3f.app.enclave.host"), 403, "no token presented");
  assert.equal(await ask(origin, "cc1f4f3f.app.enclave.host", { "x-internal-token": "wrong" }), 403);
  // …and a wrong-LENGTH token must not throw inside the constant-time compare
  assert.equal(await ask(origin, "cc1f4f3f.app.enclave.host", { "x-internal-token": "x" }), 403);
  assert.notEqual(await ask(origin, "cc1f4f3f.app.enclave.host", { "x-internal-token": TOKEN }), 403);
});
