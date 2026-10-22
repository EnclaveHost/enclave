/* ============================================================
   Startup of the packaged default independent profile (every page;
   imported by js/boot.js).

   With the reviewed default in force (js/core/independent.js source
   "default") the page, at load and without waiting for any click:
     1. checks the reviewed authority on chain (js/core/default-authority.js);
     2. reads the service index for untrusted candidates
        (js/core/service-discovery.js), once that check passes;
     3. keeps one status bar under the header saying which profile is in
        force, whether its contracts are verified, and what it found.
   A refused or unreachable check is shown as such and stops decisions;
   nothing here ever calls Enclave's API or switches to the hosted service.
   The explicit hosted choice and an invalid default are shown the same way.
   ============================================================ */
import { INDEPENDENT } from "./config.js";

const BAR_CLASS = "ind-default-bar";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let _started = false, _discovery = null;
export const defaultDiscovery = () => _discovery;

function bar(){
  if (typeof document === "undefined") return null;
  let el = document.querySelector("." + BAR_CLASS);
  if (!el){
    const header = document.querySelector("c-header, header");
    if (!header) return null;
    el = document.createElement("div"); el.className = BAR_CLASS; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    header.after(el);
  }
  return el;
}
function paint(html, cls){ const el = bar(); if (!el) return; el.className = BAR_CLASS + (cls ? " " + cls : ""); el.innerHTML = html; }

async function paintAuthority(){
  const A = await import("./default-authority.js");
  const s = A.authorityStatus();
  const name = INDEPENDENT.profile && INDEPENDENT.profile.name ? esc(INDEPENDENT.profile.name) : "default network profile";
  const disc = _discovery && !_discovery.off && !_discovery.error
    ? " · service index: " + (_discovery.candidates || []).length + " candidate ad(s) at block " + esc(_discovery.block)
    : _discovery && _discovery.error ? " · service index unavailable: " + esc(_discovery.error) : "";
  const cls = s.state === "verified" ? (s.drift && s.drift.length ? "warn" : "ok") : s.state === "refused" || s.state === "unavailable" ? "warn" : "";
  paint('<b>Independent</b> · ' + name + ' · ' + esc(A.authorityLine(s)) + disc
    + ' <a class="ind-bar-more" href="dashboard#network-profile">details</a>', cls);
}

export async function startDefault({ reader } = {}){
  if (_started) return; _started = true;
  if (INDEPENDENT.state === "off" && INDEPENDENT.packaged && INDEPENDENT.hosted && INDEPENDENT.hosted.confirmed){
    paint('<b>Enclave’s hosted service</b> (your explicit choice in this tab; not independent). <a href="dashboard#network-profile">Return to the independent default</a>', "warn");
    return;
  }
  if (INDEPENDENT.source === "default" && INDEPENDENT.state === "invalid"){
    paint('<b>The default network profile built into this site cannot be used:</b> ' + esc(INDEPENDENT.error)
      + '. Nothing is signed, and this page does not fall back to Enclave’s hosted service. <a href="dashboard#network-profile">Choose a network profile</a>', "warn");
    return;
  }
  if (!(INDEPENDENT.state === "on" && INDEPENDENT.source === "default")) return;
  document.addEventListener("enclave:authority", () => { paintAuthority(); });
  const IC = await import("./independent-chain.js");
  const A = await import("./default-authority.js");
  const base = reader || IC.baseReader();
  paintAuthority();
  const s = await A.ensureAuthority(base);
  if (s.state !== "verified"){ paintAuthority(); return; }
  if (INDEPENDENT.profile.serviceIndex){
    try {
      const SD = await import("./service-discovery.js");
      _discovery = await SD.discover({ profile: INDEPENDENT.profile, reader: reader || IC.reader() });
    } catch (e){ _discovery = { error: String(e && e.message || e).slice(0, 200) }; }
    try { document.dispatchEvent(new CustomEvent("enclave:discovery", { detail: _discovery })); } catch {}
  }
  paintAuthority();
}

// every page: start once the document exists (no-op unless the packaged default is involved)
if (typeof document !== "undefined" && INDEPENDENT.packaged){
  const go = () => startDefault().catch((e) => paint("Independent default: " + esc(e && e.message || e), "warn"));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true }); else go();
}
