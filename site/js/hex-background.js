// Glimmers travel at the grid's speed, but finish their own fades before
// relocating. They never inherit the repeating grid layer's position reset.
const layer = document.createElement("div");
layer.className = "hex-background";
layer.setAttribute("aria-hidden", "true");
const ns = "http://www.w3.org/2000/svg";
const svg = document.createElementNS(ns, "svg");
svg.setAttribute("focusable", "false");
layer.append(svg);
document.body.prepend(layer);
document.body.classList.add("hex-ready");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const tileHeight = 41.569219;
const speedX = 72 / 18000, speedY = -tileHeight / 18000;
const cells = new Map();

function glimmer(cell, stagger = false) {
  if (!cell.isConnected || reduced.matches) return;
  const duration = 2400 + Math.random() * 1800;
  const elapsed = stagger ? Math.random() * duration : 0;
  const columns = Math.ceil((innerWidth + 148) / 36);
  const rows = Math.ceil((innerHeight + 148) / tileHeight);
  const column = Math.floor(Math.random() * columns);
  const row = Math.floor(Math.random() * rows);
  // Read the grid's phase only when starting a fade, never per frame.
  const matrix = new DOMMatrixReadOnly(getComputedStyle(layer, "::before").transform);
  const x = column * 36 + matrix.m41 - elapsed * speedX;
  const y = row * tileHeight + (column % 2) * tileHeight / 2 + matrix.m42 - elapsed * speedY;
  const motion = cell.animate([
    {transform: `translate(${x}px,${y}px)`},
    {transform: `translate(${x + duration * speedX}px,${y + duration * speedY}px)`},
  ], {duration, easing: "linear", fill: "both"});
  const fade = cell.animate([
    {opacity: 0, offset: 0},
    {opacity: .4 + Math.random() * .6, offset: .42},
    {opacity: 0, offset: .84},
    {opacity: 0, offset: 1},
  ], {duration, easing: "ease-in-out", fill: "both"});
  cells.set(cell, [motion, fade]);
  motion.currentTime = fade.currentTime = elapsed;
  if (document.hidden) { motion.pause(); fade.pause(); }
  fade.finished.then(() => {
    motion.cancel(); fade.cancel();
    glimmer(cell);
  }).catch(() => {}); // Resizing or reduced motion may cancel a fade.
}
function populate() {
  const count = reduced.matches ? 0 : Math.min(320, Math.max(56, Math.round(innerWidth * innerHeight / 5250)));
  // Preserve existing fades on resize instead of flashing a whole new field.
  while (cells.size > count) {
    const [cell, animations] = [...cells].at(-1);
    animations.forEach(animation => animation.cancel());
    cell.remove(); cells.delete(cell);
  }
  while (cells.size < count) {
    const cell = document.createElementNS(ns, "path");
    cell.setAttribute("d", `M0 ${tileHeight / 2} 12 0H36L48 ${tileHeight / 2} 36 ${tileHeight}H12Z`);
    svg.append(cell);
    glimmer(cell, true);
  }
}
populate();
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(populate, 180);
});
reduced.addEventListener("change", populate);
function syncVisibility() {
  layer.classList.toggle("is-paused", document.hidden);
  for (const animations of cells.values()) {
    for (const animation of animations) document.hidden ? animation.pause() : animation.play();
  }
}
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();
