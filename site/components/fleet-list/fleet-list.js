/* ============================================================
   <c-fleet-list> - per-enclave capacity rows (the relay's
   /enclaves table). Assign `.rows` (already sorted upstream) and
   it renders each box's two capacity pools. Copy says "available",
   never "free": on a page that sells compute, "60 GB free" reads as
   a price, not as headroom.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, fmtNum } from "../../js/core/util.js";
import { serverSpec } from "../../js/core/pricing.js";
import { REGISTRY_ADDRESS } from "../../js/core/config.js";
import { catExplorer } from "../../js/core/chain.js";

class FleetList extends EnclaveElement {
  static properties = { rows: null };
  static templateUrl = new URL("./fleet-list.html", import.meta.url);

  renderedCallback() {
    const list = this.querySelector(".fleet-list"); if (!list) return;
    // only enclaves that SERVE (take on-chain work) are shown: a live but
    // non-claiming box (relay row serving:false) is operational truth, not
    // sellable capacity - listing it would advertise hardware nobody can buy.
    // Rows from an older relay carry no verdict and stay visible.
    const rows = (this.rows || []).filter((e) => e.serving !== false);
    const meter = (pct) => '<i class="fleet-meter" aria-hidden="true"><b style="width:' + Math.max(0, Math.min(100, pct)) + '%"></b></i>';
    // one stat cell: bright available amount, then the "≈"/"/ total" context and
    // the label in dim ink so the number is what the eye lands on
    const stat = (avail, total, unit, label) =>
      '<span class="fleet-stat"><b><i>≈</i>' + avail + '<i> / ' + total + '</i>' + (unit ? " " + unit : "") + '</b>'
      + '<small>' + label + '</small></span>';
    // one pool = a [label | meter | pct] header line, stat cells underneath
    const pool = (label, pct, stats) =>
      '<div class="fleet-pool">'
      + '<span class="fleet-pool-label">' + label + '</span>'
      + meter(pct)
      + '<span class="fleet-pool-pct"><b>' + pct + '%</b> available</span>'
      + '<span class="fleet-stats">' + stats + '</span>'
      + '</div>';
    list.innerHTML = (!rows.length
      ? '<div class="fleet-empty">no live enclaves right now</div>'
      : rows.map(e => {
          const a = e.availability || {};
          const gpu = a.gpu === true;
          const gFree = a.gpuShareFree != null ? a.gpuShareFree : (gpu ? a.maxShare || 0 : 0);
          const cFree = a.cpuShareFree != null ? a.cpuShareFree : (gpu ? 0 : a.maxShare || 0);
          const gPct = Math.floor(gFree * 100), cPct = Math.floor(cFree * 100);
          // the relay names each row (tunnel enclaves: their tunnel name, e.g.
          // "metal0"); the endpoint-derived fallback covers older relays — and
          // strips ANY scheme, so a tunnel:// row never renders as a pseudo-URL
          const name = e.name || String(e.endpoint || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "enclave";
          const s = serverSpec();   // adopted fleet hardware; display fallback for rows that omit their own
          const vramGb = a.cardVramGb || s.cardVramGb, tflops = a.cardTflops || s.cardTflops;
          const ramGb = a.nodeRamGb || s.nodeRamGb, vcpus = a.nodeVcpus || s.nodeVcpus;
          return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
            + '<span class="fleet-head">'
            + '<span class="ap-badge ' + (gpu ? "info" : "") + '">' + (gpu ? "gpu" : "cpu") + '</span>'
            + '<span class="fleet-name">' + esc(name) + '</span>'
            + '</span>'
            + (gpu ? pool("GPU", gPct,
                stat(fmtNum(a.vramFreeGb != null ? a.vramFreeGb : gFree * vramGb), fmtNum(vramGb), "GB", "vram available")
                + stat(Math.round(gFree * tflops), Math.round(tflops), "", "tflops available")) : "")
            + pool("CPU", cPct,
                stat(fmtNum(cFree * ramGb), fmtNum(ramGb), "GB", "ram available")
                + stat(fmtNum(cFree * vcpus), fmtNum(vcpus), "", "vcpu available"))
            + '</div>';
        }).join(""));
    // footer row: a manual refresh (dispatches `refresh`; the HOST owns the
    // fetch and re-assigns .rows, which re-renders and re-arms the button) +
    // the on-chain registry this table mirrors, linked once the address book
    // has resolved (enclaves register there)
    const foot = this.querySelector(".fleet-foot");
    if (foot) {
      foot.innerHTML = '<button class="fleet-refresh" type="button" title="re-fetch the live fleet view">↻ refresh</button>'
        + (/^0x[0-9a-fA-F]{40}$/.test(REGISTRY_ADDRESS || "")
          ? '<a class="contract-link" href="' + catExplorer() + '/address/' + REGISTRY_ADDRESS + '" target="_blank" rel="noopener" title="EnclaveRegistry · ' + REGISTRY_ADDRESS + '">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
            + '<line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg> contract</a>'
          : "");
      const btn = foot.querySelector(".fleet-refresh");
      btn.addEventListener("click", () => {
        btn.disabled = true;
        this.dispatch("refresh");
        setTimeout(() => { btn.disabled = false; }, 4000);   // safety net if no host listener re-assigns .rows
      });
    }
  }
}
register("c-fleet-list", FleetList);
