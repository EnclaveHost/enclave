/* EVERY PARTITION'S CONSOLE, KEPT. Each partition's COM1 is a named pipe (\\.\pipe\<vmName>-com1, wmi-launcher.mjs
   pipeFor) and the guest kernel runs with console=ttyS0. The launcher reads it for the boot window only (startAndRead,
   until the ready line), and nothing read it afterwards: a later panic, OOM kill or poweroff left no trace on the host
   (2026-10-14 03:52:30Z: RISC Box's partition was "turned off" twice, Worker-Admin 18502, and nobody could say why).

   So once a partition is started - its record carries a handle, which the manager sets only after the launcher's boot
   read has finished and its reader process has exited - this attaches to its COM1 pipe and appends everything to
   <dir>/<vmName>.log, by default C:\ProgramData\Enclave\logs\partitions (beside shield.log).

   BOUNDED: each file rotates to <vmName>.log.1 at maxBytes (one old file kept); logs of partitions that no longer exist
   are deleted after keepMs, and no more than maxFiles are kept. A pipe that closes while the partition is still
   listed is reconnected with backoff; a partition that is removed is let go.
   UNTRUSTED: the guest's bytes are written to the file raw and are never parsed, decoded or echoed anywhere. shield.log
   gets only this module's own one-line notices (attach, detach, stop, an error), each naming the VM, never guest text.
   NEVER FATAL: every error here is swallowed into one notice line; the manager does not wait on, or fail by, any of it.
*/
import net from "node:net";
import nodeFs from "node:fs";
import path from "node:path";

export const CONSOLE_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const CONSOLE_LOG_MAX_FILES = 40;
export const CONSOLE_LOG_KEEP_MS = 24 * 60 * 60 * 1000;
export const CONSOLE_BACKOFF_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const FILE = /^([A-Za-z0-9._-]{1,128})\.log(\.1)?$/;

/** The default pipe of a partition, as the launcher names it (wmi-launcher.mjs pipeFor). */
export const comPipeFor = (vmName) => `\\\\.\\pipe\\${vmName}-com1`;

/**
 * Where partition consoles go: ENCLAVE_PARTITION_LOG_DIR when set ("0"/"off" disables), otherwise
 * %ProgramData%\Enclave\logs\partitions on Windows (the installer's logs directory), otherwise nowhere.
 */
export function partitionLogDir(env = process.env, platform = process.platform) {
  const set = String(env.ENCLAVE_PARTITION_LOG_DIR ?? "").trim();
  if (set) return /^(0|off|false|none)$/i.test(set) ? null : set;
  if (platform === "win32" && env.ProgramData) return path.win32.join(env.ProgramData, "Enclave", "logs", "partitions");
  return null;
}

/**
 * The partitions whose consoles should be read, from the manager's records: every record past its launch (so the boot
 * read is over) whose handle names a VM, recovered ones included, until the record goes (removed, or stopped).
 */
export function consoleTargets(manager) {
  const out = [];
  for (const rec of manager?.domains?.values?.() ?? []) {
    if (!rec || rec.launching || rec.status === "stopped") continue;
    const name = rec.handle && rec.handle.name;
    if (!name || !NAME.test(String(name))) continue;
    out.push({ vmName: String(name), pipe: rec.handle.pipe ? String(rec.handle.pipe) : comPipeFor(name) });
  }
  return out;
}

