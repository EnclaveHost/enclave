/* ============================================================
   <c-terminal> — a VIEW of the deployment run log (js/core/runlog):
   a picker over the recorded runs and an output pane that follows
   the live run. The recording itself is the runlog singleton, so a
   deploy keeps streaming here across soft navigations and page
   reloads (localStorage restores past runs).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { runlog } from "../../js/core/runlog.js";

const IDLE_LINE = '<span class="ln dimln">// deploy an app to see its provisioning output here…</span>';

class Terminal extends EnclaveElement {
  static templateUrl = new URL("./terminal.html", import.meta.url);

  get _out(){ return this.querySelector(".term-out"); }
  get _sel(){ return this.querySelector(".term-sel"); }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._onLog = (e) => {
      const d = e.detail || {};
      if (d.type === "start"){ this._view = d.run; if (this._out) this._out.innerHTML = ""; this._renderSel(); }
      else if (d.type === "id") this._renderSel();
      else if (d.type === "line" && this._view === d.run) this._paint(d.cls, d.txt);
      // a line for a run the user isn't viewing still records; don't paint over their scrollback
    };
    document.addEventListener("enclave:runlog", this._onLog);
    const runs = runlog.runs();
    this._view = runs.length ? runs[runs.length - 1] : null;   // latest run (the live one, if any)
    this._renderSel();
    if (this._view) this._renderRun(this._view);
    else if (this._out) this._out.innerHTML = IDLE_LINE;
    this._sel.addEventListener("change", e => { const r = runlog.runs()[+e.target.value]; if (r) this._renderRun(r); });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onLog) document.removeEventListener("enclave:runlog", this._onLog);
    this._wired = false; this._onLog = null;
  }

  _renderSel() {
    const sel = this._sel; if (!sel) return;
    const runs = runlog.runs();
    if (!runs.length){ sel.innerHTML = '<option>no deployments yet</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    sel.innerHTML = runs.map((r, i) => '<option value="' + i + '">' +
      esc(r.id ? (r.id.length > 18 ? r.id.slice(0, 12) + "…" + r.id.slice(-4) : r.id) : r.label) + '</option>').join("");
    sel.value = String(runs.indexOf(this._view));
  }

  _renderRun(run) {
    const term = this._out; if (!term) return;
    this._view = run; term.innerHTML = "";
    if (!run || !run.lines.length){ term.innerHTML = '<span class="ln dimln">// no output recorded for this run</span>'; return; }
    run.lines.forEach(l => this._paint(l[0], l[1]));
    this._renderSel();
  }

  _paint(cls, txt) {
    const term = this._out; if (!term) return;
    // follow the tail only if the user is already at (or near) the bottom -
    // don't yank the view away from someone reading scrollback
    const follow = term.scrollHeight - term.scrollTop - term.clientHeight < 48;
    // collapse runs of identical lines (poll loops can emit hundreds of
    // "no live enclave has ..." retries) into one line with a repeat counter
    const last = term.lastElementChild;
    if (last && last.dataset && last.dataset.raw === txt && last.className === "ln " + cls){
      const n = parseInt(last.dataset.n || "1", 10) + 1;
      last.dataset.n = String(n);
      last.textContent = txt + "  (x" + n + ")";
      if (follow) term.scrollTop = term.scrollHeight;
      return;
    }
    const s = document.createElement("span");
    s.className = "ln " + cls; s.textContent = txt; s.dataset.raw = txt;
    term.appendChild(s);
    if (follow) term.scrollTop = term.scrollHeight;
  }
}
register("c-terminal", Terminal);
