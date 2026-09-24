// A small, fixed pool of glimmers follows the grid itself. Only opacity is
// animated; cells move to new random grid positions between invisible cycles.
const layer = document.createElement("div");
layer.className = "hex-background";
layer.setAttribute("aria-hidden", "true");
const ns = "http://www.w3.org/2000/svg";
const svg = document.createElementNS(ns, "svg");
svg.setAttribute("focusable", "false");
layer.append(svg);
document.body.prepend(layer);
document.body.classList.add("hex-ready");

const tileHeight = 41.569219;
let columns, rows;
function position(cell) {
  const column = Math.floor(Math.random() * columns);
  const row = Math.floor(Math.random() * rows);
  cell.setAttribute("transform", `translate(${column * 36},${row * tileHeight + (column % 2) * tileHeight / 2})`);
}
function populate() {
  columns = Math.ceil((innerWidth + 148) / 36);
  rows = Math.ceil((innerHeight + 148) / tileHeight);
  const count = Math.min(64, Math.max(10, Math.round(innerWidth * innerHeight / 26000)));
  const cells = [];
  for (let i = 0; i < count; i++) {
    const cell = document.createElementNS(ns, "path");
    cell.setAttribute("d", `M0 ${tileHeight / 2} 12 0H36L48 ${tileHeight / 2} 36 ${tileHeight}H12Z`);
    cell.style.animationDuration = `${7 + Math.random() * 8}s`;
    cell.style.animationDelay = `${-Math.random() * 15}s`;
    cell.style.setProperty("--glimmer-peak", String(.4 + Math.random() * .6));
    position(cell);
    cell.addEventListener("animationiteration", () => position(cell));
    cells.push(cell);
  }
  svg.replaceChildren(...cells);
}
populate();
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(populate, 180);
});
function syncVisibility() {
  layer.classList.toggle("is-paused", document.hidden);
}
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();
