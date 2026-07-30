// Every tenant launch carries a loopback policy, and it names only what that
// deployment legitimately reaches.
//
// The runtime half lives in wasm/wasmtime-loopback.patch (`-S loopback-allow`),
// and its default is deliberately permissive so a hand-launched wasmtime — the
// manager's own probe processes — is unchanged. That makes the LAUNCHER the
// thing that decides whether the wall exists at all: if _build_cmd ever stops
// emitting the flag, the patch is inert and tenants can reach each other again
// with nothing failing. So pin it here, on the real command line.
//
// What belongs in the list, and nothing else:
//   - the deployment's OWN ports (an app may talk to itself)
//   - the manager's control port, ONLY with encrypted volumes (that is the
//     /encvol plane behind ENCLAVE_ENC_API)
//   - the SOCKS front, ONLY when this tenant was handed an egress URL
//
//   run: node --test test/wasm-loopback-flag.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

const FAKE = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
  const p = path.join(dir, "wasmtime");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

// A wasmtime that advertises the '+' form. The composition tests below are
// about WHAT lands in the list; without this they would silently depend on the
// probe's answer for whatever binary is on PATH, which is how they all started
// failing the moment the probe got stricter.
const SUPPORTS = FAKE(`echo "  -S    egress=val -- ..."; echo "  -S    loopback-allow=<port[+port...]> -- ..."; exit 0`);


// Build a real command line through _build_cmd and return it, plus the parsed
// loopback list. `kw` is spliced into the call as python keyword arguments.
function cmdFor(kw = {}, { serve = true, env = {} } = {}) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
pspec = ${serve
    ? '{"serve": True, "http": None, "tcp": [], "udp": [], "declared": [], "norm": []}'
    : '{"serve": False, "http": 8080, "tcp": [8080], "udp": [], "declared": ["tcp:8080"], "norm": ["http:8080"]}'}
cmd, host_port, wait = m._build_cmd(pspec, "/tmp/app.wasm", 20001, 64 * 1024 * 1024,
                                    ${serve ? "None" : '{"http:8080": 20002}'}, None, **${JSON.stringify(kw)})
lb = None
for i, a in enumerate(cmd):
    if isinstance(a, str) and a.startswith("loopback-allow="):
        lb = a.split("=", 1)[1]
