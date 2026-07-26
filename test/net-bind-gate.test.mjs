// net-guard.mjs v6PrefixGate/bindRefusal — and tcp6-relay refusing a hostile net-map.
//
// The tcp6 and udp relays learn which local address:port to BIND from each
// enclave's /v1/net-map. The enclave derives that address from an authenticated
// deployment id, so it is normally the deployment's own dedicated /64 address.
// The question this covers is what happens when it is not: a fleet member that
// is rogue, compromised, or merely misconfigured answering `::` would have the
// relay bind every interface on that port and splice the traffic into its app,
// and `::1` would put it in front of loopback services on the box.
//
// The egress relay has constrained its SOURCE addresses this way since fix 9.
// The two inbound binders had no check at all, which is the drift a second copy
// of a security control produces - so the gate now lives in net-guard.mjs with
// all three calling it.
//
//   run: node --test test/net-bind-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v6PrefixGate, bindRefusal } from "../net-guard.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "2a01:4f8:c17:abcd::/64";
const IN_PREFIX = "2a01:4f8:c17:abcd::5";

// ---- the gate ---------------------------------------------------------------

test("v6PrefixGate: membership is by masked network, not string prefix", () => {
  const g = v6PrefixGate(PREFIX);
  assert.equal(g.constrained, true);
  assert.ok(g.check(IN_PREFIX));
  assert.ok(g.check("2a01:4f8:c17:abcd:ffff:ffff:ffff:ffff"));
  assert.ok(!g.check("2a01:4f8:c17:abce::5"), "the adjacent /64 is not ours");
  // a string-prefix test would accept this: same text, different network
  assert.ok(!g.check("2a01:4f8:c17:abcd0::5"));
  assert.ok(!g.check("2a01:4f8:c17:abc::5"));
});

test("v6PrefixGate: unset is explicitly unconstrained; malformed throws", () => {
  for (const empty of [undefined, null, "", "   "]) {
    const g = v6PrefixGate(empty);
    assert.equal(g.constrained, false);
    assert.ok(g.check("2a01:4f8:c17:abcd::5"), "unconstrained admits any address");
  }
  // fatal at boot beats silently degrading to unconstrained
  for (const bad of ["not-a-cidr", "10.0.0.0/8", "2a01:4f8::/129", "/64", "2a01:zzzz::/64"])
    assert.throws(() => v6PrefixGate(bad), /not a valid IPv6 CIDR/, bad);
});

const NEVER_OK = ["::1", "fe80::1", "fc00::1", "fd00::abcd", "ff02::1",
                  "2001:db8::1", "::ffff:127.0.0.1"];

