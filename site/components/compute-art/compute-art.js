import { EnclaveElement, register } from "../../js/lib/enclave-element.js";

class ComputeArt extends EnclaveElement {
  static properties = { caption: "Protected by design", label: "COMPUTE" };
  static templateUrl = new URL("./compute-art.html", import.meta.url);
  renderedCallback() {
    this._observer?.disconnect();
    const button = this.querySelector(".art-pause");
    if (!button) return;
    button.hidden = false;
    button.onclick = () => {
      const paused = this.classList.toggle("art-paused");
      button.setAttribute("aria-pressed", String(paused));
      button.textContent = paused ? "Resume animation" : "Pause animation";
    };
    if ("IntersectionObserver" in window) {
      this._observer = new IntersectionObserver(([entry]) => {
        this.classList.toggle("art-offscreen", !entry.isIntersecting);
      });
      this._observer.observe(this);
    }
  }
  disconnectedCallback() {
    this._observer?.disconnect();
    super.disconnectedCallback();
  }
}
register("c-compute-art", ComputeArt);
