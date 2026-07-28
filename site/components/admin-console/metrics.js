/* =========================================================================
   metrics.js - the admin console's "last 24 hours" operations panel.

   Three sources, no database anywhere (same rule as the rest of the platform):

     1. THE LEDGER, read whole. count() + getPage() gives every Deployment
        record with its createdAt/rate/balance/lease - that is the state-of-now
        (how many run, how many wait, what the fleet is committed to earn) and,
        through createdAt, an EXACT creations-per-hour history that needs no
        log support at all.
     2. THE CHAIN'S OWN EVENT LOG, for the parts state cannot answer. A record
        says "leased until T"; it does not say what was running at 03:00. Only
        Claimed/Renewed/Released/Funded do, so the panel scans them over the
        window with eth_getLogs. Public RPCs rate-limit and some refuse ranges
        outright, so this half is BEST EFFORT: it degrades to a note, and the
        ledger-derived half keeps painting.
     3. THE RELAY's /enclaves, for what the chain cannot know - how much of
        each box's two pools is actually in use right now.

   Timestamps: one eth_getBlockByNumber at each end of the window anchors a
   linear block->time map (Base is a fixed 2s chain), so bucketing thousands of
   logs costs two block reads instead of one per log.

   Charts are hand-rolled SVG measured against the container (a ResizeObserver
   redraws on layout change), for the same reason the console hand-encodes its
   calldata: no chart library loads in the browser.
   ========================================================================= */
import { baseRpc, hexBig, encCall, decodeStructArray, DEP_SCHEMA, DEP_SCHEMA_V1 } from "../../js/core/chain.js";
import { keccak256Utf8 } from "../../js/core/keccak.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";
import { esc } from "../../js/core/util.js";

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);

export const HOURS = 24;                    // the window; fixed, and said so on the panel
const HOUR = 3600;
const PAGE = 50;                            // getPage rows per eth_call
const BLOCK_SEC = 2;                        // Base block time (only the initial range GUESS - the anchors are real)
const LOG_CHUNK = 4000;                     // blocks per eth_getLogs (public RPCs reject wide ranges)
const LOG_CONCURRENCY = 3;                  // in-flight chunks; gentle enough for the free pool
const MAX_PREROLL = 2 * HOUR;               // extra scan BEFORE the window so a lease already running at t-24h is seen

/* The six EnclaveDeployments events this panel reads. Topic0 is computed here
   rather than pasted: chain.js's hand-pinned DEP_CREATED_TOPIC is the
   regression check that the hash path is right (test/admin-metrics.test.mjs
   pins all six against viem). */
export const EVENT_SIGS = {
  created:   "Created(bytes32,address,string,uint16,uint16,uint256)",
  funded:    "Funded(bytes32,address,uint256)",
  fundedEth: "FundedEth(bytes32,address,uint256,uint256)",
  claimed:   "Claimed(bytes32,bytes32,address,uint64,uint256)",
  renewed:   "Renewed(bytes32,bytes32,uint64,uint256)",
  released:  "Released(bytes32,bytes32,uint256)",
};
export const TOPICS = Object.fromEntries(Object.entries(EVENT_SIGS).map(([k, s]) => [k, keccak256Utf8(s)]));
const KIND_OF = Object.fromEntries(Object.entries(TOPICS).map(([k, t]) => [t, k]));

/* ---------- formatting ---------- */

const usd = (n6) => {
  const v = Number(n6) / 1e6;
  if (v === 0) return "$0";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e4) return "$" + Math.round(v).toLocaleString();
  if (Math.abs(v) >= 1) return "$" + v.toFixed(2);
  return "$" + v.toFixed(4);
};
const perHr = (rate6) => usd(Number(rate6) * 3600) + "/hr";
const pct = (f) => Math.round(f * 100) + "%";
const hourLabel = (t) => String(new Date(t * 1000).getHours()).padStart(2, "0") + ":00";
const nowSec = () => Math.floor(Date.now() / 1000);

/* ---------- 1. the ledger, read whole ---------- */

async function depRev(addr) {
  try { const r = await call(addr, "0x" + CONTRACTS.EnclaveDeployments.sel.deploymentsSchema); return Number(hexBig(r)) || 1; }
  catch { return 1; }                                   // pre-marker contracts revert
}

export async function readLedger(addr) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const schema = (await depRev(addr)) >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1;
  const total = Number(hexBig(await call(addr, "0x" + sel.count)));
  const rows = [];
  for (let s = 0; s < total; s += PAGE)
    rows.push(...decodeStructArray(await call(addr, encCall(sel.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), schema));
  return rows;
}

