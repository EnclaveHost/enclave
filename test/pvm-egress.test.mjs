// The pVM app's way out, the host half (shielded/anchor/avf/runner/egress.mjs; PVM-CPU.md "Egress"), through real sockets:
// a client speaking for the phone's host app, a fake TUNA (the SOCKS connect and the DoH resolver are injected, and record
// what they were asked), and a local server standing in for the destination. What it pins:
//   - only this launch's token, only for the deployment now served, only on that app's own live route;
//   - names resolve through the route (never the host's resolver); a destination must be public and not port 25, and a
//     name with ANY non-public answer is refused whole; the judged literal is what is dialled;
//   - a failed circuit falls over to the sibling; the per-app caps hold.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createEgressServer, routeFor, destinationRefusal } from "../shielded/anchor/avf/runner/egress.mjs";

const D = "0x" + "f1".repeat(32), TOKEN = "ab".repeat(16);
const DNS = [{ address: "1.1.1.1:443", serverName: "cloudflare-dns.com", path: "/dns-query" }];
function routes(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-egress-")), file = path.join(dir, "egress-routes.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, expiresAt: Date.now() + 30000, apps: { [D]: { proxies: ["127.0.0.1:41001", "127.0.0.1:41002"], dns: DNS } }, ...over }));
  return file;
}
/** A destination: answers "pong <line>" to the first line. */
async function destination() {
  const srv = net.createServer((c) => c.once("data", (b) => c.end(`pong ${b.toString()}`)));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}
async function agent({ file = routes(), current = () => ({ token: TOKEN, deployment: D }), answers = { "svc.example": ["93.184.215.14"] }, failProxy = null, limits } = {}) {
  const dest = await destination();
  const asked = [];
  const srv = createEgressServer({ routesFile: file, current, limits,
    resolve: async (proxy, dns, name) => { asked.push(`resolve ${proxy} ${name} via ${dns[0].serverName}`); if (!answers[name]) throw new Error("NXDOMAIN"); return answers[name]; },
    connect: async (proxy, host, port) => {
      asked.push(`connect ${proxy} ${host} ${port}`);
      if (proxy === failProxy) throw new Error("circuit down");
      return net.connect(dest.address().port, "127.0.0.1");   // whatever was asked: the fake TUNA reaches the test's destination
    } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, asked, close: () => { srv.close(); dest.close(); } };
}
/** One request line; then (on OK) one line of payload. Returns [first answer line, the rest]. */
function ask(port, line, payload = null) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1");
    let buf = "", sent = false;
    c.on("data", (b) => { buf += b; if (!sent && payload !== null && buf.startsWith("OK\n")) { sent = true; c.write(payload); } });
    const done = () => { const i = buf.indexOf("\n"); resolve(i < 0 ? [buf, ""] : [buf.slice(0, i), buf.slice(i + 1)]); };
    c.on("end", done);
    c.setTimeout(3000, () => { c.destroy(); done(); });   // a stream left open where an answer should have closed it fails, fast
    c.on("error", reject);
    c.write(line + "\n");
  });
}

test("this launch's app reaches a public destination through its own route, by name or by address", async () => {
  const a = await agent();
  try {
    assert.deepEqual(await ask(a.port, `EGRESS ${TOKEN} CONNECT svc.example 443`, "ping\n"), ["OK", "pong ping\n"]);
    assert.deepEqual(a.asked, ["resolve 127.0.0.1:41001 svc.example via cloudflare-dns.com", "connect 127.0.0.1:41001 93.184.215.14 443"],
                     "resolved through the app's circuit, and the JUDGED literal dialled");
    assert.deepEqual(await ask(a.port, `EGRESS ${TOKEN} CONNECT 93.184.215.14 8080`, "x\n"), ["OK", "pong x\n"]);
    assert.deepEqual(await ask(a.port, `EGRESS ${TOKEN} RESOLVE svc.example`), ["OK 93.184.215.14", ""]);
    assert.deepEqual(await ask(a.port, `EGRESS ${TOKEN} RESOLVE nx.example`), ["ERR NXDOMAIN", ""]);
  } finally { a.close(); }
});

