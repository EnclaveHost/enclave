/* ============================================================
   <c-footer> - the shared site footer. The "OpenAPI spec"
   link downloads the same openapi.json the API reference and
   code samples render from.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { loadSpec } from "../../js/core/spec.js";
import { showToast } from "../../js/core/util.js";

export async function downloadSpec() {
  const spec = await loadSpec();
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "openapi.json"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("openapi.json downloaded");
}

class Footer extends EnclaveElement {
  static _tpl = "<footer aria-label=\"Footer\">\n  <div class=\"wrap\">\n    <div class=\"foot-grid\">\n      <div class=\"foot-brand\">\n        <a href=\"./\" class=\"brand\" aria-label=\"Enclave home\">\n          <svg viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n            <path d=\"M16 2 28 9v14L16 30 4 23V9z\" stroke=\"var(--jade)\" stroke-width=\"1.6\"/>\n            <path d=\"M16 7.333 24 12v8L16 24.667 8 20v-8z\" stroke=\"var(--jade)\" stroke-width=\"1.2\" opacity=\".55\"/>\n            <circle cx=\"16\" cy=\"12.55\" r=\"2.45\" stroke=\"var(--jade)\" stroke-width=\"1.6\"/>\n            <path d=\"M16 15v6.6M16 21.6h2M16 19.4h1.5\" stroke=\"var(--jade)\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>\n          </svg>\n          <svg class=\"nm\" viewBox=\"0 0 148 20\" fill=\"currentColor\" aria-hidden=\"true\"><mask id=\"wmkF\"><rect width=\"148\" height=\"20\" fill=\"#fff\"/><rect y=\"6.4\" width=\"148\" height=\"1.2\" fill=\"#000\"/><rect y=\"12.4\" width=\"148\" height=\"1.2\" fill=\"#000\"/></mask><path mask=\"url(#wmkF)\" d=\"M0 0h16v4h-16zM0 8h12v4h-12zM0 16h16v4h-16zM0 0h4v20h-4zM22 20V0h4.4l7.2 11V0h4.4v20h-4.4l-7.2-11v11zM44 0h16v4h-16zM44 16h16v4h-16zM44 0h4v20h-4zM66 0h4v20h-4zM66 16h16v4h-16zM88 0h16v4h-16zM88 0h4v20h-4zM100 0h4v20h-4zM92 9h8v4h-8zM110 0h4.4l3.6 13.4 3.6-13.4H126l-5.6 20h-4.8zM132 0h16v4h-16zM132 8h12v4h-12zM132 16h16v4h-16zM132 0h4v20h-4z\"/></svg>\n        </a>\n        <p>Compute that cannot see your data. Paid per second, for anything that holds a key.</p>\n        <div class=\"foot-meta\">\n          <span>built + operated by Enclave Host, Inc.</span>\n          <span>front-end: static, pinned to IPFS · <code>enclave.host</code></span>\n        </div>\n      </div>\n      <nav aria-label=\"Product\">\n        <h2>Product</h2>\n        <ul>\n          <li><a href=\"./#why\">What you get</a></li>\n          <li><a href=\"./#how\">How it works</a></li>\n          <li><a href=\"apps\">App store</a></li>\n          <li><a href=\"./#pricing\">Pricing</a></li>\n          <li><a href=\"develop#architecture\">Architecture</a></li>\n          <li><a href=\"develop#progress\">Engineering evidence</a></li>\n          <li><a href=\"./#about\">About the company</a></li>\n        </ul>\n      </nav>\n      <nav aria-label=\"Developers\">\n        <h2>Developers</h2>\n        <ul>\n          <li><a href=\"develop#docs\">App development guide</a></li>\n          <li><a href=\"develop#api\">API reference</a></li>\n          <li><a href=\"openapi.json\" id=\"dlSpec2\">OpenAPI spec</a></li>\n          <li><a href=\"./#attest\">Attestation guide</a></li>\n          <li><a href=\"develop#api\">Error codes</a></li>\n        </ul>\n      </nav>\n      <nav aria-label=\"Trust\">\n        <h2>Trust</h2>\n        <ul>\n          <li><a href=\"develop#contract\">The isolation contract</a></li>\n          <li><a href=\"develop#shield\">Enclave Shield</a></li>\n          <li><a href=\"./#attest\">Verify an enclave</a></li>\n          <li><a href=\"develop#verify\">What is measured</a></li>\n          <li><a href=\"develop#independent\">What runs on our servers</a></li>\n          <li><a href=\"https://github.com/EnclaveHost/enclave\" target=\"_blank\" rel=\"noopener\">Source on GitHub</a></li>\n        </ul>\n      </nav>\n      <nav aria-label=\"Contact and legal\">\n        <h2>Contact</h2>\n        <ul>\n          <li><a class=\"foot-mail\" href=\"mailto:support@enclave.host\">Support<code>support@enclave.host</code></a></li>\n          <li><a class=\"foot-mail\" href=\"mailto:security@enclave.host\">Security disclosures<code>security@enclave.host</code></a></li>\n          <li><a href=\".well-known/security.txt\">security.txt</a></li>\n          <li><a href=\"terms\">Terms of Service</a></li>\n          <li><a href=\"privacy\">Privacy Policy</a></li>\n        </ul>\n      </nav>\n    </div>\n    <div class=\"foot-bottom\">\n      <span>© 2026 Enclave Host, Inc. · content-addressed on IPFS · build <span data-build>dev</span></span>\n      <span>designed to outlive any one operator</span>\n    </div>\n  </div>\n</footer>\n";

  renderedCallback() {
    const d = this.querySelector("#dlSpec2");
    if (d && !d._wired){ d._wired = true; d.addEventListener("click", e => { e.preventDefault(); downloadSpec(); }); }
  }
}
register("c-footer", Footer);
