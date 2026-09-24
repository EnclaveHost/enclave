import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class Ticker extends EnclaveElement {
  static templateUrl = new URL("./ticker.html", import.meta.url);

  renderedCallback() {
    this._cleanup?.();
    const ticker = this.querySelector(".ticker");
    const track = this.querySelector(".ticker-track");
    const group = this.querySelector(".ticker-group");
    const button = this.querySelector(".ticker-pause");
    if (!ticker || !track || !group || !button) return;
    track.querySelector('[aria-hidden="true"]')?.remove();
    const copy = group.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    copy.removeAttribute("aria-label");
    track.append(copy);
    ticker.classList.add("ticker-animated");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => {
      ticker.classList.toggle("ticker-running", visible && !document.hidden && !reduced.matches && button.getAttribute("aria-pressed") !== "true");
      button.hidden = reduced.matches;
    };
    button.onclick = () => {
      const paused = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(paused));
      button.setAttribute("aria-label", `${paused ? "Play" : "Pause"} the technology logos`);
      button.textContent = paused ? "▶" : "Ⅱ";
      sync();
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
      button.onclick = null;
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
