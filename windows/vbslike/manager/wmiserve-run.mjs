// wmiserve-run.mjs - the app load and relay for a WMI-defined partition: `vbslike-host wmiserve` (enclave-d1's Rust
// launcher, WMISERVE-PROTOCOL.md) run as a child of this manager for as long as the domain lives.
//
// wmi-launcher.mjs defines and starts the VM and sees the guest's console. It does not put the app in the guest or
// carry traffic to it. wmiserve does both: it sends the bundle over hv_sock 9000, signs reports on 9001 for THIS VM only,
// and relays host TCP to the domain's hv_sock port. It never terminates TLS; the guest holds the key.
//
// THE PROTOCOL IS READ STRICTLY, IN ORDER (one JSON object per stdout line):
//   launcher{key, vm} -> report-service{bound} -> load{ok, id, appSha256, guestPort, agreed, boot} -> relay{ok, tcp} -> ready
// Anything else is a failure, and the child is stopped:
//   - a step out of order, an unknown step, `ok:false`, or a line that is not JSON;
//   - the process exiting before `ready`, or no `ready` within the deadline.
// `agreed:true` says the guest and wmiserve hashed the same file. That is not "the app we meant", so the load's
// appSha256 must ALSO equal the AppID the manager derived (enclave-d1). The bundle file is written by instance id into a
// manager-owned directory, hashed after writing, refused on a mismatch, and removed on stop and on any failure.
//
// LIFETIME. `--hold stdin`: wmiserve serves until a NON-BLANK line arrives on its stdin (a blank one is ignored), or its
// stdin reaches EOF or errors. So stop() writes "stop" and ends stdin, waits for {"step":"closed"}, and kills the child
// after a deadline. A manager that dies closes
// the pipe, and the relay goes with it, which is why a VM a restarted manager recovers never serves (recovered:true).
//
// NOTHING HERE IS A SECURITY CLAIM. The report is launcher-signed (monitor-signed T0-hv, host_excluded=no), and the
// manager's readiness rule judges it, with the launcher's (partition, guestImageKind) statement compared before the image.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn as nodeSpawn } from "node:child_process";

const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
const STEPS = ["launcher", "report-service", "load", "relay", "ready"];

/** A loopback TCP port nothing holds right now, for the relay to bind. A race with another binder fails the relay step
 *  loudly (ok:false), and the start fails and removes its VM; it never serves the wrong thing. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Write the bundle for one instance, hashed after writing; refuses bytes that are not the AppID. */
