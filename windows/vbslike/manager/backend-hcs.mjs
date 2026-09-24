/* ============================================================
   The HCS backend: one Hyper-V child partition per app, TODAY, with no role and no reboot.

   WHAT THIS IS AND IS NOT. An HCS child partition is scheduled by the hypervisor and separated from
   every other partition, but the HOST IS NOT EXCLUDED from it: the root partition can read its
   memory. The guest says so itself on boot -

       MON boundary tier=t0-hv vmpl=n/a partition=hcs-child host_excluded=no

   - and this backend carries that word all the way up rather than letting it get lost between here
   and a fleet row. It is a DEVELOPMENT path: it exists so the whole stack above the boundary
   (delivery, readiness, the data plane, a real app on a real route) can be built and proven while
   the isolated-partition decision is somebody else's to take. Nothing it runs may ever be
   advertised as eligible, verified, or host-excluded capacity.

   HOW IT DRIVES THE LAUNCHER. `vbslike-host lab` already implements the whole path - a partition
   per app, the same monitor image in each, the bundle pushed over hv_sock control port 9000 with
   HASH AGREEMENT both sides, a host TCP relay to the domain's port, and report signing bound to
   that partition. It speaks a line protocol on stdin and answers JSON on stdout. So this is a
   client of that, not a reimplementation: porting the working thing rather than rebuilding it.
   ============================================================ */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BACKEND_HCS = "hyperv-partition-per-app";
/** Every one false, exactly as the isolated backend: this path sells no more than that one does. */
export const SUPPORTS_HCS = Object.freeze({
  gpu: false, secrets: false, egress: false, config: false, ports: false, configCid: false,
});

/** What this boundary actually is, in the words the guest itself uses. */
export const BOUNDARY = Object.freeze({
  tier: "t0-hv",
  partition: "hcs-child",
  hostExcluded: false,
  attested: false,
  note: "a Hyper-V child partition: separated from other partitions, NOT from this host. The root "
      + "partition can read its memory. Development path only; never advertise it as verified or "
      + "host-excluded capacity.",
});

export class HcsPartitionBackend {
  /**
   * @param exe        path to vbslike-host.exe
   * @param kernel/initrd  the guest image: the SAME pair the isolated partition will boot
   * @param spawnFn    injected for tests; production uses child_process.spawn
   */
  constructor({ exe, kernel, initrd, out, tcpBase = 19000, memMiB = 1024, vcpus = 2,
                spawnFn = null, startTimeoutMs = 60_000, loadTimeoutMs = 120_000 } = {}) {
    this.exe = exe; this.kernel = kernel; this.initrd = initrd; this.out = out;
    this.tcpBase = tcpBase; this.memMiB = memMiB; this.vcpus = vcpus;
    this.spawnFn = spawnFn || spawn;
    this.startTimeoutMs = startTimeoutMs; this.loadTimeoutMs = loadTimeoutMs;
    this.proc = null; this.ready = null; this.launcher = null;
    this.domains = new Map();          // instanceId -> { id, label, tcpPort, appSha256 }
    this.#lines = []; this.#waiters = [];
  }
  #lines; #waiters;

  get backend() { return BACKEND_HCS; }
  get supports() { return SUPPORTS_HCS; }
  get boundary() { return BOUNDARY; }

  /** Honest preflight: this path needs no role, so it reports what it DOES need. */
  async preflight() {
    const checks = [];
    for (const [name, p] of [["launcher", this.exe], ["guest kernel", this.kernel], ["guest initrd", this.initrd]]) {
      let ok = false, detail = "";
      try { const st = await fs.stat(p); ok = st.isFile(); detail = `${st.size} bytes`; }
      catch (e) { detail = e.message; }
      checks.push({ name, ok, detail: `${p}: ${detail}` });
    }
    checks.push({ name: "host excluded", ok: false,
                  detail: "an HCS child partition does not exclude this host; development path only" });
    // `ok` is about being able to RUN, which this path can. The boundary is reported separately and
    // is never folded into this boolean, because a reader who sees ok:true must not conclude more.
    return { ok: checks.slice(0, 3).every((c) => c.ok), checks, boundary: BOUNDARY };
  }