test("nothing goes out for another launch, an idle VM, or an app without a live route", async () => {
  for (const [opts, line, re] of [
    [{}, `EGRESS ${"cd".repeat(16)} CONNECT svc.example 443`, /not this launch's egress/],
    [{}, `CONNECT svc.example 443`, /not this launch's egress/],
    [{ current: () => null }, `EGRESS ${TOKEN} CONNECT svc.example 443`, /not this launch's egress/],
    [{ current: () => ({ token: TOKEN, deployment: "0x" + "99".repeat(32) }) }, `EGRESS ${TOKEN} CONNECT svc.example 443`, /no authorized egress route/],
    [{ file: routes({ expiresAt: Date.now() - 1 }) }, `EGRESS ${TOKEN} CONNECT svc.example 443`, /expired/],
    [{ file: "/nonexistent/egress-routes.json" }, `EGRESS ${TOKEN} CONNECT svc.example 443`, /no egress routes yet/],
  ]) {
    const a = await agent(opts);
    try {
      const [l] = await ask(a.port, line);
      assert.match(l, re, line);
      assert.deepEqual(a.asked, [], "nothing was resolved or dialled");
    } finally { a.close(); }
  }
});

test("only public destinations, never port 25, and a name with any private answer is refused whole", async () => {
  const a = await agent({ answers: { "mixed.example": ["93.184.215.14", "10.0.0.5"], "lan.example": ["192.168.1.2"] } });
  try {
    for (const [line, re] of [
      [`EGRESS ${TOKEN} CONNECT 10.0.0.5 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT 127.0.0.1 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT 100.64.1.1 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT 169.254.169.254 80`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT ::1 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT mixed.example 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT lan.example 443`, /not a public address/],
      [`EGRESS ${TOKEN} CONNECT 93.184.215.14 25`, /port 25/],
      [`EGRESS ${TOKEN} CONNECT 93.184.215.14 70000`, /1\.\.65535/],
      [`EGRESS ${TOKEN} CONNECT bad_host!name 443`, /not a host name/],
      [`EGRESS ${TOKEN} CONNECT svc.example 443 extra`, /malformed/],
    ]) assert.match((await ask(a.port, line))[0], re, line);
    assert.ok(!a.asked.some((x) => x.startsWith("connect")), `nothing dialled: ${a.asked}`);
  } finally { a.close(); }
  assert.equal(destinationRefusal("93.184.215.14", 443), null);
  assert.match(destinationRefusal("fd00::1", 443), /not a public address/);
});

test("a failed circuit falls over to the app's other one, and the per-app caps hold", async () => {
  const a = await agent({ failProxy: "127.0.0.1:41001" });
  try {
    assert.deepEqual(await ask(a.port, `EGRESS ${TOKEN} CONNECT 93.184.215.14 443`, "hi\n"), ["OK", "pong hi\n"]);
    assert.deepEqual(a.asked.filter((x) => x.startsWith("connect")), ["connect 127.0.0.1:41001 93.184.215.14 443", "connect 127.0.0.1:41002 93.184.215.14 443"]);
  } finally { a.close(); }
  const b = await agent({ limits: { concurrent: 10, perMinute: 2 } });
  try {
    assert.equal((await ask(b.port, `EGRESS ${TOKEN} CONNECT 93.184.215.14 443`, "1\n"))[0], "OK");
    assert.equal((await ask(b.port, `EGRESS ${TOKEN} CONNECT 93.184.215.14 443`, "2\n"))[0], "OK");
    assert.match((await ask(b.port, `EGRESS ${TOKEN} CONNECT 93.184.215.14 443`, "3\n"))[0], /at most 2 new connections a minute/);
  } finally { b.close(); }
});

test("the route file is the privacy agent's, checked before use", () => {
  assert.deepEqual(routeFor(routes(), D).proxies, ["127.0.0.1:41001", "127.0.0.1:41002"]);
  assert.throws(() => routeFor(routes({ apps: { [D]: { proxies: ["10.0.0.1:1080"], dns: DNS } } }), D), /not a loopback SOCKS/);
  assert.throws(() => routeFor(routes({ apps: { [D]: { proxies: ["127.0.0.1:1"], dns: [{ ...DNS[0], address: "10.0.0.1:443" }] } } }), D), /not a public :443/);
  assert.throws(() => routeFor(routes({ version: 2 }), D), /malformed/);
});