export function writeBundle({ dir, instanceId, bundle, appId }) {
  if (!dir) throw new Error("a manager-owned bundle directory is required");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(instanceId || ""))) throw new Error("the bundle file is named by a safe instance id");
  if (!Buffer.isBuffer(bundle) || !bundle.length) throw new Error("the mapping carries no bundle bytes to load");
  if (!HEX64.test(String(appId || ""))) throw new Error("the AppID the bundle must hash to is required");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${instanceId}.bundle`);
  fs.writeFileSync(file, bundle, { flag: "w" });
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (got !== appId) { fs.rmSync(file, { force: true }); throw new Error(`the bundle written for ${instanceId} hashes to ${got}, not the AppID ${appId}`); }
  return file;
}

/**
 * runWmiserve(opts) -> Promise<run>, resolved at `ready`, rejected (with the child stopped) on anything else.
 *   exe, vmId, bundleFile, appId, tcpPort, and exactly one of igvmSha256 | mediumSha256
 *   run = { pid, launcherKey, domainId, boot, appSha256, guestPort, tcpPort, note, exited, stop() }
 */
export function runWmiserve({ exe, vmId, bundleFile, appId, tcpPort, igvmSha256 = null, mediumSha256 = null,
                              isolationType = 1, label = null, vcpus = null, memMiB = null,
                              readyTimeoutMs = 180_000, closeTimeoutMs = 15_000, spawn = nodeSpawn, log = () => {} } = {}) {
  if (!exe) return Promise.reject(new Error("the wmiserve executable is required"));
  if (!/^[0-9a-f-]{36}$/i.test(String(vmId || ""))) return Promise.reject(new Error("wmiserve joins a VM by its GUID"));
  if (!!igvmSha256 === !!mediumSha256) return Promise.reject(new Error("exactly one identity: --igvm-sha256 or --medium-sha256"));
  const identity = igvmSha256 ? ["--igvm-sha256", String(igvmSha256)] : ["--medium-sha256", String(mediumSha256)];
  if (!HEX64.test(identity[1])) return Promise.reject(new Error(`${identity[0]} needs 64 lowercase hex`));
  if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) return Promise.reject(new Error("a host TCP port for the relay is required"));
  const args = ["wmiserve", "--vm", String(vmId), "--bundle", String(bundleFile), ...identity,
                "--isolation-type", String(isolationType), "--tcp", String(tcpPort), "--hold", "stdin",
                ...(label ? ["--label", String(label)] : []), ...(vcpus ? ["--vcpus", String(vcpus)] : []),
                ...(memMiB ? ["--mem", String(memMiB)] : [])];

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "", stderr = "", next = 0, settled = false, closedSeen = false;
    const got = {};
    let exitResolve; const exited = new Promise((r) => { exitResolve = r; });
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const fail = (why) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      kill();
      const e = new Error(`wmiserve for ${vmId}: ${why}${stderr ? ` (stderr: ${stderr.trim().slice(-300)})` : ""}`);
      e.steps = { ...got }; reject(e);
    };
    const timer = setTimeout(() => fail(`no "ready" within ${readyTimeoutMs} ms (last step: ${STEPS[next - 1] || "none"})`), readyTimeoutMs);

    const onStep = (o) => {
      if (settled) { if (o.step === "closed") closedSeen = true; return; }     // after ready: only `closed` is expected
      if (o.ok === false) return fail(`step ${o.step} failed: ${o.error || "no reason given"}`);
      if (o.step !== STEPS[next]) return fail(`expected step "${STEPS[next]}", got ${JSON.stringify(o.step)}`);
      next++; got[o.step] = o;
      switch (o.step) {
        case "launcher":
          if (Buffer.from(String(o.key || ""), "base64").length !== 32) return fail("the launcher key is not a 32-byte Ed25519 public key");
          if (String(o.vm || "").toLowerCase() !== String(vmId).toLowerCase()) return fail(`wmiserve joined ${o.vm}, not ${vmId}`);
          return;
        case "report-service":
          if (o.bound !== true) return fail("the report service is not bound: no attestation could be answered");
          return;
        case "load":
          if (o.ok !== true) return fail("the load step did not say ok");
          if (o.agreed !== true) return fail("the guest's hash and wmiserve's were not compared and agreed");
          if (o.appSha256 !== appId) return fail(`the guest loaded ${o.appSha256}, not the AppID ${appId}`);
          if (!Number.isInteger(o.id) || o.id < 1) return fail(`the load named no domain id (${JSON.stringify(o.id)})`);
          if (!Number.isInteger(o.guestPort) || o.guestPort < 1) return fail(`the load named no guest port (${JSON.stringify(o.guestPort)})`);
          // G1: a per-boot nonce from a monitor that has it; null only from an older monitor. Anything else is refused.
          if (o.boot != null && !HEX32.test(String(o.boot))) return fail(`the load's boot ${JSON.stringify(o.boot)} is not 32 hex`);
          return;
        case "relay":
          if (o.ok !== true) return fail("the relay step did not say ok");
          if (o.tcp !== tcpPort) return fail(`the relay is on ${o.tcp}, not the port asked for (${tcpPort})`);
          if (o.guestPort !== got.load.guestPort) return fail(`the relay carries guest port ${o.guestPort}, not the loaded domain's ${got.load.guestPort}`);
          return;
        case "ready":
          settled = true; clearTimeout(timer);
          log(`wmiserve ${vmId}: ready (domain ${got.load.id}, relay ${tcpPort})`);
          resolve({ pid: child.pid, launcherKey: got.launcher.key, domainId: got.load.id, boot: got.load.boot ?? null,
                    appSha256: got.load.appSha256, guestPort: got.load.guestPort, tcpPort, note: o.note ?? null, exited,
                    stop: () => stopRun() });
          return;
      }
    };
    const stopRun = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return { closed: closedSeen, how: "already exited" };
      // A NON-BLANK line: wmiserve ignores a blank one and keeps reading (d1), so "\n" alone only ever stopped it through
      // the EOF that followed. Both are sent, and the line path is the one that should close it.
      try { child.stdin.write("stop\n"); child.stdin.end(); } catch { /* the pipe is gone: the exit below says what happened */ }
      const deadline = new Promise((r) => setTimeout(() => r("deadline"), closeTimeoutMs));
      const how = await Promise.race([exited.then(() => "exited"), deadline]);
      if (how === "deadline") { kill(); await exited; return { closed: closedSeen, how: "killed after the close deadline" }; }
      return { closed: closedSeen, how: closedSeen ? "closed" : "exited without saying closed" };
    };

    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { return fail(`a line that is not JSON: ${line.slice(0, 120)}`); }
        if (!o || typeof o.step !== "string") return fail(`a line with no step: ${line.slice(0, 120)}`);
        onStep(o);
      }
    });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    child.on("error", (e) => fail(`could not run: ${e.message}`));
    child.on("exit", (code, signal) => {
      exitResolve({ code, signal });
      if (!settled) fail(`exited before "ready" (code ${code}${signal ? `, ${signal}` : ""}; last step: ${STEPS[next - 1] || "none"})`);
    });
  });
}
