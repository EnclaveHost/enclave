/* ============================================================
   <c-code fn="terminal">
     <pre><code>…</code></pre>   ← slotted
   </c-code>
   A code block with the site's standard chrome: filename bar +
   working copy button (which copies the slotted <pre>'s text).
   Replaces ~40 hand-repeated codebar blocks in the guide/CLI.
   ============================================================ */
import { a as EnclaveElement, b as register } from "./chunk-V75UQCET.js";
import { S as copyText } from "./chunk-7RQ6XZJW.js";

class Code extends EnclaveElement {
  static properties = { fn: "" };
  static _tpl = "<div class=\"code\">\n  <div class=\"codebar\">\n    <span class=\"fn\">{fn}</span>\n    <button class=\"copybtn\" type=\"button\">\u29c9 copy</button>\n  </div>\n  <slot></slot>\n</div>\n";

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
