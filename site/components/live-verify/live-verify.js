/* ============================================================
   <c-live-verify> - the "run the check now" widget: verifies each
   attached AMD SEV-SNP box IN THIS BROWSER with the repository's
   own verifier (core/verify.js -> /vendor/enclave-verifier.js) and
   renders every check, what was not judged, and the verdict.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc } from "../../js/core/util.js";
import { snpBoxes, verifyBoxInBrowser, CHECK_ORDER, CHECK_LABELS, OMISSION_LABELS } from "../../js/core/verify.js";

class LiveVerify extends EnclaveElement {
  static templateUrl = new URL("./live-verify.html", import.meta.url);

  renderedCallback() {
    const btn = this.querySelector(".lv-run");
    if (btn && !btn._wired){ btn._wired = true; btn.addEventListener("click", () => this.verify(btn)); }
  }

  async verify(btn) {
    const body = this.querySelector(".lv-body"), steps = this.querySelector(".lv-steps");
    const verdict = this.querySelector(".lv-verdict"), meta = this.querySelector(".lv-meta");
    body.hidden = false; body.setAttribute("aria-busy", "true"); btn.disabled = true;
    steps.innerHTML = ""; meta.innerHTML = "";
    const status = (t) => { verdict.className = "lv-verdict"; verdict.textContent = t; };
    try {
      status("finding the attested SEV-SNP boxes …");
      const boxes = await snpBoxes();
      if (!boxes.length) throw new Error("no attested SEV-SNP box is attached right now");
      const name = boxes[0];
      status("challenging " + name + " with a fresh nonce and verifying its report in your browser …");
      const r = await verifyBoxInBrowser(name);
      const cliEl = this.querySelector(".lv-cli"); if (cliEl) cliEl.textContent = "enclave attest";
      for (const k of CHECK_ORDER) {
        const v = r.checks ? r.checks[k] : undefined;
        const cls = v === true ? "ok" : v === false ? "bad" : "";
        const li = document.createElement("li");
        li.className = cls;
        li.innerHTML = '<span class="st">' + (cls === "ok" ? "✓" : cls === "bad" ? "✗" : "·") + "</span><span>" + esc(CHECK_LABELS[k]) + "</span>";
        steps.appendChild(li);
      }
      for (const o of r.omissions || []) {
        const li = document.createElement("li");
        li.className = "warn";
        li.innerHTML = '<span class="st">◐</span><span>not judged independently: ' + esc(OMISSION_LABELS[o] || o) + "</span>";
        steps.appendChild(li);
      }
      const lines = [
        "box           " + name + (boxes.length > 1 ? "  (" + (boxes.length - 1) + " more attached)" : ""),
        r.measurement ? "measurement   " + r.measurement : null,
        r.product ? "product       AMD EPYC " + r.product : null,
        r.transportKeySha256 ? "transport key sha256:" + r.transportKeySha256 : null,
        r.nonce ? "nonce         " + r.nonce.slice(0, 32) + "…  (drawn by this page)" : null,
        r.expected ? "expected from " + r.expected.source : null,
      ].filter(Boolean);
      meta.innerHTML = lines.map((x) => "<span>" + esc(x) + "</span>").join("");
      if (r.status === "verified") {
        verdict.className = "lv-verdict ok";
        verdict.textContent = "✓ VERIFIED: " + name + " presented a genuine, fresh AMD SEV-SNP report at an expected measurement";
      } else if (r.status === "limited") {
        verdict.className = "lv-verdict warn";
        verdict.textContent = "◐ GENUINE AND FRESH: " + name + "'s report verifies to AMD's root for this page's nonce; its measurement matches the operator's list, which this page cannot reproduce on its own";
      } else {
        verdict.className = "lv-verdict bad";
        verdict.textContent = "✗ NOT VERIFIED (" + r.status + "): " + String((r.reasons || []).at(-1) || "verification incomplete");
      }
    } catch (e) {
      verdict.className = "lv-verdict bad";
      verdict.textContent = "✗ could not run verification: " + (e && e.message ? e.message : e);
    } finally { btn.disabled = false; body.setAttribute("aria-busy", "false"); }
  }
}
register("c-live-verify", LiveVerify);
