/* ============================================================
   <c-live-verify> - the Overview's "don't take our word for it":
   one chip per kind of host that has a live, verifiable box (AMD
   SEV-SNP, phone pVM, Enclave Shield), and a button that verifies
   a host of that kind, chosen at random, IN THIS BROWSER with the
   repository's own verifier (core/verify.js). It stays one row
   however many hosts there are; picking a particular host is the
   fleet list's job (host#fleet), where every row has the check.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { liveBoxes, boxVerifiable, verifyBoxInBrowser, verificationHtml, TIER_NAMES } from "../../js/core/verify.js";

const TIERS = ["snp", "avf", "hv-node"];   // the order the chips read in

class LiveVerify extends EnclaveElement {
  static templateUrl = new URL("./live-verify.html", import.meta.url);

  renderedCallback() {
    const btn = this.querySelector(".lv-run");
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", () => this.verify(btn));
    this.loadTiers();
  }

  // the chips: only kinds with at least one verifiable host now; a failed read leaves them hidden (the button still works)
  async loadTiers() {
    try {
      const rows = (await liveBoxes()).filter(boxVerifiable);
      this._by = new Map(TIERS.map((m) => [m, rows.filter((e) => e.mode === m)]).filter(([, l]) => l.length));
      if (this._by.size < 2) return;
      this._tier = this._by.keys().next().value;
      const box = this.querySelector(".lv-tiers");
      box.innerHTML = [...this._by].map(([m, l]) => '<button type="button" class="lv-tier" role="radio" data-tier="' + esc(m) + '" aria-checked="' + (m === this._tier) + '">'
        + esc(TIER_NAMES[m] || m) + ' <small>' + l.length + '</small></button>').join("");
      for (const b of box.querySelectorAll(".lv-tier")) b.addEventListener("click", () => {
        this._tier = b.dataset.tier;
        for (const o of box.querySelectorAll(".lv-tier")) o.setAttribute("aria-checked", String(o === b));
      });
      box.hidden = false;
    } catch (e) { this._by = null; }
  }

  async verify(btn) {
    const body = this.querySelector(".lv-body");
    body.hidden = false; body.setAttribute("aria-busy", "true"); btn.disabled = true;
    const status = (cls, t) => { body.innerHTML = '<div class="lv-verdict ' + cls + '" role="status">' + esc(t) + "</div>"; };
    try {
      status("", "finding a live host …");
      if (!this._by) await this.loadTiers();
      const pool = (this._by && (this._by.get(this._tier) || [...this._by.values()][0])) || (await liveBoxes()).filter(boxVerifiable);
      if (!pool || !pool.length) throw new Error("no verifiable host is attached right now");
      const row = pool[Math.floor(Math.random() * pool.length)];
      status("", "checking " + row.name + " (" + (TIER_NAMES[row.mode] || row.mode) + ") with a fresh nonce, in your browser …");
      body.innerHTML = verificationHtml(row.name, await verifyBoxInBrowser(row.name, { mode: row.mode }));
    } catch (e) {
      status("bad", "✗ could not run the check: " + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; body.setAttribute("aria-busy", "false"); }
  }
}
register("c-live-verify", LiveVerify);