/* State-of-now, straight off the records. `running` is the only status the
   chain can be wrong about for at most one lease period (a runner that died
   still holds its lease until it expires) - which is exactly what an operator
   wants to see, so it is not smoothed. */
export function summarize(rows, now = nowSec()) {
  const s = {
    total: rows.length, active: 0, inactive: 0, running: 0, waiting: 0, unfunded: 0,
    rate6: 0, balance6: 0, spent6: 0, gpuMilli: 0, cpuMilli: 0, runners: new Set(),
  };
  for (const d of rows) {
    s.balance6 += d.balance6;
    s.spent6 += d.spent6;
    if (!d.active) { s.inactive++; continue; }
    s.active++;
    const live = d.leaseUntil > now && d.runner && !/^0x0+$/.test(d.runner);
    if (live) {
      s.running++;
      s.rate6 += d.rate;
      s.gpuMilli += d.gpuMilli;
      s.cpuMilli += d.cpuMilli;
      s.runners.add(d.runner);
    } else if (d.balance6 >= d.rate && d.rate > 0) s.waiting++;
    else s.unfunded++;
  }
  return s;
}

/* Creations per hour - EXACT, from each record's own createdAt. This is the
   half of the panel that works whether or not the RPC pool serves logs. */
export function createdBuckets(rows, buckets) {
  const out = buckets.map(() => 0);
  for (const d of rows) {
    const i = bucketIndex(buckets, d.createdAt);
    if (i >= 0) out[i]++;
  }
  return out;
}

/* 24 hour-aligned buckets ending with the hour in progress. */
export function makeBuckets(now = nowSec(), hours = HOURS) {
  const end = Math.floor(now / HOUR) * HOUR + HOUR;           // top of the current hour
  return Array.from({ length: hours }, (_, i) => ({ t0: end - (hours - i) * HOUR, t1: end - (hours - i - 1) * HOUR }));
}
const bucketIndex = (buckets, t) => {
  if (!buckets.length || t < buckets[0].t0 || t >= buckets[buckets.length - 1].t1) return -1;
  return Math.floor((t - buckets[0].t0) / HOUR);
};

/* ---------- 2. the event log ---------- */

const word = (data, i) => "0x" + (data || "").replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const wNum = (data, i) => Number(hexBig(word(data, i)));

/* Anchor a block -> unix-time map on two REAL blocks. Base mints a block every
   2s, so the interpolation between the anchors is exact to the second; the 2s
   constant is only used to guess where to put the far anchor. */
async function blockClock(spanSec) {
  const tip = Number(hexBig(await baseRpc("eth_blockNumber", [])));
  const head = await baseRpc("eth_getBlockByNumber", ["0x" + tip.toString(16), false]);
  const tHead = Number(hexBig(head.timestamp));
  const guess = Math.max(0, tip - Math.ceil(spanSec / BLOCK_SEC));
  const tail = await baseRpc("eth_getBlockByNumber", ["0x" + guess.toString(16), false]);
  const tTail = Number(hexBig(tail.timestamp));
  const slope = tip > guess ? (tHead - tTail) / (tip - guess) : BLOCK_SEC;
  return { tip, from: guess, timeOf: (b) => tTail + (b - guess) * slope };
}

/* One pass of eth_getLogs over the window, all six topics at once (topic0 as an
   OR set), chunked because public RPCs cap the range. Any chunk that fails
   every endpoint fails the whole history - a partial scan would under-report
   and read as a quiet outage, which is worse than saying "no history". */
export async function readHistory(addr, { spanSec, leaseSec = HOUR }) {
  const preroll = Math.min(Math.max(leaseSec, 0), MAX_PREROLL);
  const clock = await blockClock(spanSec + preroll);
  const topic0 = Object.values(TOPICS);
  const ranges = [];
  for (let b = clock.from; b <= clock.tip; b += LOG_CHUNK)
    ranges.push([b, Math.min(b + LOG_CHUNK - 1, clock.tip)]);

  const logs = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      logs[i] = await baseRpc("eth_getLogs", [{
        address: addr, fromBlock: "0x" + ranges[i][0].toString(16), toBlock: "0x" + ranges[i][1].toString(16),
        topics: [topic0],
      }]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, worker));

  const events = [];
  for (const chunk of logs) for (const l of chunk || []) {
    const kind = KIND_OF[(l.topics && l.topics[0]) || ""];
    if (!kind) continue;
    const time = Math.round(clock.timeOf(Number(hexBig(l.blockNumber))));
    const e = { kind, time, id: l.topics[1] };
    if (kind === "claimed") { e.leaseUntil = wNum(l.data, 0); e.amount6 = wNum(l.data, 1); }
    else if (kind === "renewed") { e.leaseUntil = wNum(l.data, 0); e.amount6 = wNum(l.data, 1); }
    else if (kind === "released") { e.amount6 = wNum(l.data, 0); }
    else if (kind === "funded") { e.amount6 = wNum(l.data, 0); }
    else if (kind === "fundedEth") { e.amount6 = wNum(l.data, 1); }   // credited6, not the wei
    events.push(e);
  }
  events.sort((a, b) => a.time - b.time);
  return { events, scannedFrom: clock.timeOf(clock.from), blocks: clock.tip - clock.from };
}

