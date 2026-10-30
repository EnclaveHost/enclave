import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Ticker extends EnclaveElement {
  static _tpl = "<section class=\"ticker\" aria-label=\"Hardware isolation technology\">\n  <div class=\"ticker-window\">\n    <div class=\"ticker-track\">\n      <ul class=\"ticker-group\" aria-label=\"Technology companies\">\n        <li><img src=\"assets/technology/google.svg\" alt=\"Google\" width=\"126\" height=\"41\" /></li>\n        <li><img src=\"assets/technology/microsoft.png\" alt=\"Microsoft\" width=\"148\" height=\"31\" /></li>\n        <li><img src=\"assets/technology/amd.svg\" alt=\"AMD\" width=\"121\" height=\"31\" /></li>\n        <li><img src=\"assets/technology/intel.svg\" alt=\"Intel\" width=\"84\" height=\"33\" /></li>\n        <li><img src=\"assets/technology/nvidia.svg\" alt=\"NVIDIA\" width=\"132\" height=\"25\" /></li>\n        <li><img src=\"assets/technology/arm.svg\" alt=\"Arm\" width=\"92\" height=\"30\" /></li>\n        <li><img src=\"assets/technology/aws.svg\" alt=\"AWS\" width=\"68\" height=\"40\" /></li>\n      </ul>\n    </div>\n  </div>\n</section>\n";

  renderedCallback() {
    this._cleanup?.();
    const ticker = this.querySelector(".ticker");
    const track = this.querySelector(".ticker-track");
    const group = this.querySelector(".ticker-group");
    if (!ticker || !track || !group) return;
    track.querySelector('[aria-hidden="true"]')?.remove();
    const copy = group.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    copy.removeAttribute("aria-label");
    track.append(copy);
    ticker.classList.add("ticker-animated");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => {
      ticker.classList.toggle("ticker-running", visible && !document.hidden && !reduced.matches);
    };
    let observer;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
      observer.observe(ticker);
    } else visible = true;
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    this._cleanup = () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
      ticker.classList.remove("ticker-running");
    };
    sync();
  }

  disconnectedCallback() {
    this._cleanup?.();
    super.disconnectedCallback();
  }
}
register("c-ticker", Ticker);
