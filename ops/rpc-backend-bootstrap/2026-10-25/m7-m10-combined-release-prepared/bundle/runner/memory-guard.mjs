#!/usr/bin/env node
// Run ONE command under a memory allocation and stop only that command's own process tree when it is exceeded:
//   node test/helpers/memory-guard.mjs --max-rss-mib 768 --floor-available-mib 16384 [--log FILE] -- <command> [args...]
// Every 250 ms it sums the RSS of the command and all its descendants (/proc) and reads the host's MemAvailable. If the tree
// exceeds --max-rss-mib, or the host's available memory falls below --floor-available-mib, it sends SIGTERM to the whole tree
// (SIGKILL two seconds later), reports which limit was hit, and exits 99. It never retries. When the command exits by itself
// (or aborts), whatever it left running - its own process group, and every descendant last seen - is killed, so a crashed
// test never leaves an anvil or a browser behind. Linux only.
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2), sep = argv.indexOf("--");
if (sep < 0) { console.error("usage: memory-guard.mjs --max-rss-mib N --floor-available-mib N [--log FILE] -- command ..."); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i < sep ? argv[i + 1] : d; };
const MAX = Number(opt("--max-rss-mib", 768)), FLOOR = Number(opt("--floor-available-mib", 16384)), LOG = opt("--log", null);
const [cmd, ...args] = argv.slice(sep + 1);

const child = spawn(cmd, args, { stdio: "inherit", detached: true });
let peak = 0, minAvail = Infinity, stopped = null, peakBreakdown = [], lastSeen = [];
const kids = () => {
  const byParent = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      (byParent.get(ppid) || byParent.set(ppid, []).get(ppid)).push(Number(d)); } catch {}
  }
  const out = [], q = [child.pid];
  while (q.length) { const p = q.shift(); out.push(p); for (const c of byParent.get(p) || []) q.push(c); }
  return out;
};
const procRss = (p) => { try { const st = fs.readFileSync(`/proc/${p}/status`, "utf8"); const m = /VmRSS:\s+(\d+) kB/.exec(st), n = /Name:\s+(\S+)/.exec(st);
  return { pid: p, name: n ? n[1] : "?", mib: m ? Number(m[1]) / 1024 : 0 }; } catch { return { pid: p, name: "?", mib: 0 }; } };
const rssMib = (pids) => pids.reduce((sum, p) => { try { const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p}/status`, "utf8")); return sum + (m ? Number(m[1]) : 0); } catch { return sum; } }, 0) / 1024;
const availMib = () => Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1024;
const stop = (why) => {
  if (stopped) return; stopped = why;
  console.error(`\n[memory-guard] STOPPING own job: ${why}`);
  for (const p of kids().reverse()) { try { process.kill(p, "SIGTERM"); } catch {} }
  setTimeout(() => { for (const p of kids().reverse()) { try { process.kill(p, "SIGKILL"); } catch {} } }, 2000).unref();
};
const timer = setInterval(() => {
  const pids = kids(), rss = rssMib(pids), avail = availMib();
  lastSeen = pids;
  if (rss > peak){ peak = rss; peakBreakdown = pids.map(procRss).filter((x) => x.mib > 1).sort((a, b) => b.mib - a.mib).slice(0, 8); }
  minAvail = Math.min(minAvail, avail);
  if (rss > MAX) stop(`process tree RSS ${rss.toFixed(0)} MiB > ${MAX} MiB`);
  else if (avail < FLOOR) stop(`host MemAvailable ${avail.toFixed(0)} MiB < floor ${FLOOR} MiB`);
}, 250);
child.on("exit", (code, signal) => {
  clearInterval(timer);
  // leftovers: the command's process group (orphans keep it) and any descendant seen on the last sample
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  for (const p of lastSeen) if (p !== child.pid){ try { process.kill(p, "SIGKILL"); } catch {} }
  const line = `[memory-guard] exit=${code ?? signal} peakTreeRssMiB=${peak.toFixed(0)} minHostAvailableMiB=${minAvail === Infinity ? "n/a" : minAvail.toFixed(0)}${stopped ? " STOPPED: " + stopped : ""}`;
  console.error(line);
  console.error("[memory-guard] at peak: " + peakBreakdown.map((x) => x.name + ":" + x.mib.toFixed(0)).join(" "));
  if (LOG) fs.appendFileSync(LOG, line + "\n");
  process.exit(stopped ? 99 : (code ?? 1));
});
