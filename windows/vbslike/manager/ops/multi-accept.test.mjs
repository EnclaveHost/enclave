// The multi-partition acceptance's own logic (READINESS.md U1), against the REAL Manager, HTTP server and DATA PLANE over
// a fake Hyper-V whose domains are real TLS fronts: what it reports as a pass must be one, and each defect it exists to
// catch must FAIL it (one VM shared, one key shared, a DELETE or an Off that takes every domain, a teardown that leaves
// VMs, a front that does not answer 200).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { runMultiAccept, deploymentOf } from "./multi-accept.mjs";
import { Manager, createServer, startManager } from "../server.mjs";
import { HyperVPartitionBackend } from "../backend.mjs";
import { MANAGER_NOTES_PREFIX, OWNER_MARKER, notesFor, parseNotes, boundaryFor } from "../wmi-launcher.mjs";
import { dataPlaneFor } from "../../datapath/node-bridge.mjs";
import { selfSigned } from "../../../node/apptls.mjs";
import { transportKeyOf } from "../ready.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const NAME = "0x" + "d1".repeat(32);
const HELLO = Buffer.from("Hello World!\n"), HELLO_SHA = crypto.createHash("sha256").update(HELLO).digest("hex");
const IMAGE = "ab".repeat(32);
const fronts = [];
after(() => { for (const s of fronts) { s.closeAllConnections?.(); s.close(); } });

async function front(status, cert) {
  const c = cert || selfSigned("127.0.0.1");
  const s = https.createServer({ key: c.key, cert: c.cert }, (req, res) => { res.writeHead(status); res.end(status === 200 ? HELLO : "no"); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); fronts.push(s);
  return { port: s.address().port, server: s, key: transportKeyOf(new crypto.X509Certificate(c.cert).publicKey.export({ type: "spki", format: "der" })) };
}
// a VM that goes Off takes its domain's front with it, as on the box: nothing in an Off VM answers
const off = (x) => { x.state = "Off"; for (const s of x.fronts || []) { s.closeAllConnections?.(); s.close(); } };

class FakeLauncher {
  constructor(host, o) { this.host = host; this.o = o; }
  get boundary() { return boundaryFor("linux-direct"); }
  async preflight() { return { ok: true, checks: [{ name: "fake", ok: true }] }; }
  async start(mapping, { instanceId, identity }) {
    const shared = this.o.sharedVm && [...this.host.values()][0];
    const vmId = shared ? shared.vmId : crypto.randomUUID(), name = "enclave-app-" + instanceId;
    if (!shared) this.host.set(vmId, { vmId, name, state: "Running", notes: identity ? notesFor({ ...identity, instanceId }) : OWNER_MARKER });
    const f = await front(this.o.frontStatus ?? 200, this.o.sharedKey ? (this.o.cert ||= selfSigned("127.0.0.1")) : null);
    this.o.keys.set(f.port, f.key);
    (this.host.get(vmId).fronts ||= []).push(f.server);
    return { instanceId, name, vmId, state: "Running", image: IMAGE, boundary: this.boundary, appId: mapping.appId,
             guest: { booted: true, bytes: 613, head: "MON ready" }, appReady: false, tcpPort: f.port,
             launcherKey: crypto.randomBytes(32).toString("base64"), launcherVmId: vmId, domainId: 1,
             guestIdentity: { partition: "wmi-openhcl-gen2-igvm-linux", guestImageKind: "igvm-linux-direct" },
             wmiserve: { stop: async () => ({ closed: true }), exited: new Promise(() => {}) } };
  }
  async stop(h) {
    if (this.o.stopLeaves) return { stopped: true, removed: true, vmId: h.vmId, name: h.name };      // the defect: says removed, is not
    if (this.o.deleteKillsAll) { for (const x of this.host.values()) off(x); }
    const had = this.host.delete(h.vmId); return { stopped: true, removed: had, vmId: h.vmId, name: h.name };
  }
  async state(name) { const x = [...this.host.values()].find((y) => y.name === name); return x ? { found: true, state: x.state } : { found: false }; }
  async survey() { return { vms: [...this.host.values()].filter((x) => String(x.notes).startsWith(MANAGER_NOTES_PREFIX) || x.notes === OWNER_MARKER) }; }
}

function harness(o = {}) {
  const host = new Map(); o.keys = new Map();
  let server = null, dp = null, sweep = null, port = 0;
  const ctl = {
    parseNotes,
    survey: async () => ({ vms: [...host.values()].map((x) => ({ ...x })) }),
    memory: () => ({ freeMiB: 30000 - 2048 * [...host.values()].filter((x) => x.state === "Running").length, totalMiB: 32768 }),
    async turnOff(vmId) { for (const x of host.values()) if (o.offKillsAll || x.vmId === vmId) off(x); },
    async startManager(extraEnv = {}) {
      // the fake judge answers for the key its front really holds; the liveness sweep is the real one, on an interval
      const judgeReady = async ({ port: p }) => ({ status: "running", transportKeySha256: o.keys.get(p), checks: {} });
      const manager = new Manager({ judgeReady, answerCheck: async () => ({ ok: true }), runtimeId: REC.runtimeId, fetchComponent: async () => component,
        backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host, o) }) });
      await startManager(manager);
      sweep = setInterval(() => { manager.sweepLiveness().catch(() => {}); }, 50); sweep.unref();
      server = createServer(manager);
      await new Promise((res) => server.listen(port, "127.0.0.1", res)); port = server.address().port;
      const dataPort = Number(extraEnv.ENCLAVE_DATAPLANE_PORT || 0);
      if (dataPort) {
        dp = dataPlaneFor(manager);
        await new Promise((res) => dp.server.listen(dataPort, "127.0.0.1", res));
        manager.onReclaim = (id, why) => { try { dp.closeInstance(id, why); } catch {} };
      }
      return `http://127.0.0.1:${port}`;
    },
    async killManager() {
      clearInterval(sweep);
      if (dp) { dp.server.close(); dp = null; }
      if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); server = null; }
    },
  };
  return { host, ctl };
}
const freePort = async () => { const s = (await import("node:net")).createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const run = async (h, extra = {}) => {
  const lines = [];
  const r = await runMultiAccept({ ctl: h.ctl, spawnBody: { derive: REC, isPublic: true, hasSecrets: false }, name: NAME, dataPort: await freePort(),
                                   expectBodySha256: HELLO_SHA, say: (l) => lines.push(l), readyWaitMs: 10_000, sweepWaitMs: 5_000, ...extra });
  return { r, lines };
};
const has = (lines, re) => lines.some((l) => re.test(l));

test("the deployments differ by name, 8-hex label and AppID-bearing policy, and nothing else", () => {
  const base = { derive: REC, isPublic: true, hasSecrets: false }, before = JSON.stringify(base);
  const ds = [0, 1, 2].map((i) => deploymentOf(base, NAME, i, 128));
  assert.deepEqual(ds.map((d) => d.derive.policy.memMiB), [128, 144, 160]);
  assert.equal(new Set(ds.map((d) => d.name.slice(2, 10))).size, 3, "three labels, so three SNI names");
  for (const d of ds) { assert.equal(d.derive.cid, REC.cid); assert.equal(d.derive.runtimeId, REC.runtimeId); assert.deepEqual(d.derive.catalog, REC.catalog); }
  assert.equal(JSON.stringify(base), before, "the caller's body is not mutated");
  assert.throws(() => deploymentOf(base, "0xnot-hex", 0, 128), /0x \+ 64 lowercase hex/);
});

test("three domains that each serve on their own VM and key PASS M0-M7, and teardown leaves nothing", async () => {
  const h = harness();
  const { r, lines } = await run(h);
  assert.equal(r.ok, true, lines.join("\n"));
  for (const m of ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]) assert.ok(has(lines, new RegExp(`^PASS ${m}:`)), `${m}\n${lines.join("\n")}`);
  assert.ok(has(lines, /^PASS M4: A's key on B's route: "NO the instance's verified transport key is not that key"; A's id with B's app: "NO the instance is not that app"$/), lines.join("\n"));
  assert.ok(has(lines, /^PASS M3: .*200 "Hello World!\\n", TLS key/), lines.join("\n"));
  assert.ok(has(lines, /^MEMORY before: /) && has(lines, /^MEMORY with 3 running: /) && has(lines, /^MEMORY after teardown: /));
  assert.equal(lines.at(-1), "MULTI-ACCEPT ALL PASS");
  assert.equal(h.host.size, 0);
});

