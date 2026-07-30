// relay/relay.js — the SNI passthrough, driven as a real daemon, for the two
// things bring-your-own-domains added to it:
//
//   (1) the custom-domain routing map it polls from the api-relay, and
//   (2) the plaintext HTTP port, which now answers a redirect instead of
//       resetting the connection.
//
// (2) is the one under test here, because it is the only half whose whole
// conversation happens in cleartext on a socket a test can hold. It is also
// where a mistake is most expensive: the response echoes a client-supplied Host
// into a Location header, so a bare LF smuggled through the request line would
// let a client write its own response headers. There is no seam short of
// running the daemon — the module binds sockets at import.
//
//   run: node --test test/custom-domain-routing.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DOMAIN = "app.test";
const CUSTOM = "shop.example.com";
const DEP = "0x" + "cc1f4f3f" + "cd".repeat(28);

let proc, httpPort, mapServer, mapPort, mapHits = 0;

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// A stand-in api-relay serving just /v1/domains/map — the one thing relay.js
// reads from it, with no credential, because every hostname in that map is
// already public in DNS and in the CT logs.
async function startMap() {
  mapServer = http.createServer((req, res) => {
    mapHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ zone: APP_DOMAIN, domains: {
      [CUSTOM]: DEP,
      // entries relay.js must DROP: a name in our own zone (a bad map must not
      // be able to shadow the suffix rules) and a malformed deployment id
      ["evil." + APP_DOMAIN]: DEP,
      "bad.example.com": "not-an-id",
    } }));
  });
  await new Promise((r) => mapServer.listen(0, "127.0.0.1", r));
  mapPort = mapServer.address().port;
}

// Send a raw request and read the whole reply. The daemon speaks TLS on every
// other port; on the redirect port it must speak enough HTTP to answer.
function raw(port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    const done = () => resolve(out);
    s.setTimeout(4000, () => { s.destroy(); resolve(out); });
    s.on("connect", () => s.write(payload));
    s.on("data", (d) => (out += d));
    s.on("close", done);
    s.on("error", (e) => (out ? done() : reject(e)));
  });
}

async function boot() {
  httpPort = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, "relay", "relay.js")], {
    env: { ...process.env,
           ENCLAVES: "https://enclave.invalid",       // no fleet needed: nothing here splices
           APP_DOMAIN,
           RELAY_PORTS: String(httpPort),
           REDIRECT_HTTP_PORT: String(httpPort),      // this port IS the plaintext port
           RELAY_BIND: "127.0.0.1",
           DOMAINS_API: `http://127.0.0.1:${mapPort}`,
           NET_POLL_SEC: "60" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  // Ready when it has both bound the port AND read the map — a redirect test
  // that raced the first poll would see 421 for a routed name.
  for (let i = 0; i < 100; i++) {
    if (p.exitCode != null) break;
    if (/custom domains: 1 routed/.test(log)) {
      try {
        const probe = await raw(httpPort, "GET / HTTP/1.1\r\nHost: x.invalid\r\n\r\n");
        if (probe) return { p, log: () => log };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { p.kill("SIGKILL"); } catch {}
  return { p: null, log: () => log };
}

before(async () => {
  await startMap();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await boot();
    if (r.p) { proc = r.p; return; }
    if (attempt === 2) throw new Error(`relay did not come up:\n${r.log()}`);
  }
});
after(() => {
  try { proc.kill("SIGKILL"); } catch {}
  try { mapServer.close(); } catch {}
});

test("the map is read with no credential and filtered on the way in", () => {
  // one poll happened; the boot gate already proved exactly ONE of the three
  // entries survived (a name in our own zone and a malformed id are dropped)
  assert.ok(mapHits >= 1);
});

test("plaintext http on a routed custom domain redirects to https, preserving the path", async () => {
  const r = await raw(httpPort, `GET /cart?item=7 HTTP/1.1\r\nHost: ${CUSTOM}\r\nUser-Agent: t\r\n\r\n`);
  assert.match(r, /^HTTP\/1\.1 301 /);
  assert.match(r, new RegExp(`Location: https://${CUSTOM}/cart\\?item=7\r\n`));
});

test("…and on an app subdomain, which is the same promise", async () => {
  const r = await raw(httpPort, `GET / HTTP/1.1\r\nHost: cc1f4f3f.${APP_DOMAIN}\r\n\r\n`);
  assert.match(r, /^HTTP\/1\.1 301 /);
  assert.match(r, new RegExp(`Location: https://cc1f4f3f\\.${APP_DOMAIN}/\r\n`));
});

test("a hostname we do not route gets 421 and no redirect — this is not a reflector", async () => {
  // "bad.example.com" was IN the map, with a malformed deployment id: dropping
  // it there has to mean it does not route here either
  for (const host of ["unknown.example.org", "bad.example.com"]) {
    const r = await raw(httpPort, `GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    assert.match(r, /^HTTP\/1\.1 421 /, host);
    assert.ok(!/Location:/i.test(r), `${host} was redirected`);
  }
  // …while an unknown label in OUR OWN zone still redirects: the https attempt
  // is where that name gets refused (no cert, no handshake), and sending a
  // browser there is both honest and the only way it can find out
  const ours = await raw(httpPort, `GET / HTTP/1.1\r\nHost: evil.${APP_DOMAIN}\r\n\r\n`);
  assert.match(ours, /^HTTP\/1\.1 301 /);
});

test("the Host and target are validated, not escaped: no response splitting", async () => {
  // A bare LF inside the request line survives a split on CRLF. If the target
  // were echoed unchecked, everything after it would become response headers.
  const split = await raw(httpPort,
    `GET /x\nX-Injected: yes HTTP/1.1\r\nHost: ${CUSTOM}\r\n\r\n`);
  assert.match(split, /^HTTP\/1\.1 400 /);
  assert.ok(!/X-Injected/i.test(split), "smuggled a header through the request target");
  // …and the same through the Host, which is what lands in Location
  const viaHost = await raw(httpPort,
    `GET / HTTP/1.1\r\nHost: ${CUSTOM}\nLocation: https://evil.example\r\n\r\n`);
  assert.ok(!/evil\.example/.test(viaHost), "smuggled a header through the Host");
  // absolute-form targets and junk methods are refused outright
  assert.match(await raw(httpPort, `GET http://other/ HTTP/1.1\r\nHost: ${CUSTOM}\r\n\r\n`), /^HTTP\/1\.1 400 /);
  assert.match(await raw(httpPort, `\x16\x03\x01 not-tls-either\r\n\r\n`), /^HTTP\/1\.1 (400|421) |^$/);
  assert.match(await raw(httpPort, `BADMETHOD! / HTTP/1.1\r\nHost: ${CUSTOM}\r\n\r\n`), /^HTTP\/1\.1 400 /);
  // no Host at all (HTTP/1.0 clients) is a 400, never a guess
  assert.match(await raw(httpPort, "GET / HTTP/1.0\r\n\r\n"), /^HTTP\/1\.1 400 /);
});

test("an oversized head is dropped rather than buffered", async () => {
  const r = await raw(httpPort, `GET / HTTP/1.1\r\nHost: ${CUSTOM}\r\nX-Pad: ${"a".repeat(9000)}\r\n\r\n`);
  assert.equal(r, "", "a head over the cap should be dropped, not answered");
});
