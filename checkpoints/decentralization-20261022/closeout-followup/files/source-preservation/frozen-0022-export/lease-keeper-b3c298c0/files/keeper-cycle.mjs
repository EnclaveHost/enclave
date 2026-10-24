#!/usr/bin/env node
// ONE keeper cycle (root runs it through the unchanged queue, 256 MiB; keeper-loop.sh repeats it):
//   node keeper-cycle.mjs --init          once: writes state/keeper.json (pins + start time; the 4 h TTL counts from here)
//   node keeper-cycle.mjs                 one cycle; prints one JSON line (no key, no signature, no raw lease); exit code:
//     0 continue | 3 STOP: reconcile an ambiguous signed attempt | 4 STOP: refused (not metal0's lease / guest / pins)
//     5 transient (next cycle) | 6 another cycle is running | 10 done (both normal renewals seen, root STOP, or TTL)
// A hard 240 s deadline ends the process; a renewal it interrupts leaves its intent, so the next cycle stops (exit 3).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cycle, init, lock, EXIT } from "./lib.mjs";
const DIR = process.env.KEEPER_STATE || path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
const now = () => Math.floor(Date.now() / 1000);
if (process.argv.includes("--init")) { init(DIR, now()); console.log(JSON.stringify({ init: DIR, startedAt: now() })); process.exit(0); }
const unlock = lock(DIR);
if (!unlock) { console.log(JSON.stringify({ code: EXIT.BUSY, why: "another keeper cycle holds the lock" })); process.exit(EXIT.BUSY); }
const t = setTimeout(() => { console.log(JSON.stringify({ code: EXIT.TRANSIENT, why: "240 s cycle deadline" })); unlock(); process.exit(EXIT.TRANSIENT); }, 240_000);
try {
  const { deps } = await import(process.env.KEEPER_DEPS || "./deps.mjs");
  const r = await cycle({ dir: DIR, deps, now, log: (m) => console.error(m) });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  process.exitCode = r.code;
} catch (e) {
  console.log(JSON.stringify({ code: EXIT.TRANSIENT, why: String(e.message).slice(0, 200) })); process.exitCode = EXIT.TRANSIENT;
} finally { clearTimeout(t); unlock(); }