for (const [what, o, re] of [
  ["one VM carrying every domain", { sharedVm: true }, /^FAIL M2: /],
  ["one TLS key for every domain", { sharedKey: true }, /^FAIL M2: /],
  ["a DELETE that takes every domain down", { deleteKillsAll: true }, /^FAIL M5: /],
  ["an Off that takes every VM down", { offKillsAll: true }, /^FAIL M6: /],
  ["a teardown that leaves VMs behind", { stopLeaves: true }, /^FAIL M7: /],
  ["a front that answers 500", { frontStatus: 500 }, /^FAIL M3: /],
]) test(`${what} FAILS the run (${re.source.slice(1, 8)})`, async () => {
  const h = harness(o);
  const { r, lines } = await run(h);
  assert.equal(r.ok, false, lines.join("\n"));
  assert.ok(has(lines, re), lines.join("\n"));
  assert.match(lines.at(-1), /^MULTI-ACCEPT \d+ FAILED$/);
});

test("a manager-owned VM already on the host: REFUSED as the last line, and neither it nor anything else is touched", async () => {
  const h = harness();
  h.host.set("pre", { vmId: "pre", name: "enclave-app-someone", state: "Running", notes: OWNER_MARKER });
  const { r, lines } = await run(h);
  assert.equal(r.refused, true);
  assert.match(lines.at(-1), /^MULTI-ACCEPT REFUSED: /);
  assert.ok(!has(lines, /^(PASS|FAIL) M7/), "a refused run records no teardown");
  assert.equal(h.host.has("pre"), true); assert.equal(h.host.get("pre").state, "Running");
});