/* Rebuild "how many were RUNNING at each hour" from the lease events: every
   Claimed/Renewed opens the interval [event, leaseUntil]; a Released truncates
   whichever interval spans it. Scanning `preroll` before the window is what
   makes the left-hand edge right - without it, a deployment that renewed at
   t-24h05m would not appear until its next renewal. */
export function bucketHistory(events, buckets) {
  const running = buckets.map(() => 0);
  const settled6 = buckets.map(() => 0);
  const refunded6 = buckets.map(() => 0);
  const funded6 = buckets.map(() => 0);

  const segs = new Map();
  for (const e of events) {
    if (e.kind === "claimed" || e.kind === "renewed") {
      if (!segs.has(e.id)) segs.set(e.id, []);
      segs.get(e.id).push([e.time, Math.max(e.time, e.leaseUntil)]);
    }
  }
  for (const e of events) {
    if (e.kind !== "released") continue;
    for (const seg of segs.get(e.id) || []) if (seg[0] <= e.time && seg[1] > e.time) seg[1] = e.time;
  }
  buckets.forEach((b, i) => {
    let n = 0;
    for (const list of segs.values()) if (list.some((s) => s[0] < b.t1 && s[1] > b.t0)) n++;
    running[i] = n;
  });

  for (const e of events) {
    const i = bucketIndex(buckets, e.time);
    if (i < 0) continue;
    if (e.kind === "claimed" || e.kind === "renewed") settled6[i] += e.amount6;
    else if (e.kind === "released") refunded6[i] += e.amount6;
    else if (e.kind === "funded" || e.kind === "fundedEth") funded6[i] += e.amount6;
  }
  return { running, settled6, refunded6, funded6 };
}

/* ---------- 3. the fleet ---------- */

