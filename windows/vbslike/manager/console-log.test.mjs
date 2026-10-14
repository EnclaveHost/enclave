// Every partition's COM1, kept (console-log.mjs). MOCKED: an injected connect hands back a fake socket, timers are
// captured and fired by hand, and files go to a temporary directory (or an injected fs that fails).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PartitionConsoleLogs, consoleTargets, partitionLogDir, comPipeFor } from "./console-log.mjs";

class FakeSocket extends EventEmitter {
  constructor(pipe) { super(); this.pipe = pipe; this.destroyed = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; queueMicrotask(() => this.emit("close")); }
}
function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partition-logs-"));
  const sockets = [], timers = [], lines = [];
  let t = Date.parse("2026-10-14T03:50:00Z");
  const logs = new PartitionConsoleLogs({
    dir, log: (m) => lines.push(m), now: () => t,
    connect: (p) => { const s = new FakeSocket(p); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const x = { fn, ms, cleared: false }; timers.push(x); return x; },
    clearTimer: (x) => { x.cleared = true; },
    ...over,
  });
  const fire = () => { const x = timers.filter((y) => !y.cleared && !y.fired); for (const y of x) { y.fired = true; y.fn(); } return x.length; };
  return { dir, logs, sockets, timers, lines, fire, advance: (ms) => { t += ms; } };
}
const VM = "enclave-app-hv3f70187449d4ee-322c5206";
const tick = () => new Promise((r) => setImmediate(r));

test("the guest's bytes land in <dir>/<vmName>.log, raw, and never in the manager's own log", async () => {
  const { dir, logs, sockets, lines } = rig();
  assert.equal(logs.watch(VM), true);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].pipe, comPipeFor(VM), "the launcher's COM1 pipe");
  sockets[0].emit("connect");
  const panic = Buffer.from("[  812.1] Kernel panic - not syncing: Out of memory\r\n\x1b[31mSECRET-GUEST-TEXT\x00\xff\n", "latin1");
  sockets[0].emit("data", panic);
  const file = fs.readFileSync(path.join(dir, `${VM}.log`));
  assert.ok(file.includes(panic), "written byte for byte");
  assert.match(file.toString("latin1"), /\[enclave-console 2026-10-14T03:50:00\.000Z\] attached to/);
  assert.ok(lines.length >= 1 && lines.every((l) => !l.includes("SECRET-GUEST-TEXT") && !l.includes("panic")), lines.join("\n"));
  assert.ok(lines.every((l) => !l.includes("\n")), "notices are one line each");
});

