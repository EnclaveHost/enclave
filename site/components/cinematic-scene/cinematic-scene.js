import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
class CinematicScene extends EnclaveElement {
  static properties = { image: "assets/compute-cinematic.webp", video: "assets/compute-cinematic.mp4" };
  static templateUrl = new URL("./cinematic-scene.html", import.meta.url);
  renderedCallback() {
    this._cleanup?.();
    const button = this.querySelector(".cinema-pause");
    const video = this.querySelector(".cinema-video");
    if (!button || !video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let failed = false;
    let playing = false;
    video.muted = true;
    const sync = () => {
      const running = visible && !document.hidden && !reduced.matches && !failed && button.getAttribute("aria-pressed") !== "true";
      button.hidden = reduced.matches || failed || !playing;
      if (running) {
        // Delay the video request until motion is wanted; the image paints immediately.
        if (!video.getAttribute("src")) video.src = video.dataset.src;
        video.play().catch(() => {
          if (video.paused && visible && !document.hidden && !reduced.matches && button.getAttribute("aria-pressed") !== "true") {
            button.hidden = false;
            button.setAttribute("aria-pressed", "true");
            button.textContent = "▶ Play motion";
          }
        });
      } else video.pause();
      this.classList.toggle("cinema-ready", playing && !reduced.matches && !failed);
    };
    video.onplaying = () => { playing = true; this.classList.add("cinema-ready"); button.hidden = false; };
    video.onerror = () => { failed = true; sync(); };
    button.onclick = () => {
      const paused = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(paused));
      button.textContent = paused ? "▶ Resume motion" : "Ⅱ Pause motion";
      sync();
    };
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    let observer;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
      observer.observe(this);
    } else visible = true;
    this._cleanup = () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
      video.onplaying = video.onerror = button.onclick = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      this.classList.remove("cinema-ready");
    };
    sync();
  }
  disconnectedCallback() {
    this._cleanup?.();
    super.disconnectedCallback();
  }
}
register("c-cinematic-scene", CinematicScene);
