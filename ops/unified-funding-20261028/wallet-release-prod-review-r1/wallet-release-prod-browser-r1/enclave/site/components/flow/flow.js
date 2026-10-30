/* ============================================================
   <c-flow> - the "Five calls, start to finish" lifecycle
   stepper. The step buttons live in the TEMPLATE (prerendered at
   build time); this class holds each step's method+path and
   renders the detail pane live from openapi.json on hydration.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, hlJson, hlCode } from "../../js/core/util.js";
import { loadSpec, getSpec, bodyExample, responseExample } from "../../js/core/spec.js";

/* method+path per step button, in template order */
const STEPS = [
  { method: "POST",   path: "/auth/login" },
  { method: "TX",     path: "EnclaveDeployments.create()" },
  { method: "POST",   path: "/claim-hint" },
  { method: "GET",    path: "/deployments/{id}/attestation" },
  { method: "DELETE", path: "/deployments/{id}" },
];

class Flow extends EnclaveElement {
  static _tpl = "<div class=\"flow\">\n  <div class=\"steps\" role=\"tablist\" aria-label=\"Lifecycle steps\">\n    <button class=\"step active\" type=\"button\" role=\"tab\" id=\"flow-tab-1\" aria-selected=\"true\" tabindex=\"0\" aria-controls=\"flow-detail\"><span class=\"num\">1</span><div><div class=\"st-t\">Sign in</div><div class=\"st-d\">Prove it's you with a key you hold. No email, no password.</div></div></button>\n    <button class=\"step\" type=\"button\" role=\"tab\" id=\"flow-tab-2\" aria-selected=\"false\" tabindex=\"-1\" aria-controls=\"flow-detail\"><span class=\"num\">2</span><div><div class=\"st-t\">Create a deployment</div><div class=\"st-d\">Pick the app and its CPU and GPU shares. You own the record, and it survives enclave updates.</div></div></button>\n    <button class=\"step\" type=\"button\" role=\"tab\" id=\"flow-tab-3\" aria-selected=\"false\" tabindex=\"-1\" aria-controls=\"flow-detail\"><span class=\"num\">3</span><div><div class=\"st-t\">Fund runtime</div><div class=\"st-d\">Payment credits runtime the moment it lands. Payments are final, so fund small and top up any time.</div></div></button>\n    <button class=\"step\" type=\"button\" role=\"tab\" id=\"flow-tab-4\" aria-selected=\"false\" tabindex=\"-1\" aria-controls=\"flow-detail\"><span class=\"num\">4</span><div><div class=\"st-t\">Verify the enclave</div><div class=\"st-d\">Check the host’s attestation and its limits. Deployed GPUs use Shield’s masked offload, not GPU hardware attestation.</div></div></button>\n    <button class=\"step\" type=\"button\" role=\"tab\" id=\"flow-tab-5\" aria-selected=\"false\" tabindex=\"-1\" aria-controls=\"flow-detail\"><span class=\"num\">5</span><div><div class=\"st-t\">Stop (or let it expire)</div><div class=\"st-d\">Tear down and release the share. Unspent runtime stays on the record for a later restart, or cancel to get back the unspent part held for the host.</div></div></button>\n  </div>\n  <div class=\"flow-detail\" id=\"flow-detail\" role=\"tabpanel\" aria-labelledby=\"flow-tab-1\" tabindex=\"0\"></div>\n</div>\n";

  detail(i) {
    const s = STEPS[i], op = (getSpec().paths[s.path] || {})[s.method.toLowerCase()];
    let h = '<div style="padding:15px 18px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:12px;">'
      + '<span class="mtag m-' + s.method.toLowerCase() + '">' + s.method + "</span>"
      + '<span class="op-path">' + esc(s.path) + "</span></div><div style='padding:16px 18px;'>";
    if (!op) {   // on-chain steps aren't HTTP operations, so they have no spec entry
      h += '<div class="block-lbl" style="margin-top:0">On-chain · Base</div>'
        + '<div class="code"><pre style="margin:0;padding:13px 16px"><code>'
        + hlCode('// one wallet transaction - no HTTP call\ncreate(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid,\n       feeRecipient, feePerSec6)\n// appRef = catalog://<appId>/<versionIndex> (the version record; configCid stays "")\n// feeRecipient/feePerSec6 copy the version\'s publisher fee (0x0/0 = free app)\n// -> the receipt\'s Created event: topics[1] is your deployment id (bytes32)')
        + "</code></pre></div></div>";
      this.querySelector(".flow-detail").innerHTML = h;
      return;
    }
    const be = bodyExample(op);
    if (be) h += '<div class="block-lbl" style="margin-top:0">Request</div>'
      + '<div class="code" style="margin-bottom:14px"><pre style="margin:0;padding:13px 16px"><code>' + hlJson(be) + "</code></pre></div>";
    const codes = Object.keys(op.responses), ok = codes.find(c => c[0] === "2") || codes[0];
    const re = responseExample(op.responses[ok]);
    h += '<div class="block-lbl"' + (be ? "" : ' style="margin-top:0"') + ">Response · " + esc(ok) + "</div>"
      + '<div class="code"><pre style="margin:0;padding:13px 16px"><code>'
      + (re !== null ? hlJson(re) : esc(op.responses[ok].description || "")) + "</code></pre></div></div>";
    this.querySelector(".flow-detail").innerHTML = h;
  }

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    const wrap = this.querySelector(".steps");
    const tabs = [...wrap.querySelectorAll(".step")];
    const select = (i, focus) => {
      tabs.forEach((x, j) => {
        x.classList.toggle("active", j === i);
        x.setAttribute("aria-selected", j === i ? "true" : "false");
        x.tabIndex = j === i ? 0 : -1;
      });
      const panel = this.querySelector(".flow-detail");
      if (panel) panel.setAttribute("aria-labelledby", tabs[i].id);
      if (focus) tabs[i].focus();
      this.detail(i);
    };
    tabs.forEach((el, i) => {
      el.addEventListener("click", () => select(i, false));
      // ARIA tabs pattern: arrow keys move + activate within the tablist
      el.addEventListener("keydown", (e) => {
        const map = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
        if (!(e.key in map)) return;
        e.preventDefault();
        select((map[e.key] + tabs.length) % tabs.length, true);
      });
    });
    loadSpec().then(() => this.detail(0), e => console.warn("[c-flow] spec load failed:", e));
  }
}
register("c-flow", Flow);
