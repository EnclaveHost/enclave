// hvlab-kvm-backend.mjs - a launch backend for the Windows owner's partition manager (windows/vbslike/manager
// server.mjs) that runs on THIS Linux host with plain KVM guests, so the manager's real code can be driven locally.
// It stands in for the NucBox launch backend and is NOT Hyper-V:
//   start(mapping)  takes a free pre-booted guest, pushes the manager's derived bundle over the monitor's control port
//                   (hvlab.py load: the same JSON line + bytes a NucBox launcher sends on hv_sock 9000), requires the
//                   guest's hash to equal the manager's AppID, and exposes the domain's port through a TCP relay
//   stop(handle)    the monitor's own destroy (the domain's process tree ends, its port closes), the relay ends, and the
//                   guest goes back to the pool - so a relaunch gets a FRESH domain with a fresh TLS key
// The handle carries the HCS backend's BOUNDARY verbatim with only the partition label changed, because the manager
// takes the record's tier from it; the boundary says what this is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HVLAB = path.join(HERE, "hvlab.py");

export class KvmBackend {
  constructor({ guests, stateDir, image, launcherKey, boundary, portBase = 18460 }) {
    this.free = [...guests];
    this.stateDir = stateDir; this.image = image; this.launcherKey = launcherKey; this.portBase = portBase;
    this._boundary = { ...boundary, partition: "kvm-plain-fixture (hvlab, NOT Hyper-V)" };
    this.live = new Map();          // instanceId -> { cid, domainId, relay }
  }
  // it answers to the NucBox backend's name, because that is what it stands in for; its boundary says what it is
  get backend() { return "hyperv-partition-per-app"; }
  get supports() { return { gpu: false, secrets: false, egress: false, config: false, ports: false }; }
  get boundary() { return this._boundary; }
  async preflight() { return { ok: true, checks: [], boundary: this._boundary }; }
  async start(mapping, { instanceId }) {
    const cid = this.free.shift();
    if (!cid) throw new Error("no free KVM guest");
    try {
      const file = path.join(os.tmpdir(), `hvkvm-${instanceId}.bundle`);
      fs.writeFileSync(file, Buffer.from(mapping.bundle));
      let ans;
      try { ans = JSON.parse(execFileSync("python3", [HVLAB, "load", this.stateDir, String(cid), file, instanceId]).toString()); }
      finally { fs.rmSync(file, { force: true }); }
      if (ans.appSha256 !== mapping.appId) throw new Error(`hash disagreement: manager ${mapping.appId} guest ${ans.appSha256}`);
      const tcpPort = this.portBase + (cid % 100) * 10 + (ans.id % 10);
      const relay = spawn("python3", ["-u", HVLAB, "relay", String(cid), String(ans.port), String(tcpPort)], { stdio: "ignore" });
      await new Promise((res) => setTimeout(res, 400));
      // the monitor names its domains by (boot, id): the id alone restarts at 1 on a guest reboot
      if (!/^[0-9a-f]{32}$/.test(String(ans.boot || ""))) throw new Error(`the monitor's load answer for guest ${cid} carries no boot nonce`);
      this.live.set(instanceId, { cid, domainId: ans.id, boot: ans.boot, relay });
      return { name: instanceId, vmId: `hvlab-cid-${cid}`, appId: mapping.appId, tcpPort, guestPort: ans.port,
               image: this.image, launcherKey: this.launcherKey, guest: { booted: true }, boundary: this._boundary };
    } catch (e) { this.free.unshift(cid); throw e; }
  }
  async stop(handle) {
    const id = handle && handle.name;
    const l = id && this.live.get(id);
    if (!l) return { stopped: false, reason: "no such instance here" };
    // a destroy the monitor did not confirm leaves the domain possibly RUNNING: say so, as the manager's defect-5
    // rule requires of a backend, and keep it listed rather than handing the guest to the next start
    try { execFileSync("python3", [HVLAB, "destroy", String(l.cid), String(l.domainId), String(l.boot)], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { throw new Error(`the monitor did not confirm destroying domain ${l.domainId} in guest ${l.cid}: ${String(e.stderr || e.message).trim()}`); }
    try { l.relay.kill(); } catch {}
    this.live.delete(id);
    this.free.push(l.cid);
    return { stopped: true };
  }
  stopAll() { for (const l of this.live.values()) { try { l.relay.kill(); } catch {} } }
}
