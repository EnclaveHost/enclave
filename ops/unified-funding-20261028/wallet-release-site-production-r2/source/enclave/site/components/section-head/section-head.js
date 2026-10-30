/* ============================================================
   <c-section-head eyebrow="…" heading="…" [flush]>
     <p>rich description…</p>   ← slotted
   </c-section-head>
   The eyebrow + h2 + description pattern that opens every
   section on the site. `flush` drops the bottom margin (the API
   reference header sits in a flex row).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class SectionHead extends EnclaveElement {
  static properties = { eyebrow: "", heading: "" };
  static _tpl = "<div class=\"sec-head\">\n  <span class=\"eyebrow\">{eyebrow}</span>\n  <h2>{heading}</h2>\n  <slot></slot>\n</div>\n";
}
register("c-section-head", SectionHead);