print(json.dumps({"cmd": cmd, "lb": lb}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0",
           WASMTIME_BIN: SUPPORTS, ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const r = JSON.parse(out.trim().split("\n").pop());
  return { ...r, ports: r.lb === null ? null : r.lb.split("+").filter(Boolean).map(Number) };
}

test("a serve app with nothing to reach gets an EMPTY list, not a missing one", () => {
  const { cmd, lb, ports } = cmdFor();
  assert.ok(cmd.includes("-S"), "flags are passed as separate argv entries");
  assert.notEqual(lb, null, "the flag must always be present — an absent flag is an open door");
  // its own serve port is the only thing it may dial
  assert.deepEqual(ports, [20001]);
});

test("encrypted volumes add the manager's control port, and only then", () => {
  const withEnc = cmdFor({ enc: [{ v: 1 }, "http://127.0.0.1:8091/encvol/x", "tok"] });
  assert.ok(withEnc.ports.includes(8091), "the /encvol plane must stay reachable");
  const without = cmdFor();
  assert.ok(!without.ports.includes(8091),
    "a tenant with no encrypted volumes has no business on the control port");
});

test("an egress front is added only when this tenant was given one", () => {
  const transparent = cmdFor({ egress_transparent: "127.0.0.1:39999" });
  assert.ok(transparent.ports.includes(39999), "the transparent front's port");
  const phase1 = cmdFor({ egress: "socks5h://dep1:tok@127.0.0.1:38888" });
  assert.ok(phase1.ports.includes(38888), "a phase-1 guest dials the front itself");
  // an unparseable value contributes nothing rather than throwing
  const junk = cmdFor({ egress: "not-a-url" });
  assert.deepEqual(junk.ports, [20001]);
});

test("run mode carries it too — the posture the wall exists for", () => {
  // A declared-ports app is launched with -Sinherit-network, which installs an
  // allow-ALL address check; the flag is what the patched CLI replaces it with.
  const { cmd, ports } = cmdFor({}, { serve: false });
  assert.ok(cmd.includes("-Sinherit-network"), "this is the inherit-network posture");
  const i = cmd.indexOf("loopback-allow=" + ports.join("+"));
  assert.ok(i > 0 && cmd[i - 1] === "-S", "the flag must be a real -S option, not a stray argv word");
  // its own actual bind (the port map value), not the logical one
  assert.ok(ports.includes(20002), `the app's own actual port must be dialable: ${ports}`);
});

test("the list is sorted, deduped and free of junk", () => {
  const { lb, ports } = cmdFor({ enc: [{}, "http://127.0.0.1:8091/x", "t"],
                                 egress_transparent: "127.0.0.1:8091" }, { serve: false });
  assert.deepEqual(ports, [...new Set(ports)].sort((a, b) => a - b), "sorted + deduped");
  assert.match(lb, /^\d+(\+\d+)*$/,
    "PLUS-separated: `-S` splits its argument on commas, so a comma here kills every launch");
});

// ---- and the other half: never emit an option this binary does not have ------
// The launcher is rebuilt by CI on every wasm/ push; the binary only moves when
// the manual toolchain workflow does. On 2026-07-28 the launcher ran ahead, and
// because an unknown -S option is a hard parse error (exit 2, before the module
// is read), EVERY tenant launch on the fleet died — claimed, failed, released,
// and "queued" forever from outside. So the flag is now conditional on the
// binary's own `-S help`, and these pin which way each answer falls.
test("a wasmtime WITHOUT the patch is launched without the flag, not fed one it rejects", () => {
  // a readable option list that simply omits loopback-allow = positive evidence
  const bin = FAKE(`echo "  -S    egress=val -- route guest outbound"; exit 0`);
  const { cmd, lb } = cmdFor({}, { env: { WASMTIME_BIN: bin } });
  assert.equal(lb, null, "the option must be absent — passing it fails the launch outright");
  assert.ok(!cmd.some((a) => String(a).startsWith("loopback-allow=")), "no stray argv word either");
});

test("a wasmtime WITH the patch still gets the flag", () => {
  const bin = FAKE(`echo "  -S    egress=val -- ..."; echo "  -S    loopback-allow=<port[+port...]> -- ..."; exit 0`);
  const { ports } = cmdFor({}, { env: { WASMTIME_BIN: bin } });
  assert.deepEqual(ports, [20001], "support probed = wall enforced, unchanged");
});

test("a COMMA-only binary is refused the flag — the 2026-07-30 outage", () => {
  // The option name is listed, so the old name-only probe said yes and the
  // launcher handed it `loopback-allow=A,B`. `-S` split that on the comma and
  // wasmtime died with `unknown -S / --wasi option: B`, taking every tenant on
  // the fleet with it. Knowing the NAME is not knowing the SEPARATOR.
  const bin = FAKE(`echo "  -S    egress=val -- ..."; echo "  -S    loopback-allow=<port[,port...]> -- ..."; exit 0`);
  const { cmd, lb } = cmdFor({}, { env: { WASMTIME_BIN: bin } });
  assert.equal(lb, null, "an older comma-only patch must not be fed a list it will split");
  assert.ok(!cmd.some((a) => String(a).startsWith("loopback-allow=")), "no stray argv word either");
});

test("a probe that cannot answer suppresses the flag rather than the box", () => {
  // This used to fall the other way, on the principle that "I could not check"
  // should never quietly drop a security control. Twice that principle took the
  // whole fleet down instead, so it is inverted here ON PURPOSE: unproven means
  // launch WITHOUT the wall and say so loudly. A wall that refuses every launch
  // protects nothing.
  const quiet = FAKE(`exit 0`);                       // ran, said nothing recognisable
  assert.equal(cmdFor({}, { env: { WASMTIME_BIN: quiet } }).lb, null);
  const missing = path.join(tmpdir(), "no-such-wasmtime-" + process.pid);
  assert.equal(cmdFor({}, { env: { WASMTIME_BIN: missing } }).lb, null);
});
