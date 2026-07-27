// Cross-tenant loopback isolation (wasm_manager._audit_peers).
//
// Tenants share ONE network namespace inside the CVM, and the runtime's egress
// carve-out dials literal loopback DIRECT (wasmtime-egress.patch) so an app can
// reach /encvol. The side effect: tenant A can open a TCP connection straight to
// tenant B's assigned port and land inside B's app - around /x/:id, which is
// where a PRIVATE deployment's owner-token check and the deployer's WAF live.
// There is no per-address gate at the runtime today, so the manager polices it
// the way it polices binds and storage: measure and kill.
//
// These tests use REAL sockets and REAL /proc: a child process actually connects
// to a listener standing in for another tenant, and the audit has to see it.
//
//   run: node --test test/peer-isolation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

// Drive the module in-process: build fake tenant records, run the audit, report.
// `body` is Python that has `m` (the module) in scope and prints one JSON line.
function inManager(body, env = {}) {
  const code = `
import importlib.util, sys, json, os, socket, subprocess, time
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec)
sys.modules["wm"] = m
spec.loader.exec_module(m)

def listener():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
    return s, s.getsockname()[1]

def dialer(port):
    # own session: the manager's _kill kills the process GROUP, and an
    # un-setsid'd child shares this test's group
    return subprocess.Popen(
        [sys.executable, "-c",
         "import socket,time;s=socket.create_connection(('127.0.0.1',%d));time.sleep(60)" % port],
        preexec_fn=os.setsid)

def rec(vid, proc, ports):
    r = {"id": vid, "status": "running", "_proc": proc, "_assigned": list(ports),
         "hostPort": ports[0] if ports else None}
    m._apps[vid] = r
    return r

def settle(pid, want, tries=100):
    # the child's connect() is async to us; wait for the socket to appear
    for _ in range(tries):
        if m._sock_inodes(pid):
            time.sleep(0.05)
            return
        time.sleep(0.05)

${body}
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a tenant that dials another tenant's port is killed", () => {
  const r = inManager(`
victim_sock, victim_port = listener()
attacker = dialer(victim_port)
try:
    settle(attacker.pid, victim_port)
    rec("victim", None, [victim_port])
    a = rec("attacker", attacker, [victim_port + 10000])
    m._audit_peers(a, m._tenant_port_owner())
    print(json.dumps({"status": a["status"], "error": a.get("error") or "",
                      "dials": a.get("peerDials") or []}))
finally:
    try: os.killpg(attacker.pid, 9)
    except Exception: pass
    victim_sock.close()
`);
  assert.equal(r.status, "failed", "the caller must be killed, not merely logged");
  assert.match(r.error, /another deployment's loopback port/i);
  assert.equal(r.dials.length, 1);
  assert.equal(r.dials[0].deployment, "victim", "the record must name WHO was dialled");
});

test("WASM_PEER_AUDIT=warn records the dial and kills nothing", () => {
  const r = inManager(`
victim_sock, victim_port = listener()
attacker = dialer(victim_port)
try:
    settle(attacker.pid, victim_port)
    rec("victim", None, [victim_port])
    a = rec("attacker", attacker, [victim_port + 10000])
    m._audit_peers(a, m._tenant_port_owner())
    print(json.dumps({"status": a["status"], "dials": a.get("peerDials") or []}))
finally:
    try: os.killpg(attacker.pid, 9)
    except Exception: pass
    victim_sock.close()
`, { WASM_PEER_AUDIT: "warn" });
  assert.equal(r.status, "running", "warn mode must not kill");
  assert.equal(r.dials.length, 1, "warn mode must still surface the dial on the record");
});

test("the legitimate loopback planes and a tenant's own port are never hits", () => {
  // /encvol on the manager's own port is the one loopback plane a tenant is
  // SUPPOSED to reach; a self-connect is an app talking to itself. Neither is a
  // sibling, so neither may kill anything.
  const r = inManager(`
mgr_sock, mgr_port = listener()          # stands in for this manager's /encvol port
self_sock, self_port = listener()        # the tenant's OWN assigned port
to_mgr = dialer(mgr_port)
to_self = dialer(self_port)
try:
    settle(to_mgr.pid, mgr_port); settle(to_self.pid, self_port)
    a = rec("a", to_mgr, [self_port])
    b = rec("b", to_self, [self_port + 10000])
    m._audit_peers(a, m._tenant_port_owner())
    # b dials a port that belongs to tenant "a" -> that IS a sibling hit; use a
    # separate record whose own port is the one it dialled instead
    c = rec("c", to_self, [self_port])
    m._audit_peers(c, m._tenant_port_owner())
    print(json.dumps({"a": a["status"], "c": c["status"]}))
finally:
    for p in (to_mgr, to_self):
        try: os.killpg(p.pid, 9)
        except Exception: pass
    mgr_sock.close(); self_sock.close()
`);
  assert.equal(r.a, "running", "the manager's own port is not another tenant");
  assert.equal(r.c, "running", "a tenant's own port is not another tenant");
});

test("address parsing: only real loopback peers count", () => {
  const r = inManager(`
rows = [
  # ESTABLISHED to 127.0.0.1:20000  (0x4E20)
  "   0: 0100007F:C001 0100007F:4E20 01 00000000:00000000 00:00000000 00000000 1000 0 111 1 x 100 0 0 10 0",
  # LISTEN on 20001 - a null peer, must not be read as a dial
  "   1: 0100007F:4E21 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 112 1 x 100 0 0 10 0",
  # ESTABLISHED to 192.168.1.1:80 - off-box, none of this audit's business
  "   2: 0100007F:C002 0101A8C0:0050 01 00000000:00000000 00:00000000 00000000 1000 0 113 1 x 100 0 0 10 0",
  # ESTABLISHED to [::1]:20002 (0x4E22)
  "   3: 0000...:C003 00000000000000000000000001000000:4E22 01 00000000:00000000 00:00000000 00000000 1000 0 114 1 x 100 0 0 10 0",
  # someone ELSE's socket to 127.0.0.1:20003 - not in our inode set
  "   4: 0100007F:C004 0100007F:4E23 01 00000000:00000000 00:00000000 00000000 1000 0 999 1 x 100 0 0 10 0",
]
print(json.dumps({
  "ports": sorted(m._peer_ports({"111","112","113","114"}, rows)),
  "v4_lo": m._is_loopback_hex("0100007F"), "v4_pub": m._is_loopback_hex("0101A8C0"),
  "v6_lo": m._is_loopback_hex("00000000000000000000000001000000"),
  "v6_mapped_lo": m._is_loopback_hex("00000000000000000000FFFF0100007F"),
  "v6_mapped_pub": m._is_loopback_hex("00000000000000000000FFFF0101A8C0"),
}))
`);
  assert.deepEqual(r.ports, [20000, 20002], "IPv4 + IPv6 loopback peers, nothing else");
  assert.equal(r.v4_lo, true); assert.equal(r.v4_pub, false);
  assert.equal(r.v6_lo, true);
  assert.equal(r.v6_mapped_lo, true, "::ffff:127.0.0.1 is loopback too");
  assert.equal(r.v6_mapped_pub, false);
});