export class PartitionConsoleLogs {
  /**
   * @param dir        the partition log directory (created on first write)
   * @param connect    (pipePath) -> a net.Socket-like EventEmitter; node's net.connect({ path }) by default
   * @param fs         node:fs or a stand-in (mkdirSync, openSync, fstatSync, writeSync, closeSync, renameSync, rmSync,
   *                   readdirSync, statSync)
   * @param log        one line to the manager's own log
   */
  constructor({ dir, connect = (p) => net.connect({ path: p }), fs = nodeFs, log = (m) => console.log(m), now = Date.now,
                setTimer = setTimeout, clearTimer = clearTimeout, maxBytes = CONSOLE_LOG_MAX_BYTES,
                maxFiles = CONSOLE_LOG_MAX_FILES, keepMs = CONSOLE_LOG_KEEP_MS, backoffMs = CONSOLE_BACKOFF_MS,
                pruneEveryMs = 10 * 60 * 1000 } = {}) {
    if (!dir) throw new Error("a partition log directory is required");
    Object.assign(this, { dir, connect, fs, now, setTimer, clearTimer, maxBytes, maxFiles, keepMs, backoffMs, pruneEveryMs });
    this.log = (m) => { try { log(`[winmgr] console ${m}`); } catch { /* a log that fails is not a reason to fail */ } };
    this.lastPrune = -Infinity;
  }
  #w = new Map();
  get watching() { return [...this.#w.keys()]; }
  fileFor(vmName) { return path.join(this.dir, `${vmName}.log`); }

  /** Start reading one partition's console (idempotent: a partition already read is left alone). */
  watch(vmName, pipe = comPipeFor(vmName)) {
    try {
      vmName = String(vmName);
      if (!NAME.test(vmName) || this.#w.has(vmName)) return false;
      const w = { vmName, pipe: String(pipe), file: this.fileFor(vmName), fd: null, size: 0, sock: null, timer: null,
                  attempt: 0, stopped: false, quiet: false, said: new Set(), bytes: 0, everAttached: false };
      this.#w.set(vmName, w);
      this.#connect(w);
      return true;
    } catch (e) { this.log(`${vmName}: not read (${e.message})`); return false; }
  }

  /** Stop reading one partition and close its file (the file is kept, for prune to age out). */
  unwatch(vmName, why = "the partition was removed") {
    const w = this.#w.get(vmName);
    if (!w) return false;
    this.#w.delete(vmName);
    w.stopped = true;
    try { if (w.timer) this.clearTimer(w.timer); } catch {}
    w.timer = null;
    const sock = w.sock; w.sock = null;
    try { sock?.destroy?.(); } catch {}
    this.#mark(w, `stopped: ${why}`);
    this.#closeFd(w);
    this.log(`${vmName}: stopped reading COM1 (${why}); ${w.bytes} bytes captured this run`);
    return true;
  }

  /** Read exactly these partitions: start the new ones, stop the ones no longer listed, and age old files out. */
  sync(targets) {
    try {
      const want = new Map();
      for (const t of targets || []) if (t && t.vmName) want.set(String(t.vmName), t.pipe || comPipeFor(t.vmName));
      for (const name of [...this.#w.keys()]) if (!want.has(name)) this.unwatch(name);
      for (const [name, pipe] of want) if (!this.#w.has(name)) this.watch(name, pipe);
      if (this.now() - this.lastPrune >= this.pruneEveryMs) this.prune();
    } catch (e) { this.log(`sync failed: ${e.message}`); }
  }

  /**
   * Delete the logs of partitions that are not being read once they are older than keepMs, then the oldest such logs
   * until no more than maxFiles remain. A partition being read never loses its file. -> the names deleted.
   */
  prune() {
    this.lastPrune = this.now();
    const gone = [];
    let names;
    try { names = this.fs.readdirSync(this.dir); }
    catch (e) { if (e?.code !== "ENOENT") this.log(`prune: cannot list ${this.dir} (${e.message})`); return gone; }
    const files = [];
    for (const f of names) {
      const m = FILE.exec(String(f));
      if (!m) continue;
      let mtime = 0;
      try { mtime = this.fs.statSync(path.join(this.dir, f)).mtimeMs; } catch { continue; }
      files.push({ f, vm: m[1], mtime, active: this.#w.has(m[1]) });
    }
    const rm = (x) => {
      try { this.fs.rmSync(path.join(this.dir, x.f), { force: true }); gone.push(x.f); x.removed = true; }
      catch (e) { this.log(`prune: cannot delete ${x.f} (${e.message})`); }
    };
    const cutoff = this.now() - this.keepMs;
    for (const x of files) if (!x.active && x.mtime < cutoff) rm(x);
    let left = files.filter((x) => !x.removed);
    if (left.length > this.maxFiles) {
      for (const x of left.filter((y) => !y.active).sort((a, b) => a.mtime - b.mtime)) {
        if (left.length <= this.maxFiles) break;
        rm(x); if (x.removed) left = left.filter((y) => y !== x);
      }
    }
    return gone;
  }

  /** Stop everything (the manager is exiting). */
  close() { for (const name of [...this.#w.keys()]) this.unwatch(name, "the manager is stopping"); }

  #connect(w) {
    w.timer = null;
    if (w.stopped) return;
    let sock;
    try { sock = this.connect(w.pipe); }
    catch (e) { this.#retry(w, e, false); return; }
    w.sock = sock;
    let attached = false, lastError = null;
    sock.on("error", (e) => { lastError = e; });            // first, so no error is ever unhandled
    sock.on("connect", () => {
      if (w.sock !== sock || w.stopped) return;
      attached = true; w.quiet = false;
      if (!w.everAttached) this.log(`${w.vmName}: reading COM1 into ${w.file}`);
      w.everAttached = true;
      this.#mark(w, `attached to ${w.pipe}`);
    });
    sock.on("data", (b) => {
      if (w.sock !== sock || w.stopped) return;
      w.attempt = 0;                                          // it spoke: the next disconnect starts the backoff over
      this.#append(w, Buffer.isBuffer(b) ? b : Buffer.from(b));
    });
    sock.on("close", () => {
      if (w.sock !== sock) return;
      w.sock = null;
      if (w.stopped) return;
      if (attached) this.#mark(w, `detached${lastError ? ` (${lastError.code || lastError.message})` : ""}`);
      this.#retry(w, lastError, attached);
    });
  }

  #retry(w, err, wasAttached) {
    if (w.stopped) return;
    const delay = this.backoffMs[Math.min(w.attempt, this.backoffMs.length - 1)];
    w.attempt++;
    // ONE line per outage: the first failure after an attach (or the first ever), then quiet until it attaches again
    if (!w.quiet) {
      w.quiet = true;
      const why = err ? String(err.code || err.message).slice(0, 120) : "the pipe closed";
      this.log(`${w.vmName}: COM1 ${wasAttached ? "closed" : "not reachable"} (${why}); retrying with backoff while the partition is listed`);
    }
    try { w.timer = this.setTimer(() => this.#connect(w), delay); w.timer?.unref?.(); }
    catch (e) { this.#say(w, "timer", `cannot schedule a reconnect (${e.message})`); }
  }

  /** A marker line of this module's own, in the file only, so a reader can see when the pipe opened and closed. */
  #mark(w, what) {
    this.#append(w, Buffer.from(`\n[enclave-console ${new Date(this.now()).toISOString()}] ${what}\n`, "utf8"));
  }

  #append(w, buf) {
    try {
      if (buf.length > this.maxBytes) buf = buf.subarray(buf.length - this.maxBytes);
      if (w.fd === null) this.#open(w);
      if (w.size > 0 && w.size + buf.length > this.maxBytes) this.#rotate(w);
      let off = 0;
      while (off < buf.length) {
        const n = this.fs.writeSync(w.fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error("the write made no progress");
        off += n;
      }
      w.size += buf.length; w.bytes += buf.length;
    } catch (e) {
      this.#say(w, `write:${e.code || "error"}`, `cannot write ${w.file} (${e.message}); the output is dropped`);
      this.#closeFd(w);
    }
  }
  #open(w) {
    this.fs.mkdirSync(this.dir, { recursive: true });
    w.fd = this.fs.openSync(w.file, "a");
    try { w.size = Number(this.fs.fstatSync(w.fd).size) || 0; } catch { w.size = 0; }
  }
  #rotate(w) {
    this.#closeFd(w);
    try { this.fs.rmSync(`${w.file}.1`, { force: true }); } catch {}
    this.fs.renameSync(w.file, `${w.file}.1`);
    this.#open(w);
  }
  #closeFd(w) {
    const fd = w.fd; w.fd = null; w.size = 0;
    if (fd !== null) try { this.fs.closeSync(fd); } catch {}
  }
  /** One notice per kind per watcher, so a full disk is said once rather than once per chunk. */
  #say(w, kind, msg) {
    if (w.said.has(kind)) return;
    w.said.add(kind);
    this.log(`${w.vmName}: ${msg}`);
  }
}
