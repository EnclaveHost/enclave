/* ============================================================
   <c-header current="overview|apps|develop|dashboard">
   The site's top bar: brand, primary nav, and a composed
   <c-wallet-button> (which owns the wallet lifecycle). The
   Dashboard tab is signed-in chrome: hidden until a wallet
   session exists (on baked pages the wallet-paint script
   unhides it pre-paint from localStorage state).
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import "../wallet-button/wallet-button.js";
import { on } from "../../js/core/util.js";
import { Enclave } from "../../js/core/api.js";

class Header extends EnclaveElement {
  static properties = { current: "" };
  static _tpl = "<header class=\"nav\">\n  <a class=\"skip-link\" href=\"#main\">Skip to main content</a>\n  <div class=\"wrap nav-inner\">\n    <a href=\"./\" class=\"brand\" aria-label=\"Enclave home\">\n      <svg viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n        <path d=\"M16 2 28 9v14L16 30 4 23V9z\" stroke=\"var(--jade)\" stroke-width=\"1.6\"/>\n        <path d=\"M16 7.333 24 12v8L16 24.667 8 20v-8z\" stroke=\"var(--jade)\" stroke-width=\"1.2\" opacity=\".55\"/>\n        <circle cx=\"16\" cy=\"12.55\" r=\"2.45\" stroke=\"var(--jade)\" stroke-width=\"1.6\"/>\n        <path d=\"M16 15v6.6M16 21.6h2M16 19.4h1.5\" stroke=\"var(--jade)\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>\n      </svg>\n      <svg class=\"nm\" viewBox=\"0 0 148 20\" fill=\"currentColor\" aria-hidden=\"true\"><mask id=\"wmkH\"><rect width=\"148\" height=\"20\" fill=\"#fff\"/><rect y=\"6.4\" width=\"148\" height=\"1.2\" fill=\"#000\"/><rect y=\"12.4\" width=\"148\" height=\"1.2\" fill=\"#000\"/></mask><path mask=\"url(#wmkH)\" d=\"M0 0h16v4h-16zM0 8h12v4h-12zM0 16h16v4h-16zM0 0h4v20h-4zM22 20V0h4.4l7.2 11V0h4.4v20h-4.4l-7.2-11v11zM44 0h16v4h-16zM44 16h16v4h-16zM44 0h4v20h-4zM66 0h4v20h-4zM66 16h16v4h-16zM88 0h16v4h-16zM88 0h4v20h-4zM100 0h4v20h-4zM92 9h8v4h-8zM110 0h4.4l3.6 13.4 3.6-13.4H126l-5.6 20h-4.8zM132 0h16v4h-16zM132 8h12v4h-12zM132 16h16v4h-16zM132 0h4v20h-4z\"/></svg>\n    </a>\n    <nav class=\"nav-links\" aria-label=\"Primary\">\n      <a href=\"./\" data-view=\"overview\">Overview</a>\n      <a href=\"apps\" data-view=\"apps\">Apps</a>\n      <a href=\"develop\" data-view=\"develop\">Develop</a>\n      <a href=\"host\" data-view=\"host\">Host</a>\n      <a href=\"dashboard\" data-view=\"dashboard\" hidden>Dashboard</a>\n    </nav>\n    <c-wallet-button></c-wallet-button>\n  </div>\n</header>\n";

  renderedCallback() {
    // active tab follows the `current` property (template stays static);
    // the soft-nav router (js/boot.js) assigns `current` on every swap.
    // (Speculation-rules prerendering was removed: the router never leaves
    // the document, and it warms the other pages' HTML itself.)
    this.querySelectorAll(".nav-links a").forEach(a =>
      a.classList.toggle("active", a.dataset.view === this.current));
    const d = this.querySelector('a[data-view="dashboard"]');
    if (d) d.hidden = !(Enclave.address || Enclave.accountAuthed());
  }
}
register("c-header", Header);

// session edges (connect / restore / sign-out, wallet AND account domains)
// toggle the Dashboard tab on the live header - the same DOM node across all
// soft navigations
const toggleDash = () => {
  const d = document.querySelector('c-header a[data-view="dashboard"]');
  if (d) d.hidden = !(Enclave.address || Enclave.accountAuthed());
};
on("enclave:wallet", toggleDash);
on("enclave:account", toggleDash);
