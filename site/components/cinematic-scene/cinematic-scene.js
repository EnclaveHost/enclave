import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
class CinematicScene extends EnclaveElement {
  static templateUrl = new URL("./cinematic-scene.html", import.meta.url);
  renderedCallback() {
    this._observer?.disconnect();
    if (this._visibility) document.removeEventListener("visibilitychange", this._visibility);
    const button = this.querySelector(".cinema-pause");
    if (!button) return;
    let visible = true;
    const sync = () => this.classList.toggle("cinema-running", visible && !document.hidden && button.getAttribute("aria-pressed") !== "true");
    button.hidden = false;
    button.onclick = () => {
      const paused = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(paused));
      button.textContent = paused ? "▶ Resume motion" : "Ⅱ Pause motion";
      sync();
    };
    this._visibility = sync;
    document.addEventListener("visibilitychange", sync);
    if ("IntersectionObserver" in window) {
      this._observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
      this._observer.observe(this);
    }
    sync();
  }
  disconnectedCallback() {
    this._observer?.disconnect();
    document.removeEventListener("visibilitychange", this._visibility);
    super.disconnectedCallback();
  }
}
register("c-cinematic-scene", CinematicScene);
