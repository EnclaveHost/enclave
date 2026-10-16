/* ============================================================
   <c-live-verify> - the "run the check now" widget: lists every
   box the relay holds, and verifies the one picked IN THIS BROWSER
   with the repository's own verifier (core/verify.js ->
   /vendor/enclave-verifier.js), rendering every check, what was not
   judged, and the verdict. A box this page cannot challenge (any
   tier but SEV-SNP) says so, with what the relay checked instead.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { liveBoxes, boxVerifiable, unverifiableReason, verifyBoxInBrowser, verificationHtml } from "../../js/core/verify.js";

const TIER = { snp: "AMD SEV-SNP", avf: "phone pVM", "hv-node": "Enclave Shield", vbs: "Windows VBS" };

class LiveVerify extends EnclaveElement {
  static templateUrl = new URL("./live-verify.html", import.meta.url);

  renderedCallback() {
    const btn = this.querySelector(".lv-run");
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", () => this.verify(btn));
    const sel = this.querySelector(".lv-box");
    sel.addEventListener("change", () => this.picked(btn));
    this.loadBoxes(sel);
  }

  // fill the picker; a failed read leaves it hidden and the button finds a box itself
  async loadBoxes(sel) {
    try {
      this._rows = await liveBoxes();
      if (!this._rows.length) return;
      sel.innerHTML = this._rows.map((e, i) => '<option value="' + i + '">' + esc(e.name)
        + " · " + esc(TIER[e.mode] || e.mode || "unattested") + (boxVerifiable(e) ? "" : " (no browser check yet)") + "</option>").join("");
      this.querySelector(".lv-pick").hidden = false;
    } catch (e) { this._rows = null; }
  }

  picked(btn) {
    const row = this._rows && this._rows[Number(this.querySelector(".lv-box").value)];
    btn.disabled = !!row && !boxVerifiable(row);
    const body = this.querySelector(".lv-body");
    if (row && !boxVerifiable(row)) {
      body.hidden = false;
      body.innerHTML = '<p class="lv-na"><b>' + esc(row.name) + "</b> is " + esc(unverifiableReason(row)) + "</p>";
    } else body.hidden = true;
  }

  async verify(btn) {
    const body = this.querySelector(".lv-body");
    body.hidden = false; body.setAttribute("aria-busy", "true"); btn.disabled = true;
    const status = (cls, t) => { body.innerHTML = '<div class="lv-verdict ' + cls + '" role="status">' + esc(t) + "</div>"; };
    try {
      status("", "finding the attested SEV-SNP boxes …");
      const rows = this._rows || await liveBoxes();
      const snp = rows.filter(boxVerifiable);
      const sel = this.querySelector(".lv-box");
      const row = this._rows && sel.value !== "" ? this._rows[Number(sel.value)] : snp[0];
      if (!row) throw new Error("no attested SEV-SNP box is attached right now");
      status("", "challenging " + row.name + " with a fresh nonce and verifying its report in your browser …");
      const r = await verifyBoxInBrowser(row.name);
      body.innerHTML = verificationHtml(row.name, r, { more: this._rows ? 0 : snp.length - 1 });
    } catch (e) {
      status("bad", "✗ could not run verification: " + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; body.setAttribute("aria-busy", "false"); }
  }
}
register("c-live-verify", LiveVerify);
