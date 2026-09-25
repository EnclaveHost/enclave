// The hardware restart acceptance's own logic, against the REAL Manager and HTTP server over a fake Hyper-V whose
// VMs outlive the manager: what it reports as a pass must be one, and a manager that forgets its VMs must FAIL it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runRestartAccept } from "./restart-accept.mjs";
import { Manager, createServer, startManager } from "../server.mjs";
import { HyperVPartitionBackend } from "../backend.mjs";
import { OWNER_MARKER, MANAGER_NOTES_PREFIX, notesFor, parseNotes, boundaryFor } from "../wmi-launcher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const NAME = "0x" + "d1".repeat(32);

class FakeLauncher {
  constructor(host, { blind = false } = {}) { this.host = host; this.blind = blind; }
  get boundary() { return boundaryFor("linux-direct"); }
  async preflight() { return { ok: true, checks: [{ name: "fake", ok: true }] }; }
  async start(mapping, { instanceId, identity }) {
    const name = "enclave-app-" + instanceId, vmId = crypto.randomUUID();
    this.host.set(vmId, { vmId, name, state: "Running", notes: identity ? notesFor({ ...identity, instanceId }) : OWNER_MARKER });
    return { instanceId, name, vmId, state: "Running", image: null, boundary: this.boundary, appId: mapping.appId,
             guest: { booted: true, bytes: 613, head: "MON ready" }, appReady: false };
  }
  async stop(h) { const had = this.host.delete(h.vmId); return { stopped: true, removed: had, vmId: h.vmId, name: h.name }; }
  async state(name) { const x = [...this.host.values()].find((y) => y.name === name); return x ? { found: true, state: x.state } : { found: false }; }
  // a BLIND launcher is the regression: a restarted manager that cannot see its predecessor's VMs
  async survey() { return { vms: this.blind ? [] : [...this.host.values()].filter((x) => String(x.notes).startsWith(MANAGER_NOTES_PREFIX) || x.notes === OWNER_MARKER) }; }
}

function harness({ blindAfterRestart = false } = {}) {
  const host = new Map(); let server = null, port = 0, boots = 0;
  const ctl = {
    parseNotes,
    survey: async () => ({ vms: [...host.values()].map((x) => ({ ...x })) }),
    async startManager() {
      boots++;
      const manager = new Manager({ judgeReady: async () => null, runtimeId: REC.runtimeId, fetchComponent: async () => component,
        backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host, { blind: blindAfterRestart && boots > 1 }) }) });
      await startManager(manager);
      server = createServer(manager);
      await new Promise((res) => server.listen(port, "127.0.0.1", res));
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    async killManager() { if (!server) return; server.closeAllConnections?.(); await new Promise((r) => server.close(r)); server = null; },
  };
  return { host, ctl };
}
const run = async (h) => { const lines = []; const r = await runRestartAccept({ ctl: h.ctl, spawnBody: { derive: REC, isPublic: true, hasSecrets: false }, name: NAME, say: (l) => lines.push(l), readyWaitMs: 5000 }); return { r, lines }; };

test("a manager that recovers its VM passes A0-A6, reports A7 as N/A (never PASS), and leaves nothing behind", async () => {
  const h = harness();
  const { r, lines } = await run(h);
  assert.equal(r.ok, true, lines.join("\n"));
  for (const a of ["A0", "A1", "A2", "A3", "A4", "A5", "A6"]) assert.ok(lines.some((l) => l.startsWith(`PASS ${a}:`)), `${a}\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.startsWith("N/A A7")) && !lines.some((l) => l.startsWith("PASS A7")));
  assert.match(lines.at(-1), /^RESTART-ACCEPT ALL PASS \(N\/A: A7\)$/);
  assert.equal(h.host.size, 0);
});

test("a restarted manager that cannot see its predecessor's VM FAILS A4 and A5 (it would release the lease and start a second VM)", async () => {
  const h = harness({ blindAfterRestart: true });
  const { r, lines } = await run(h);
  assert.equal(r.ok, false);
  assert.ok(lines.some((l) => l.startsWith("FAIL A4:")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("FAIL A5:")), lines.join("\n"));
  assert.match(lines.at(-1), /^RESTART-ACCEPT \d+ FAILED$/);
});

test("a manager-owned VM already on the host: REFUSED, and it is not touched", async () => {
  const h = harness();
  h.host.set("pre", { vmId: "pre", name: "enclave-app-someone", state: "Running", notes: OWNER_MARKER });
  const { r, lines } = await run(h);
  assert.equal(r.refused, true);
  assert.match(lines.join("\n"), /RESTART-ACCEPT REFUSED/);
  assert.equal(h.host.has("pre"), true);
});