export async function readFleet(apiBase) {
  const r = await fetch(apiBase + "/enclaves", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const rows = (j.enclaves || []).filter((e) => e.serving !== false).map((e) => {
    const a = e.availability || {};
    const gpu = a.gpu === true;
    const gFree = a.gpuShareFree != null ? a.gpuShareFree : (gpu ? a.maxShare || 0 : 0);
    const cFree = a.cpuShareFree != null ? a.cpuShareFree : (gpu ? 0 : a.maxShare || 0);
    return {
      name: e.name || String(e.endpoint || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "enclave",
      endpoint: e.endpoint || "", gpu,
      gpuUsed: gpu ? Math.max(0, Math.min(1, 1 - gFree)) : null,
      cpuUsed: Math.max(0, Math.min(1, 1 - cFree)),
    };
  });
  return { rows, aggregate: j.aggregate || {}, updatedAt: j.updatedAt || null };
}

/* ---------- the load ---------- */

/* Ledger + fleet first (they paint immediately), logs after (they may fail).
   `onPartial` gets the first half so the panel is useful while the scan runs. */
export async function loadMetrics({ depAddr, apiBase, leaseSec }, onPartial) {
  const now = nowSec();
  const buckets = makeBuckets(now);
  const [rows, fleet] = await Promise.all([
    readLedger(depAddr),
    readFleet(apiBase).catch((e) => ({ error: e.message || String(e), rows: [], aggregate: {} })),
  ]);
  const base = { now, buckets, rows, fleet, sum: summarize(rows, now), created: createdBuckets(rows, buckets), history: null };
  if (onPartial) onPartial(base);
  try {
    const { events, blocks } = await readHistory(depAddr, { spanSec: HOURS * HOUR, leaseSec });
    base.history = { ...bucketHistory(events, buckets), events: events.length, blocks };
  } catch (e) {
    base.history = { error: e.message || String(e) };
  }
  return base;
}

/* =========================================================================
   painting
   ========================================================================= */

const PAD = { l: 46, r: 12, t: 12, b: 22 };
const BAR_MAX = 24;        // marks stay thin: a column never fills its slot
const GAP = 2;             // the surface gap that separates touching marks
const RADIUS = 4;          // rounded data-end, square at the baseline

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/* a column: square where it meets the baseline, rounded at the data end */
function colPath(x, y, w, h) {
  const r = Math.min(RADIUS, w / 2, h);
  if (h <= 0.5) return "";
  return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
}
/* a horizontal bar: square at the axis, rounded at the data end */
function rowPath(x, y, w, h) {
  const r = Math.min(RADIUS, h / 2, w);
  if (w <= 0.5) return "";
  return `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}H${x}Z`;
}

const svgEl = (name, attrs, children) =>
  `<${name} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(String(v))}"`).join(" ")}>${children || ""}</${name}>`;

/* One time chart (columns or area) over the shared hourly buckets. */
function drawTimeChart(el, spec, w) {
  const { buckets, values, kind, fmt } = spec;
  const h = spec.height || 168;
  const pw = Math.max(40, w - PAD.l - PAD.r), ph = h - PAD.t - PAD.b;
  const max = niceMax(Math.max(...values, 0));
  const y = (v) => PAD.t + ph - (v / max) * ph;
  const slot = pw / buckets.length;
  const ticks = [0, max / 2, max];

  const grid = ticks.map((v) => svgEl("line", {
    x1: PAD.l, x2: PAD.l + pw, y1: y(v).toFixed(1), y2: y(v).toFixed(1),
    class: v === 0 ? "ac-axis" : "ac-grid",
  })).join("");
  const yLabels = ticks.map((v) => svgEl("text", {
    x: PAD.l - 8, y: (y(v) + 4).toFixed(1), class: "ac-tick", "text-anchor": "end",
  }, esc(fmt.tick(v)))).join("");

  // hour ticks every 6h; the last bucket is the hour in progress and says so
  const xLabels = buckets.map((b, i) => {
    const hr = new Date(b.t0 * 1000).getHours();
    if (hr % 6 !== 0 && i !== buckets.length - 1) return "";
    const anchor = i === buckets.length - 1 ? "end" : i === 0 ? "start" : "middle";
    const x = PAD.l + slot * (i + 0.5);
    return svgEl("text", { x: Math.min(Math.max(x, PAD.l), PAD.l + pw).toFixed(1), y: h - 6, class: "ac-tick", "text-anchor": anchor },
      esc(i === buckets.length - 1 ? "now" : String(hr).padStart(2, "0")));
  }).join("");

  let marks = "";
  if (kind === "columns") {
    const bw = Math.min(BAR_MAX, Math.max(2, slot - GAP));
    marks = values.map((v, i) => {
      const x = PAD.l + slot * i + (slot - bw) / 2;
      const top = y(v), bh = PAD.t + ph - top;
      return v > 0 ? svgEl("path", { d: colPath(+x.toFixed(1), +top.toFixed(1), +bw.toFixed(1), +bh.toFixed(1)), class: "ac-mark" }, "") : "";
    }).join("");
  } else {
    const pts = values.map((v, i) => [PAD.l + slot * (i + 0.5), y(v)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const area = line + `L${pts[pts.length - 1][0].toFixed(1)} ${(PAD.t + ph).toFixed(1)}L${pts[0][0].toFixed(1)} ${(PAD.t + ph).toFixed(1)}Z`;
    const last = pts[pts.length - 1];
    marks = svgEl("path", { d: area, class: "ac-area" }, "")
      + svgEl("path", { d: line, class: "ac-line" }, "")
      + svgEl("circle", { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 4, class: "ac-dot" }, "");
  }

  // one hit target per bucket, wider than the mark; the crosshair rides it
  const hits = buckets.map((b, i) => svgEl("rect", {
    x: (PAD.l + slot * i).toFixed(1), y: PAD.t, width: slot.toFixed(1), height: ph,
    class: "ac-hit", "data-i": i,
  }, "")).join("");
  const cross = kind === "area"
    ? svgEl("line", { x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + ph, class: "ac-cross", hidden: "hidden" }, "") : "";

  el.innerHTML = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: "ac-svg", role: "img",
    "aria-label": spec.aria || spec.title || "chart",
  }, grid + yLabels + xLabels + marks + cross + hits) + `<div class="ac-tip" hidden></div>`;
}

/* Fleet utilization: one row per enclave, a bar per pool, on one 0-100% axis. */
function drawFleetChart(el, spec, w) {
  const rows = spec.rows;
  const rowH = 34, barH = 9;
  const h = PAD.t + rows.length * rowH + 20;
  const labelW = 92;
  const l = labelW + 8, pw = Math.max(40, w - l - 44);
  const x = (f) => l + f * pw;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => svgEl("line", {
    x1: x(f).toFixed(1), x2: x(f).toFixed(1), y1: PAD.t - 4, y2: (PAD.t + rows.length * rowH - 8).toFixed(1),
    class: f === 0 ? "ac-axis" : "ac-grid",
  }, "")).join("");
  const xLabels = [0, 0.5, 1].map((f) => svgEl("text", {
    x: x(f).toFixed(1), y: h - 4, class: "ac-tick", "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle",
  }, esc(pct(f)))).join("");

  const body = rows.map((r, i) => {
    const top = PAD.t + i * rowH;
    const pools = [
      r.gpu ? { used: r.gpuUsed, cls: "s1", label: "GPU" } : null,
      { used: r.cpuUsed, cls: "s2", label: "CPU" },
    ].filter(Boolean);
    const bars = pools.map((p, k) => {
      const y = top + (pools.length === 1 ? rowH / 2 - barH / 2 - 4 : k * (barH + GAP) + 2);
      return svgEl("rect", { x: l, y: y.toFixed(1), width: pw.toFixed(1), height: barH, rx: RADIUS, class: "ac-track" }, "")
        + svgEl("path", { d: rowPath(l, +y.toFixed(1), +(p.used * pw).toFixed(1), barH), class: "ac-mark " + p.cls }, "");
    }).join("");
    return svgEl("text", { x: labelW, y: (top + 14).toFixed(1), class: "ac-rowlbl", "text-anchor": "end" }, esc(r.name))
      + bars
      + svgEl("rect", { x: 0, y: top.toFixed(1), width: w, height: rowH, class: "ac-hit", "data-i": i }, "");
  }).join("");

  el.innerHTML = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: "ac-svg", role: "img",
    "aria-label": spec.aria || "fleet utilization",
  }, grid + xLabels + body) + `<div class="ac-tip" hidden></div>`;
}

/* ---------- wiring: hover, keyboard, resize ---------- */

function showTip(plot, i) {
  const spec = plot._spec, tip = plot.querySelector(".ac-tip");
  if (!spec || !tip) return;
  const rows = spec.tipRows(i);
  if (!rows) return;
  tip.textContent = "";
  const head = document.createElement("b");
  head.textContent = rows.head;                       // labels are chain data: never innerHTML
  tip.appendChild(head);
  for (const r of rows.lines) {
    const d = document.createElement("span");
    if (r.color) { const k = document.createElement("i"); k.className = "ac-key " + r.color; d.appendChild(k); }
    const v = document.createElement("b"); v.textContent = r.value;      // the value leads
    const n = document.createElement("em"); n.textContent = r.label;
    d.appendChild(v); d.appendChild(n);
    tip.appendChild(d);
  }
  tip.hidden = false;
  const svg = plot.querySelector("svg");
  const hit = plot.querySelector(`.ac-hit[data-i="${i}"]`);
  if (svg && hit) {
    const sw = svg.getBoundingClientRect().width, vb = svg.viewBox.baseVal.width || sw;
    const cx = (parseFloat(hit.getAttribute("x")) + parseFloat(hit.getAttribute("width")) / 2) * (sw / vb);
    tip.style.left = Math.max(4, Math.min(sw - tip.offsetWidth - 4, cx - tip.offsetWidth / 2)) + "px";
    const cross = plot.querySelector(".ac-cross");
    if (cross) {
      const vx = parseFloat(hit.getAttribute("x")) + parseFloat(hit.getAttribute("width")) / 2;
      cross.setAttribute("x1", vx); cross.setAttribute("x2", vx); cross.removeAttribute("hidden");
    }
  }
  for (const m of plot.querySelectorAll(".ac-hit")) m.classList.toggle("on", +m.dataset.i === i);
  plot._at = i;
}

function hideTip(plot) {
  const tip = plot.querySelector(".ac-tip");
  if (tip) tip.hidden = true;
  const cross = plot.querySelector(".ac-cross");
  if (cross) cross.setAttribute("hidden", "hidden");
  for (const m of plot.querySelectorAll(".ac-hit")) m.classList.remove("on");
}

export function wirePlot(plot) {
  if (plot._wired) return;
  plot._wired = true;
  plot.addEventListener("pointermove", (e) => {
    const hit = e.target.closest(".ac-hit");
    if (hit) showTip(plot, +hit.dataset.i); else hideTip(plot);
  });
  plot.addEventListener("pointerleave", () => hideTip(plot));
  plot.addEventListener("focus", () => showTip(plot, plot._at ?? (plot._spec ? plot._spec.count - 1 : 0)));
  plot.addEventListener("blur", () => hideTip(plot));
  plot.addEventListener("keydown", (e) => {
    if (!plot._spec) return;
    const n = plot._spec.count;
    const at = plot._at ?? n - 1;
    if (e.key === "ArrowRight") { showTip(plot, Math.min(n - 1, at + 1)); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { showTip(plot, Math.max(0, at - 1)); e.preventDefault(); }
    else if (e.key === "Home") { showTip(plot, 0); e.preventDefault(); }
    else if (e.key === "End") { showTip(plot, n - 1); e.preventDefault(); }
    else if (e.key === "Escape") hideTip(plot);
  });
}

/* Draw (or redraw) one plot from the spec parked on it. */
export function drawPlot(plot) {
  const spec = plot._spec;
  if (!spec) return;
  const w = Math.max(280, Math.round(plot.clientWidth || 320));
  if (spec.kind === "fleet") drawFleetChart(plot, spec, w);
  else drawTimeChart(plot, spec, w);
  wirePlot(plot);
  if (plot._at != null) showTip(plot, Math.min(plot._at, spec.count - 1));
}

/* =========================================================================
   the panel
   ========================================================================= */

/* The skeleton, rendered with the rest of the console so the panel has its
   place before any chain read lands. */
export function metricsPanel() {
  return `<section class="ac-panel ac-metrics" id="acMetrics">
    <h3>Operations · last 24 hours</h3>
    <p class="ac-sub">Every number here is read live: the deployment records off the ledger, the hour-by-hour history off the chain's own event log, and pool usage off each enclave. Nothing is stored, so the window is fixed at 24 hours and ↻ Refresh is the only control. <b>Running</b> counts records whose lease has not expired - a runner that died still holds its lease until it lapses, and that is deliberately not smoothed away.</p>
    <div class="ac-kpis" id="acKpis"><div class="ac-kpi ac-kpi-wait">reading the ledger…</div></div>
    <div class="ac-charts" id="acCharts"></div>
    <div class="ac-status" role="status" aria-live="polite" hidden></div>
  </section>`;
}

const tile = (label, value, sub, tone) =>
  `<div class="ac-kpi${tone ? " " + tone : ""}"><span class="ac-kpi-l">${esc(label)}</span>
    <b class="ac-kpi-v">${esc(value)}</b><span class="ac-kpi-s">${sub}</span></div>`;

const fig = (id, title, subtitle, legend, aria) =>
  `<figure class="ac-fig" data-fig="${esc(id)}">
     <figcaption><span class="ac-fig-t">${esc(title)}</span><span class="ac-fig-s">${subtitle}</span></figcaption>
     ${legend || ""}
     <div class="ac-plot" id="plot-${esc(id)}" tabindex="0" aria-label="${esc(aria)}"></div>
     <details class="ac-tbl"><summary>Table view</summary><div class="ac-tbl-wrap" id="tbl-${esc(id)}"></div></details>
   </figure>`;

const tbl = (head, rows) =>
  `<table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
   <tbody>${rows.map((r) => `<tr>${r.map((c, i) => i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

/* Pass 1: everything the ledger and the relay can answer. The two event-log
   charts get their frame and a note; pass 2 fills them. */
export function paintMetrics(root, d) {
  const s = d.sum, kpis = root.querySelector("#acKpis"), charts = root.querySelector("#acCharts");
  const created24 = d.created.reduce((a, b) => a + b, 0);
  const runwayHr = s.rate6 > 0 ? s.balance6 / (s.rate6 * 3600) : null;

  kpis.innerHTML = [
    tile("Running now", String(s.running),
      `on ${s.runners.size} enclave${s.runners.size === 1 ? "" : "s"} · ${(s.gpuMilli / 1000).toFixed(2)} card + ${(s.cpuMilli / 1000).toFixed(2)} node sold`),
    tile("Waiting for an enclave", String(s.waiting),
      s.waiting ? `funded and claimable — nothing has taken them` : `every funded record is placed`, s.waiting ? "warn" : ""),
    tile("Out of funds", String(s.unfunded),
      s.unfunded ? `active but under one second of credit` : `no active record is empty`, s.unfunded ? "warn" : ""),
    tile("Created · 24 h", String(created24),
      `${s.total} on the ledger all-time · ${s.inactive} stopped`),
    tile("Committed spend", perHr(s.rate6),
      `what the running set bills while it holds its leases`),
    tile("Prepaid held", usd(s.balance6),
      runwayHr == null ? `no running record is billing` : `≈ ${runwayHr < 48 ? runwayHr.toFixed(1) + " h" : (runwayHr / 24).toFixed(1) + " days"} of runway at that rate`),
    tile("Settled · 24 h", "…", `reading the event log`, "ac-kpi-pending"),
    tile("Funded in · 24 h", "…", `reading the event log`, "ac-kpi-pending"),
  ].join("");

  const hours = d.buckets.map((b) => hourLabel(b.t0));
  const lastPartial = (i) => i === d.buckets.length - 1 ? " (in progress)" : "";

  charts.innerHTML =
    fig("created", "Deployments created", `per hour · ${created24} in the window`, "",
      `Deployments created per hour over the last 24 hours, ${created24} in total`) +
    fig("running", "Deployments running", `per hour · rebuilt from lease events`, "",
      `Deployments holding a live lease, per hour, over the last 24 hours`) +
    fig("spend", "Spend settled", `per hour · USDC burned by claims and renewals`, "",
      `USDC settled per hour over the last 24 hours`) +
    fig("fleet", "Fleet pools in use", d.fleet.error ? `<span class="ac-warn">relay unreachable</span>` : `right now · ${d.fleet.rows.length} serving enclave${d.fleet.rows.length === 1 ? "" : "s"}`,
      `<div class="ac-legend"><span><i class="ac-key s1"></i>GPU pool</span><span><i class="ac-key s2"></i>CPU pool</span></div>`,
      `Share of each enclave's GPU and CPU pools currently in use`);

  const createdPlot = root.querySelector("#plot-created");
  createdPlot._spec = {
    kind: "columns", buckets: d.buckets, values: d.created, count: d.buckets.length,
    fmt: { tick: (v) => String(Math.round(v)) },
    tipRows: (i) => ({
      head: hours[i] + lastPartial(i),
      lines: [{ value: String(d.created[i]), label: d.created[i] === 1 ? "deployment created" : "deployments created", color: "s1" }],
    }),
  };
  drawPlot(createdPlot);
  root.querySelector("#tbl-created").innerHTML =
    tbl(["Hour", "Created"], d.buckets.map((b, i) => [hourLabel(b.t0) + lastPartial(i), String(d.created[i])]));

  paintFleet(root, d);
  for (const id of ["running", "spend"]) {
    const p = root.querySelector("#plot-" + id);
    p.innerHTML = `<p class="ac-plot-note">scanning the chain's event log…</p>`;
  }
}

function paintFleet(root, d) {
  const plot = root.querySelector("#plot-fleet");
  if (d.fleet.error || !d.fleet.rows.length) {
    plot.innerHTML = `<p class="ac-plot-note">${d.fleet.error
      ? `the relay did not answer /enclaves: ${esc(d.fleet.error)}`
      : `no enclave is serving right now`}</p>`;
    root.querySelector("#tbl-fleet").innerHTML = "";
    return;
  }
  plot._spec = {
    kind: "fleet", rows: d.fleet.rows, count: d.fleet.rows.length,
    tipRows: (i) => {
      const r = d.fleet.rows[i];
      return {
        head: r.name,
        lines: [
          ...(r.gpu ? [{ value: pct(r.gpuUsed), label: "of the GPU pool in use", color: "s1" }] : []),
          { value: pct(r.cpuUsed), label: "of the CPU pool in use", color: "s2" },
        ],
      };
    },
  };
  drawPlot(plot);
  root.querySelector("#tbl-fleet").innerHTML = tbl(["Enclave", "GPU pool in use", "CPU pool in use"],
    d.fleet.rows.map((r) => [r.name, r.gpu ? pct(r.gpuUsed) : "—", pct(r.cpuUsed)]));
}

/* Pass 2: the event-log half. It either lands or it says why not - a partial
   scan is never shown as history. */
export function paintHistory(root, d) {
  const h = d.history || {};
  const kpis = root.querySelector("#acKpis");
  const hours = d.buckets.map((b) => hourLabel(b.t0));
  const lastPartial = (i) => i === d.buckets.length - 1 ? " (in progress)" : "";
  const pendingTiles = kpis.querySelectorAll(".ac-kpi-pending");

  if (h.error) {
    for (const id of ["running", "spend"]) {
      root.querySelector("#plot-" + id).innerHTML =
        `<p class="ac-plot-note">the public RPC pool would not serve the event log: ${esc(h.error)}. The ledger-derived numbers above are unaffected — retry with ↻ Refresh.</p>`;
      root.querySelector("#tbl-" + id).innerHTML = "";
    }
    pendingTiles.forEach((t) => {
      t.querySelector(".ac-kpi-v").textContent = "—";
      t.querySelector(".ac-kpi-s").textContent = "the event log was unavailable";
    });
    return;
  }

  const settled = h.settled6.reduce((a, b) => a + b, 0);
  const refunded = h.refunded6.reduce((a, b) => a + b, 0);
  const fundedIn = h.funded6.reduce((a, b) => a + b, 0);
  if (pendingTiles[0]) {
    pendingTiles[0].classList.remove("ac-kpi-pending");
    pendingTiles[0].querySelector(".ac-kpi-v").textContent = usd(settled - refunded);
    pendingTiles[0].querySelector(".ac-kpi-s").textContent =
      `${usd(settled)} burned by leases${refunded ? `, ${usd(refunded)} refunded on release` : ""}`;
  }
  if (pendingTiles[1]) {
    pendingTiles[1].classList.remove("ac-kpi-pending");
    pendingTiles[1].querySelector(".ac-kpi-v").textContent = usd(fundedIn);
    pendingTiles[1].querySelector(".ac-kpi-s").textContent = `top-ups and new deposits over the window`;
  }

  const peak = Math.max(...h.running);
  const runPlot = root.querySelector("#plot-running");
  runPlot._spec = {
    kind: "area", buckets: d.buckets, values: h.running, count: d.buckets.length,
    fmt: { tick: (v) => String(Math.round(v)) },
    tipRows: (i) => ({
      head: hours[i] + lastPartial(i),
      lines: [{ value: String(h.running[i]), label: h.running[i] === 1 ? "deployment holding a lease" : "deployments holding a lease", color: "s1" }],
    }),
  };
  drawPlot(runPlot);
  const runFig = root.querySelector('[data-fig="running"] .ac-fig-s');
  if (runFig) runFig.textContent = `per hour · peak ${peak} · now ${d.sum.running}`;
  root.querySelector("#tbl-running").innerHTML =
    tbl(["Hour", "Running"], d.buckets.map((b, i) => [hourLabel(b.t0) + lastPartial(i), String(h.running[i])]));

  const spendPlot = root.querySelector("#plot-spend");
  spendPlot._spec = {
    kind: "columns", buckets: d.buckets, values: h.settled6.map((v) => v / 1e6), count: d.buckets.length,
    fmt: { tick: (v) => v === 0 ? "$0" : "$" + (v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 1 : 0)) },
    tipRows: (i) => ({
      head: hours[i] + lastPartial(i),
      lines: [
        { value: usd(h.settled6[i]), label: "settled by claims and renewals", color: "s1" },
        ...(h.refunded6[i] ? [{ value: usd(h.refunded6[i]), label: "refunded on release" }] : []),
        ...(h.funded6[i] ? [{ value: usd(h.funded6[i]), label: "funded in" }] : []),
      ],
    }),
  };
  drawPlot(spendPlot);
  const spendFig = root.querySelector('[data-fig="spend"] .ac-fig-s');
  if (spendFig) spendFig.textContent = `per hour · ${usd(settled)} in the window`;
  root.querySelector("#tbl-spend").innerHTML =
    tbl(["Hour", "Settled", "Refunded", "Funded in"], d.buckets.map((b, i) =>
      [hourLabel(b.t0) + lastPartial(i), usd(h.settled6[i]), usd(h.refunded6[i]), usd(h.funded6[i])]));

  const status = root.querySelector("#acMetrics .ac-status");
  if (status) {
    status.hidden = false;
    status.className = "ac-status";
    status.textContent = `${h.events.toLocaleString()} ledger events over ${h.blocks.toLocaleString()} blocks · lease history is rebuilt from Claimed / Renewed / Released, so a deployment that neither renewed nor was released inside the window is only seen once its lease is touched.`;
  }
}

/* Redraw every plot in the panel against its current width. */
export function redrawPlots(root) {
  for (const p of root.querySelectorAll(".ac-plot")) if (p._spec) drawPlot(p);
}