  #onLine(line) {
    const t = String(line).trim();
    if (!t) return;
    let j = null;
    try { j = JSON.parse(t); } catch { return; }      // the lab prints only JSON lines
    // hand the line to the OLDEST outstanding command, alive or dead: a dead one swallows the
    // answer it was owed rather than letting it shift onto somebody else's command
    while (this.#waiters.length) {
      const w = this.#waiters.shift();
      if (w.dead) return;                    // this answer belonged to the timed-out command
      w.deliver(j);
      return;
    }
    this.#lines.push(j);
  }
  /**
   * DEFECT 3. The lab protocol has NO request ids: answers are one JSON line per command, in order.
   * The first version removed a waiter that timed out - and the launcher's answer still arrived and
   * was handed to the NEXT command. After one `load` timeout every later answer was off by one, so
   * `stop` read the stale "loaded" line as its destroy answer while the partition was still there.
   *
   * So a timed-out waiter is NOT removed. It stays in the queue, marked dead, and when its answer
   * eventually arrives it is CONSUMED by it and discarded. Correlation is positional, so the only
   * safe thing to do with a late answer is to let it settle the command it belonged to.
   */
  #next(timeoutMs) {
    if (this.#lines.length) return Promise.resolve(this.#lines.shift());
    return new Promise((res, rej) => {
      const w = { dead: false, deliver: (j) => { clearTimeout(timer); res(j); } };
      const timer = setTimeout(() => {
        w.dead = true;                       // stays queued: its answer is still coming and is still ITS answer
        rej(new Error(`the launcher did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#waiters.push(w);
    });
  }

  /** Start the launcher once. It holds every partition, so it outlives individual domains. */
  async open() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const pre = await this.preflight();
      if (!pre.ok) {
        const missing = pre.checks.filter((c, i) => i < 3 && !c.ok).map((c) => c.name);
        throw Object.assign(new Error(`the launcher cannot start: missing ${missing.join(", ")}`), { code: "launcher_missing", checks: pre.checks });
      }
      const args = ["lab", "--kernel", this.kernel, "--initrd", this.initrd, "--out", this.out,
                    "--mem", String(this.memMiB), "--cpus", String(this.vcpus), "--tcp-base", String(this.tcpBase)];
      this.proc = this.spawnFn(this.exe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      this.proc.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i; while ((i = buf.indexOf("\n")) >= 0) { this.#onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      this.proc.stderr?.on("data", () => {});
      this.proc.on("exit", (code) => { this.proc = null; this.ready = null;
        while (this.#waiters.length) { const w = this.#waiters.shift(); if (!w.dead) w.deliver({ error: `the launcher exited ${code}` }); } });
      const hello = await this.#next(this.startTimeoutMs);
      if (hello.ready !== true) throw new Error(`the launcher did not report ready: ${JSON.stringify(hello).slice(0, 200)}`);
      this.launcher = hello;
      return hello;
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async #cmd(line, timeoutMs) {
    await this.open();
    this.proc.stdin.write(line + "\n");
    const j = await this.#next(timeoutMs);
    if (j && j.error) throw Object.assign(new Error(String(j.error)), { code: "launcher_error" });
    return j;
  }

  /**
   * One partition for one domain. The bundle goes in over hv_sock and the monitor answers with the
   * AppID it computed; the launcher already refuses a mismatch, and this checks it AGAIN against
   * what we derived - two sides deriving the same identity is the whole point of the contract.
   */
  async start(mapping, { instanceId } = {}) {
    if (!instanceId) throw new Error("a unique instanceId is required");
    if (!mapping || !mapping.bundle) throw new Error("the mapping carries no bundle bytes to load");
    await this.open();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "enclave-bundle-"));
    const file = path.join(dir, `${instanceId}.bundle`);
    let loadedId = null;        // the launcher's numeric domain id, once the load answer names it
    try {
      await fs.writeFile(file, mapping.bundle);
      const r = await this.#cmd(`load ${instanceId} ${file}`, this.loadTimeoutMs);
      const d = r && r.loaded;
      if (!d) throw new Error(`the launcher did not load it: ${JSON.stringify(r).slice(0, 200)}`);
      loadedId = d.id;          // from HERE on there is a live partition to destroy if anything fails
      // HASH AGREEMENT, checked here too: the guest's answer must be the AppID we derived.
      if (String(d.appSha256 || "").toLowerCase() !== String(mapping.appId).toLowerCase())
        throw new Error(`the guest computed ${d.appSha256}, we derived ${mapping.appId}: refusing`);
      const handle = { instanceId, backend: BACKEND_HCS, domainId: d.id, label: d.label ?? instanceId,
                       vmId: d.vmId, appId: mapping.appId, tcpPort: d.tcpPort, guestPort: d.guestPort,
                       boundary: BOUNDARY,
                       // THE IMAGE IDENTITY for this tier. There is no launch measurement on a
                       // Hyper-V child partition, so what names the guest is the initrd the
                       // launcher actually booted, from its own ready line. 5d's datapath admits a
                       // route on `image` + `transportKeySha256` and refuses without them, and
                       // server.mjs copies h.image into the record - but nothing ever PUT it on the
                       // handle, so the record read null and nothing could be routed (enclave-99,
                       // measured through the real backend with a lab-faithful fake). The value was
                       // in hand the whole time.
                       image: this.launcher?.initrdSha256 ?? null,
                       launcherKey: this.launcher?.launcherKey ?? null,
                       // The guest booted and took the bundle. Whether the APP answers is a separate
                       // question with its own signal, and this backend does not pretend to know it.
                       guest: { booted: true, loaded: true }, appReady: false };
      this.domains.set(instanceId, handle);
      return handle;
    } catch (e) {
      // DEFECT 2. `destroy` takes the launcher's NUMERIC domain id (lab.rs parses its argument with
      // s.parse::<u32>()), and this sent the LABEL - so the lab answered
      // {"error":"invalid digit found in string"}, .catch swallowed it, and after a hash mismatch
      // the partition the launcher had already loaded stayed LIVE while this map forgot it. The
      // load answer carries the id; destroy by that, and only when we actually got one.
      if (loadedId != null) {
        const d = await this.#cmd(`destroy ${loadedId}`, 30_000).catch((x) => ({ error: x.message }));
        if (d && d.error)
          e.message += `; AND the partition (domain ${loadedId}) could not be destroyed: ${d.error}`;
      }
      this.domains.delete(instanceId);
      throw e;
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  async stop(handle) {
    const id = handle && (handle.domainId ?? handle.instanceId);
    if (id == null) return { stopped: false, reason: "no handle" };
    const r = await this.#cmd(`destroy ${id}`, 60_000);
    this.domains.delete(handle.instanceId);
    return { stopped: true, guest: r && r.guest };
  }

  /** Everything this launcher holds. Its own process owns them, so there is no orphan sweep here. */
  async teardown() {
    const ids = [...this.domains.values()].map((d) => d.domainId);
    const failed = [];
    for (const id of ids) { try { await this.#cmd(`destroy ${id}`, 60_000); } catch (e) { failed.push({ id, error: e.message }); } }
    this.domains.clear();
    if (failed.length) throw Object.assign(new Error(`could not destroy ${failed.length} domain(s)`), { failed });
    return { removed: ids.length };
  }

  async close() { try { this.proc?.stdin?.end(); } catch {} this.proc = null; this.ready = null; }
}
