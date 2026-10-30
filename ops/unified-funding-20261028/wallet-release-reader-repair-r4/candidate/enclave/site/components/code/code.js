/* ============================================================
   <c-code fn="terminal">
     <pre><code>…</code></pre>   ← slotted
   </c-code>
   A code block with the site's standard chrome: filename bar +
   working copy button (which copies the slotted <pre>'s text).
   Replaces ~40 hand-repeated codebar blocks in the guide/CLI.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { copyText } from "../../js/core/util.js";

class Code extends EnclaveElement {
  static properties = { fn: "" };
  static _tpl = "<div class=\"code\">\n  <div class=\"codebar\">\n    <span class=\"fn\">{fn}</span>\n    <button class=\"copybtn\" type=\"button\">⧉ copy</button>\n  </div>\n  <slot></slot>\n</div>\n";

  renderedCallback() {
    const btn = this.querySelector(".copybtn");
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", () => {
        const pre = this.querySelector("pre");
        if (pre) copyText(pre.textContent, btn);
      });
    }
  }
}
register("c-code", Code);