test("a file rotates to .log.1 at the cap, and only one old file is kept", async () => {
  const { dir, logs, sockets } = rig({ maxBytes: 260 });
  logs.watch(VM); sockets[0].emit("connect");
  const f = path.join(dir, `${VM}.log`);
  sockets[0].emit("data", Buffer.alloc(140, "a"));
  assert.equal(fs.existsSync(`${f}.1`), false);
  sockets[0].emit("data", Buffer.alloc(140, "b"));           // would pass 260: rotate first
  assert.equal(fs.existsSync(`${f}.1`), true);
  assert.ok(fs.readFileSync(`${f}.1`, "latin1").includes("a".repeat(140)));
  assert.equal(fs.readFileSync(f, "latin1"), "b".repeat(140));
  sockets[0].emit("data", Buffer.alloc(140, "c"));
  assert.equal(fs.readFileSync(`${f}.1`, "latin1"), "b".repeat(140), "the older .1 was replaced");
  assert.equal(fs.readFileSync(f, "latin1"), "c".repeat(140));
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${VM}.log`, `${VM}.log.1`]);
  for (const x of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, x)).size <= 260);
});

test("a pipe that closes while the partition is listed is reconnected with backoff, into the same file", async () => {
  const { dir, logs, sockets, timers, lines, fire } = rig();
  logs.watch(VM); sockets[0].emit("connect"); sockets[0].emit("data", Buffer.from("before\n"));
  sockets[0].emit("error", Object.assign(new Error("pipe broken"), { code: "EPIPE" }));
  sockets[0].emit("close");
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1000);
  assert.equal(fire(), 1);
  assert.equal(sockets.length, 2, "connected again");
  // not there yet: each failure waits longer, and only ONE line is said for the whole outage
  sockets[1].emit("error", Object.assign(new Error("no such pipe"), { code: "ENOENT" })); sockets[1].emit("close");
  fire(); sockets[2].emit("error", new Error("again")); sockets[2].emit("close");
  assert.deepEqual(timers.map((x) => x.ms), [1000, 2000, 5000]);
  assert.equal(lines.filter((l) => /COM1 (closed|not reachable)/.test(l)).length, 1, lines.join("\n"));
  fire(); sockets[3].emit("connect"); sockets[3].emit("data", Buffer.from("after\n"));
  const text = fs.readFileSync(path.join(dir, `${VM}.log`), "utf8");
  assert.ok(text.indexOf("before") < text.indexOf("detached (EPIPE)") && text.indexOf("detached (EPIPE)") < text.indexOf("after"), text);
  // it spoke again, so the next outage starts the backoff over
  sockets[3].emit("close"); assert.equal(timers.at(-1).ms, 1000);
});

test("a partition that is removed is let go: its socket closes, no reconnect follows, later bytes are ignored", async () => {
  const { dir, logs, sockets, timers, lines, fire } = rig();
  logs.sync([{ vmName: VM, pipe: comPipeFor(VM) }, { vmName: "enclave-app-other-1234" }]);
  assert.deepEqual(logs.watching.sort(), ["enclave-app-other-1234", VM].sort());
  sockets[0].emit("connect"); sockets[0].emit("data", Buffer.from("hello\n"));
  logs.sync([{ vmName: "enclave-app-other-1234" }]);
  assert.deepEqual(logs.watching, ["enclave-app-other-1234"]);
  assert.equal(sockets[0].destroyed, true);
  await tick();                                                    // its close arrives after the stop
  sockets[0].emit("data", Buffer.from("late\n"));
  assert.equal(timers.filter((x) => !x.cleared).length, 0, "nothing scheduled for a removed partition");
  assert.equal(fire(), 0); assert.equal(sockets.length, 2);
  const text = fs.readFileSync(path.join(dir, `${VM}.log`), "utf8");
  assert.match(text, /hello/); assert.doesNotMatch(text, /late/); assert.match(text, /stopped: the partition was removed/);
  assert.ok(lines.some((l) => l.includes(`${VM}: stopped reading COM1`)));
  // a pending reconnect is cancelled too
  sockets[1].emit("close"); assert.equal(timers.filter((x) => !x.cleared && !x.fired).length, 1);
  logs.sync([]); assert.equal(timers.filter((x) => !x.cleared && !x.fired).length, 0); assert.equal(fire(), 0);
});

test("errors are swallowed into one line: a connect that throws, a socket error, a file that cannot be written", async () => {
  // connect throws synchronously
  const a = rig({ connect: () => { throw new Error("EACCES opening the pipe"); } });
  assert.doesNotThrow(() => a.logs.watch(VM));
  assert.equal(a.timers.length, 1, "retried later");
  assert.doesNotThrow(() => a.fire());
  assert.equal(a.lines.filter((l) => /not reachable/.test(l)).length, 1, a.lines.join("\n"));
  // the file cannot be opened: every chunk is dropped, ONE line is said, nothing throws
  const broken = { ...fs, mkdirSync: () => {}, openSync: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  const b = rig({ fs: broken });
  b.logs.watch(VM);
  assert.doesNotThrow(() => { b.sockets[0].emit("connect"); for (let i = 0; i < 50; i++) b.sockets[0].emit("data", Buffer.from("x")); });
  assert.equal(b.lines.filter((l) => /ENOSPC|disk full/.test(l)).length, 1, b.lines.join("\n"));
  // a socket error with no other listener does not crash the process
  assert.doesNotThrow(() => b.sockets[0].emit("error", new Error("boom")));
  // bad names are refused, not thrown; an unwritable directory does not stop sync
  assert.equal(b.logs.watch("..\\..\\evil"), false);
  const c = rig({ fs: { ...fs, readdirSync: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } } });
  assert.doesNotThrow(() => c.logs.sync([{ vmName: VM }]));
  assert.ok(c.lines.some((l) => /prune: cannot list/.test(l)));
  // a logger that throws is not fatal either
  const d = rig({ log: () => { throw new Error("stdout closed"); } });
  assert.doesNotThrow(() => { d.logs.watch(VM); d.sockets[0].emit("close"); });
});

test("prune: logs of partitions not being read go after 24 h, and at most maxFiles are kept; a live one is never deleted", () => {
  const { dir, logs, advance } = rig({ maxFiles: 4 });
  const now = Date.parse("2026-10-14T03:50:00Z");
  const put = (name, ageH) => { const f = path.join(dir, name); fs.writeFileSync(f, "x"); const s = (now - ageH * 3600e3) / 1000; fs.utimesSync(f, s, s); };
  put("enclave-app-old-1.log", 30); put("enclave-app-old-1.log.1", 31);
  put(`${VM}.log`, 48);                                              // old, but its partition is still read
  for (let i = 0; i < 5; i++) put(`enclave-app-recent-${i}.log`, i + 1);
  put("unrelated.txt", 100);
  logs.watch(VM);
  const gone = logs.prune();
  assert.ok(gone.includes("enclave-app-old-1.log") && gone.includes("enclave-app-old-1.log.1"));
  const left = fs.readdirSync(dir).filter((f) => f.endsWith(".log") || f.endsWith(".log.1")).sort();
  assert.equal(left.length, 4);
  assert.ok(left.includes(`${VM}.log`), "the live partition keeps its file");
  assert.deepEqual(left.filter((f) => f.startsWith("enclave-app-recent")), ["enclave-app-recent-0.log", "enclave-app-recent-1.log", "enclave-app-recent-2.log"]);
  assert.ok(fs.existsSync(path.join(dir, "unrelated.txt")), "only partition logs are touched");
  // sync prunes on its own schedule
  advance(11 * 60 * 1000); put("enclave-app-old-2.log", 25);
  logs.sync([{ vmName: VM }]);
  assert.equal(fs.existsSync(path.join(dir, "enclave-app-old-2.log")), false);
});

test("consoleTargets: started records with a VM handle, never one still launching, and the launcher's pipe when given", () => {
  const m = { domains: new Map([
    ["a", { status: "running", handle: { name: "enclave-app-a-1", pipe: "\\\\.\\pipe\\custom-com1" } }],
    ["b", { status: "starting", recovered: true, handle: { name: "enclave-app-b-2", recovered: true } }],
    ["c", { status: "starting", launching: true, handle: null }],
    ["d", { status: "failed", handle: { name: "enclave-app-d-3" } }],
    ["e", { status: "failed", handle: null }],
    ["f", { status: "stopped", handle: { name: "enclave-app-f-4" } }],
    ["g", { status: "running", handle: { name: "bad name\\..\\x" } }],
  ]) };
  assert.deepEqual(consoleTargets(m), [
    { vmName: "enclave-app-a-1", pipe: "\\\\.\\pipe\\custom-com1" },
    { vmName: "enclave-app-b-2", pipe: comPipeFor("enclave-app-b-2") },
    { vmName: "enclave-app-d-3", pipe: comPipeFor("enclave-app-d-3") },
  ]);
});

test("partitionLogDir: the setting, else ProgramData's logs\\partitions on Windows, else none", () => {
  assert.equal(partitionLogDir({ ENCLAVE_PARTITION_LOG_DIR: "D:\\logs\\p" }, "win32"), "D:\\logs\\p");
  assert.equal(partitionLogDir({ ENCLAVE_PARTITION_LOG_DIR: "off", ProgramData: "C:\\ProgramData" }, "win32"), null);
  assert.equal(partitionLogDir({ ProgramData: "C:\\ProgramData" }, "win32"), "C:\\ProgramData\\Enclave\\logs\\partitions");
  assert.equal(partitionLogDir({}, "linux"), null);
});