test("bindRefusal: with a real prefix declared, none of these get bound", () => {
  const g = v6PrefixGate(PREFIX);
  // the declared /64 is the policy, and not one of them is in it
  for (const a of NEVER_OK) assert.match(bindRefusal(a, g), /outside this box's/, a);
  assert.match(bindRefusal("::", g), /unspecified address/, "wildcard loses under any prefix");
});

test("bindRefusal: with NO prefix declared, the range table is the fallback", () => {
  const none = v6PrefixGate("");
  for (const a of NEVER_OK) assert.match(bindRefusal(a, none), /not a global unicast address/, a);
  assert.match(bindRefusal("::", none), /unspecified address/);
});

test("bindRefusal: a declared prefix IS the policy, even a narrow one", () => {
  // what makes the local rig work: it declares ::1/128 and binds exactly
  // loopback. The attacker supplies the address, never the prefix - so honouring
  // an explicit declaration costs nothing, and it keeps the production check
  // (membership in the routed /64) as the single thing that decides.
  const loop = v6PrefixGate("::1/128");
  assert.equal(bindRefusal("::1", loop), "");
  assert.match(bindRefusal("::2", loop), /outside this box's/);
  assert.match(bindRefusal(IN_PREFIX, loop), /outside this box's/);
  assert.match(bindRefusal("::", loop), /unspecified address/, "still not the wildcard");
});

test("bindRefusal: IPv4 loses even when it is PUBLIC", () => {
  // the one isBlockedHost would have waved through: a global v4. The dangerous
  // member of that set is the box's own public v4 - bind a port the fronting
  // proxy does not hold and the deployment is serving the internet on the
  // platform's own address, which is the wildcard case by another route.
  const g = v6PrefixGate(PREFIX);
  for (const a of ["8.8.8.8", "1.1.1.1", "203.0.113.7", "0.0.0.0", "127.0.0.1", "10.0.0.1"]) {
    assert.notEqual(bindRefusal(a, g), "", a);
    assert.notEqual(bindRefusal(a, v6PrefixGate("")), "", `${a} unconstrained`);
  }
  assert.match(bindRefusal("8.8.8.8", g), /not IPv6/);
});

test("bindRefusal: a real global address off-prefix is refused, in-prefix allowed", () => {
  const g = v6PrefixGate(PREFIX);
  assert.equal(bindRefusal(IN_PREFIX, g), "");
  assert.match(bindRefusal("2a02:1234:5678:9abc::1", g), /outside this box's 2a01:4f8:c17:abcd::\/64/);
  // with no prefix, a global address is admitted - that is the opt-in tradeoff
  assert.equal(bindRefusal("2a02:1234:5678:9abc::1", v6PrefixGate("")), "");
});

test("bindRefusal: junk is refused, not coerced", () => {
  const g = v6PrefixGate(PREFIX);
  for (const a of [undefined, null, "", "   ", 42, {}, [], "example.com", "localhost",
                   "2a01:4f8:c17:abcd::5/64", "[2a01:4f8:c17:abcd::5]"])
    assert.notEqual(bindRefusal(a, g), "", JSON.stringify(a));
});

// ---- the daemon -------------------------------------------------------------

// A fake enclave serving one hostile /v1/net-map. The relay polls it, and every
// entry here must be refused except the last, which is well-formed and
// in-prefix - that one gets as far as the kernel and fails on AnyIP, which is
// how we can tell it passed the gate on a box with no /64 routed to lo.
const NET_MAP = {
  enabled: true,
  deployments: [
    { id: "0xaa" + "1".repeat(62), address: "::",        tcp: [8443] },  // every interface
    { id: "0xbb" + "2".repeat(62), address: "::1",       tcp: [8444] },  // in front of loopback
    { id: "0xcc" + "3".repeat(62), address: "fe80::1",   tcp: [8445] },  // link-local
    { id: "0xdd" + "4".repeat(62), address: "0.0.0.0",   tcp: [8446] },  // v4 wildcard
    { id: "0xee" + "5".repeat(62), address: "2a02:dead:beef:1::9", tcp: [8447] }, // off-prefix
    { id: "0xff" + "6".repeat(62), address: IN_PREFIX,   tcp: [99999, -1, 0, "http"] }, // bad ports
    { id: "0x11" + "7".repeat(62), address: IN_PREFIX,   tcp: [8448] },  // the one good row
  ],
};

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

test("tcp6-relay refuses every address it should not bind, and stays up", async () => {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/v1/net-map") ? NET_MAP : {}));
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));

  const proc = spawn(process.execPath, [path.join(ROOT, "relay", "tcp6-relay.js")], {
    env: { ...process.env, ENCLAVES: `http://127.0.0.1:${port}`, TCP6_PREFIX: PREFIX, NET_POLL_SEC: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  try {
    // one poll runs at startup; give it room, then let a second poll happen to
    // prove the warn-once path does not wedge the loop
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !/8448/.test(out)) await new Promise((r) => setTimeout(r, 200));

    for (const [addr, why] of [["::", /unspecified address/], ["::1", /outside this box's/],
                               ["fe80::1", /outside this box's/], ["0.0.0.0", /not IPv6/],
                               ["2a02:dead:beef:1::9", /outside this box's/]]) {
      const line = out.split("\n").find((l) => l.includes(`[${addr}]`));
      assert.ok(line, `no refusal logged for ${addr}\n--- output ---\n${out}`);
      assert.match(line, why, addr);
    }
    for (const bad of ["99999", "-1", "0", "http"])
      assert.match(out, new RegExp(`tcp:${bad.replace("-", "\\-")} — refused: not a port number`), `port ${bad}`);

    // the good row reached the kernel: either it bound (AnyIP configured here)
    // or the bind failed - either way it was NOT refused by the gate
    assert.match(out, /8448/, `the in-prefix row never reached bind\n--- output ---\n${out}`);
    assert.doesNotMatch(out, new RegExp(`\\[${IN_PREFIX}\\] — refused`), "in-prefix address must not be refused");

    // nothing hostile actually got bound
    assert.ok(!proc.exitCode, "relay must survive a hostile net-map");
    for (const p of [8443, 8444]) {
      const reachable = await new Promise((r) => {
        const s = net.connect({ host: "::1", port: p }, () => { s.destroy(); r(true); });
        s.on("error", () => r(false)); s.setTimeout(1000, () => { s.destroy(); r(false); });
      });
      assert.equal(reachable, false, `port ${p} must not be listening`);
    }
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    await new Promise((r) => srv.close(r));
  }
});
