/* ============================================================
   Deployment run log — the recording half of what used to be
   <c-terminal>: one buffer per deploy run, persisted to
   localStorage (last 10 runs), broadcast as `enclave:runlog`
   events so any mounted terminal renders it live.

   Split out of the component so a run survives soft navigation:
   the deploy flow starts on apps.html#deploy, the router swaps
   <main> to the dashboard, and the same run keeps streaming into
   the terminal mounted there.
   ============================================================ */
import { emit, lsGet, lsSet } from "./util.js";

const KEY = "enclave_term_logs";

let runs = [];
try { runs = JSON.parse(lsGet(KEY) || "[]") || []; } catch (e) { runs = []; }
let cur = null;                     // the live (recording) run, if a deploy is in flight
let saveT = 0;

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try {
    lsSet(KEY, JSON.stringify(runs.slice(-10).map(r => ({ id: r.id, label: r.label, at: r.at, lines: r.lines.slice(-400) }))));
  } catch (e) {} }, 300);
}

export const runlog = {
  runs() { return runs; },
  current() { return cur; },

  startRun() {
    const d = new Date();
    cur = { id: null,
            label: "run " + d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            at: Date.now(), lines: [] };
    runs.push(cur); if (runs.length > 10) runs.splice(0, runs.length - 10);
    save();
    emit("enclave:runlog", { type: "start", run: cur });
  },

  line(cls, txt) {
    if (!cur) runlog.startRun();
    cur.lines.push([cls, txt]);
    // name the run after its deployment id the moment one appears in the text
    if (!cur.id) { const m = /\b(dep_[a-z0-9]+|0x[0-9a-f]{64})\b/i.exec(txt); if (m) { cur.id = m[1]; emit("enclave:runlog", { type: "id", run: cur }); } }
    save();
    emit("enclave:runlog", { type: "line", run: cur, cls: cls, txt: txt });
  },
};
