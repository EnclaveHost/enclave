/* ============================================================
   Deployment run log — records each deploy run's output lines,
   persists the last 10 runs to localStorage, and broadcasts
   `enclave:runlog` events (start / id / line / end) so mounted
   views follow live.

   Lives outside any component so a run survives soft navigation:
   the deploy flow starts on apps.html#deploy, the router swaps
   <main> to the dashboard, and the same run keeps streaming into
   the panels there (<c-deployments>' live strip + row panels).
   A HARD reload kills the writer but not the record: the run
   restores flagged `interrupted`, and the dashboard resumes its
   watch (deploy.js resumeDeployWatch) via resume().
   ============================================================ */
import { emit, lsGet, lsSet } from "./util.js";

const KEY = "enclave_term_logs";

let runs = [];
try { runs = JSON.parse(lsGet(KEY) || "[]") || []; } catch (e) { runs = []; }
// restored runs have no live writer; one stored un-done was cut off by the
// unload (a refresh mid-deploy) - flag it so the dashboard can resume its watch
runs.forEach(r => { r.interrupted = !r.done; r.done = true; });
let cur = null;                          // the live (recording) run, if a deploy is in flight
let saveT = 0;

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try {
    lsSet(KEY, JSON.stringify(runs.slice(-10).map(r => ({ id: r.id, label: r.label, at: r.at, done: r.done, lines: r.lines.slice(-400) }))));
  } catch (e) {} }, 300);
}

export const runlog = {
  runs() { return runs; },
  current() { return cur && !cur.done ? cur : null; },
  /* the most recent recorded run for a deployment id (this browser only) */
  runFor(id) {
    const want = String(id || "").toLowerCase();
    if (!want) return null;
    for (let i = runs.length - 1; i >= 0; i--)
      if ((runs[i].id || "").toLowerCase() === want) return runs[i];
    return null;
  },
  /* the newest run a page unload cut off mid-deploy (this browser only) */
  interrupted() {
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].interrupted) return runs[i];
    return null;
  },

  startRun() {
    if (cur && !cur.done) runlog.endRun();
    const d = new Date();
    cur = { id: null,
            label: "run " + d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            at: Date.now(), done: false, lines: [] };
    runs.push(cur); if (runs.length > 10) runs.splice(0, runs.length - 10);
    save();
    emit("enclave:runlog", { type: "start", run: cur });
  },

  line(cls, txt) {
    if (!cur || cur.done) runlog.startRun();
    cur.lines.push([cls, txt]);
    // name the run after its deployment id the moment one appears in the text.
    // bytes32 ids read exactly like tx hashes (and the "↳ sent 0x…" line comes
    // FIRST), so 0x…64 only counts right after "created"; the deploy flow also
    // names the run explicitly via setId().
    if (!cur.id) { const m = /\b(dep_[a-z0-9]+)\b/.exec(txt) || /\bcreated (0x[0-9a-f]{64})\b/i.exec(txt); if (m) runlog.setId(m[1]); }
    save();
    emit("enclave:runlog", { type: "line", run: cur, cls: cls, txt: txt });
  },

  /* name the live run after its deployment id (the deploy flow calls this the
     moment create()'s receipt yields one) */
  setId(id) {
    if (!cur || cur.done || !id || cur.id === id) return;
    cur.id = id;
    save();
    emit("enclave:runlog", { type: "id", run: cur });
  },

  /* reopen an interrupted run so a resumed watcher can keep appending to the
     same record. Returns a writer BOUND to that run - it goes quiet if a new
     deploy's startRun() takes the log over - or null when a live run already
     owns the log. */
  resume(run) {
    if (cur && !cur.done) return null;
    run.interrupted = false; run.done = false; cur = run;
    save();
    emit("enclave:runlog", { type: "start", run: run });
    const dead = () => cur !== run || run.done;
    return {
      dead,
      line(cls, txt) { if (!dead()) runlog.line(cls, txt); },
      setId(id) { if (!dead()) runlog.setId(id); },
      end() { if (!dead()) runlog.endRun(); },
    };
  },

  endRun() {
    if (!cur || cur.done) return;
    cur.done = true;
    save();
    emit("enclave:runlog", { type: "end", run: cur });
    cur = null;
  },
};

/* Append one styled line to a .term container: repeated identical lines
   collapse into a (xN) counter, and the view follows the tail only when the
   reader is already at (or near) the bottom — never yank someone out of
   scrollback. `scroller` (optional) is the element that actually scrolls
   when it isn't the container itself. */
export function paintLine(container, cls, txt, scroller) {
  if (!container) return;
  const sc = scroller || container;
  const follow = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  const last = container.lastElementChild;
  if (last && last.dataset && last.dataset.raw === txt && last.className === "ln " + cls) {
    const n = parseInt(last.dataset.n || "1", 10) + 1;
    last.dataset.n = String(n);
    last.textContent = txt + "  (x" + n + ")";
    if (follow) sc.scrollTop = sc.scrollHeight;
    return;
  }
  const s = document.createElement("span");
  s.className = "ln " + cls; s.textContent = txt; s.dataset.raw = txt;
  container.appendChild(s);
  if (follow) sc.scrollTop = sc.scrollHeight;
}
