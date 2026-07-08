/* ============================================================
   <c-toast> - the site-wide toast. Anyone shows one by
   dispatching a `enclave:toast` event (util.showToast does), the
   LWC ShowToastEvent pattern.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Toast extends EnclaveElement {
  static templateUrl = new URL("./toast.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const t = this.querySelector("#toast"); if (!t) return;
    const hide = () => t.classList.remove("show");
    // long messages get READ, not flashed: the clock scales with length
    // (~22 chars/s plus settle time, capped), hovering pauses it, and a
    // click dismisses immediately
    document.addEventListener("enclave:toast", (e) => {
      const msg = (e.detail && e.detail.message) || "";
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(this._t);
      this._left = Math.min(12000, Math.max(2200, 1200 + msg.length * 45));
      this._at = Date.now();
      this._t = setTimeout(hide, this._left);
    });
    t.addEventListener("mouseenter", () => {
      clearTimeout(this._t);
      this._left = Math.max(0, this._left - (Date.now() - this._at));
    });
    t.addEventListener("mouseleave", () => {
      this._at = Date.now();
      this._t = setTimeout(hide, Math.max(1000, this._left));
    });
    t.addEventListener("click", () => { clearTimeout(this._t); hide(); });
  }
}
register("c-toast", Toast);
