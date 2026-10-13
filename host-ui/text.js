// host-ui/text.js -- what the panel says, as pure functions of the node's answers (no DOM here, so Node tests run them).
// Read defensively: a missing field is a default, never a crash. Ported from the Windows tray's panel (EnclaveTray.cs
// before host-ui), wording kept, with the machine's noun ("PC", "phone") and its shares (a phone has no GPU) from the node.
"use strict";
(function (root) {
  var STEPS = 20;                                                  // the share sliders: 5% a step
  var DASH = "–", DOT = " · ", ELL = "…";

  function obj(o, k) { var v = o && o[k]; return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  function num(o, k, d) {
    var v = o ? o[k] : undefined;
    if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean") return d;
    v = Number(v); return isFinite(v) ? v : d;
  }
  function str(o, k) { var v = o ? o[k] : undefined; return typeof v === "string" ? v : ""; }
  function bool(o, k) { return !!o && o[k] === true; }
  // the node sends 6-decimal integers as strings, so nothing is lost on the way
  function usdc(six) { return typeof six === "string" && /^[0-9]{1,30}$/.test(six) ? Number(six) / 1e6 : 0; }

  function priceAxis(o) {
    if (!o || typeof o !== "object") return null;
    var a = { perHour: num(o, "perHour", 0), gb: num(o, "gb", 0), flops: num(o, "flops", 0), tier: str(o, "tier"),
              override: null, defaultPerHour: -1, defaultFrom: "" };
    var ov = num(o, "override", -1); if (ov > 0) a.override = ov;
    var def = obj(o, "default");
    if (def) { a.defaultPerHour = num(def, "perHour", -1); a.defaultFrom = str(def, "from"); }
    return a;
  }

  /** GET /v1/local/hosting, read the way the panel uses it. */
  function hostingView(o) {
    o = o || {};
    var caps = obj(o, "caps"), inUse = obj(o, "inUse"), free = obj(o, "free"), gpu = obj(o, "gpu"), market = obj(o, "market"),
        pricing = obj(o, "pricing"), gas = obj(o, "gas"), device = obj(o, "device");
    var axes = Array.isArray(o.axes) ? o.axes.filter(function (x) { return x === "cpu" || x === "gpu"; }) : ["cpu", "gpu"];
    if (axes.indexOf("cpu") < 0) axes.unshift("cpu");
    var apps = Array.isArray(o.apps) ? o.apps.filter(function (a) { return a && typeof a.id === "string"; }).map(function (a) {
      var id = a.id;
      return { id: id, appRef: str(a, "appRef"), phase: str(a, "phase"),
               host: str(a, "host") || (/^0x[0-9a-fA-F]{8}/.test(id) ? id.slice(2, 10).toLowerCase() + ".app.enclave.host" : "") };
    }) : null;
    return {
      cpuCap: num(caps, "cpuShare", 0), gpuCap: num(caps, "gpuShare", 0),
      paused: bool(caps, "paused"), canPause: !!caps && "paused" in caps,               // an older node has no switch
      cpuInUse: num(inUse, "cpuShare", 0), gpuInUse: num(inUse, "gpuShare", 0),
      cpuFree: num(free, "cpuShare", 0), gpuFree: num(free, "gpuShare", 0),
      reserved: num(o, "reservedShare", 0),
      served: Math.round(num(o, "deploymentsServed", 0)), waitingForCap: Math.round(num(o, "waitingForCap", 0)),
      backend: str(o, "backend"), capsError: str(o, "capsError"), logsDir: str(o, "logsDir"),
      gpuConsumer: bool(gpu, "consumer"), gpuWhy: str(gpu, "why"), appsEnabled: bool(o, "appsEnabled"),
      taking: market ? bool(market, "taking") : null, takingWhy: market ? str(market, "why") : "",   // null: an older node
      dropped: Array.isArray(o.dropped) ? o.dropped.length : 0,
      cpuPrice: priceAxis(pricing && pricing.cpu), gpuPrice: priceAxis(pricing && pricing.gpu),
      gasLow: bool(gas, "low"), gasHoursLeft: gas ? num(gas, "hoursLeft", -1) : -1, gasOperator: str(gas, "operator"),
      noun: str(device, "noun") || "PC", axes: axes, gpuAxis: axes.indexOf("gpu") >= 0,
      cpuLabel: str(o, "cpuLabel") || "CPU", apps: apps,
    };
  }

  /** GET /v1/local/hosting/earnings: USDC the ledger holds for this machine, and where it goes. */
  function earningsView(o) {
    o = o || {};
    var h = Array.isArray(o.history) && o.history.length ? o.history[0] : null;
    return { readable: bool(o, "readable"), paying: bool(o, "paying"),
             earned: usdc(o.earned6), paidOut: usdc(o.paidOut6), minPayout: usdc(o.minPayout6),
             enclaveId: str(o, "enclaveId"), operator: str(o, "operator"), wallet: str(o, "wallet"), payTo: str(o, "payTo"),
             why: str(o, "why"), lastError: str(o, "lastError"), lastTx: str(h, "tx") };
  }

  function pct(share) { return Math.round(share * 100) + "%"; }
  function step(share) { return Math.round(share * STEPS); }
  function usd(v) { return "$" + (Math.round(v * 100) / 100).toFixed(2); }
  /** A price: more digits the smaller it is. */
  function usdPrice(perHour) { return "$" + perHour.toFixed(perHour >= 1 ? 2 : perHour >= 0.01 ? 3 : 4); }
  function short(a) { return a.length > 14 ? a.slice(0, 8) + ELL + a.slice(-4) : a; }
  function cut(s, head, tail) { s = s || ""; return s.length <= head + tail + 1 ? s : s.slice(0, head) + ELL + (tail > 0 ? s.slice(-tail) : ""); }
  function cap1(s) { return s.length ? s[0].toUpperCase() + s.slice(1) : s; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  /** The only check a payout wallet gets: its format. 0x and 40 hexadecimal digits, and not the zero address. */
  function isAddress(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && /[1-9a-fA-F]/.test(a.slice(2)); }

  /** The line beside the switch: the NETWORK's word on taking new work, not the switch's. -> { text, warn } */
  function hostingLine(v, switching) {
    if (!v) return { text: DASH, warn: false };
    var waiting = !v.paused && v.taking === false;
    var text = !v.canPause ? "on (this node has no off switch yet: update the node)"
      : switching ? (v.paused ? "turning on" + ELL : "turning off" + ELL)
      : v.paused ? (v.served > 0 ? "off" + DOT + "stopping " + v.served + " app(s)" + ELL : "off" + DOT + "nothing runs; this " + v.noun + " is all yours")
      : waiting ? "on" + DOT + "NOT taking new work yet: " + v.takingWhy
      : v.taking === true ? "on" + DOT + "listed on enclave.host, taking new work under your limits"
      : "on" + DOT + "taking new work under your limits";
    return { text: text, warn: v.paused || waiting };
  }

  /** The node's state, under the accordion. */
  function statusText(v) {
    var waiting = v.waitingForCap > 0 ? ", " + v.waitingForCap + " waiting for room under the cap" : "";
    return "Node: reachable" + DOT + "backend " + (v.backend || "?") + DOT + v.served + plural(v.served, " deployment", " deployments") + " served" + waiting
      + (v.appsEnabled ? "" : DOT + "hosting is off on this node (APPS)")
      + (v.gasLow ? "\nOperator gas is LOW" + (v.gasHoursLeft >= 0 ? " (about " + Math.round(v.gasHoursLeft) + " hours left)" : "")
                    + ": send a little ETH on Base to " + v.gasOperator + " or apps stop renewing and go away" : "");
  }

  /** The accordion rows' right side: what each section is set to now; warn where it waits on the owner. */
  function limitsRow(v, cpu, gpu, pending) {
    if (!v) return { text: DASH, warn: false };
    var over = v.cpuInUse > cpu + 1e-9 || (v.gpuAxis && v.gpuConsumer && v.gpuInUse > gpu + 1e-9);
    return { text: v.cpuLabel + " " + pct(cpu) + (v.gpuAxis ? DOT + "GPU " + pct(gpu) : "") + (pending ? DOT + "not applied" : over ? DOT + "more in use" : ""),
             warn: pending || over };
  }
  function rate(a) { return usdPrice(a.override != null ? a.override : a.perHour) + "/h"; }
  function priceRow(v) {
    var c = v && v.cpuPrice, g = v && v.gpuAxis ? v.gpuPrice : null;
    return { text: c ? "CPU " + rate(c) + (g ? DOT + "GPU " + rate(g) : "") : DASH, warn: false };
  }
  function earningsRow(e) {
    if (!e || !e.readable) return { text: DASH, warn: false };
    if (!e.payTo) return { text: usd(e.earned) + " earned" + DOT + (e.wallet ? "payout waiting" : "add a payout wallet"), warn: true };
    return { text: usd(e.earned) + " earned" + DOT + usd(e.paidOut) + " paid", warn: false };
  }
  function appsRow(v) {
    if (!v || !v.apps) return { text: DASH, warn: false };
    var serving = v.apps.filter(function (a) { return a.phase === "serving"; }).length, other = v.apps.length - serving;
    return { text: v.apps.length === 0 ? "none" : serving + " serving" + (other ? DOT + other + " starting" : ""), warn: false };
  }

  var BELOW_USE = "Below what is in use: Apply asks before it drops running deployments (newest first) until use fits.";
  var MORE_IN_USE = "More than this is in use. Nothing running is stopped; new work waits until use drops below it.";
  /** A share's two lines under its slider. -> { line, note, warn } */
  function cpuLines(v, cpu, pending) {
    var note = "";
    if (v.cpuInUse > cpu + 1e-9) note = pending ? BELOW_USE : MORE_IN_USE;
    else if (v.reserved > 0 && cpu > 1 - v.reserved + 1e-9) note = "New claims stop at " + pct(1 - v.reserved) + ": the node keeps " + pct(v.reserved) + " for itself.";
    return { line: "offered " + pct(cpu) + DOT + "in use " + pct(v.cpuInUse), note: note, warn: v.cpuInUse > cpu + 1e-9 };
  }
  function gpuLines(v, gpu, pending) {
    // never imply GPU hosting that is not happening: the node says why (repeat it, don't guess)
    var note = !v.gpuConsumer ? "Nothing on this node uses the GPU right now" + (v.gpuWhy ? " (" + v.gpuWhy + ")" : "") + "; this cap applies when something does."
      : v.gpuInUse > gpu + 1e-9 ? (pending ? BELOW_USE : MORE_IN_USE) : "";
    return { line: "offered " + pct(gpu) + DOT + "in use " + pct(v.gpuInUse), note: note, warn: v.gpuConsumer && v.gpuInUse > gpu + 1e-9 };
  }

  /** One price, CPU or GPU, as its section shows it. -> { line, note } */
  function priceLines(a, axis, label, noun) {
    if (!a) return { line: label + " " + DASH, note: "" };
    var line = label + " " + usdPrice(a.override != null ? a.override : a.perHour) + " an hour" + DOT + (a.override != null ? "your price" : "default");
    // the registry counts whole micro-USDC a second ($0.0036 an hour): say what is posted when it rounds away from it
    var posted = a.override != null && Math.abs(a.perHour - a.override) > a.override * 0.002
      ? " Posted as " + usdPrice(a.perHour) + " an hour: the registry counts whole micro-USDC a second." : "";
    var size = " for this " + noun + "'s " + trim1(a.gb) + " GB × " + trim1(a.flops) + (axis === "gpu" ? " TFLOPS" : " GFLOPS");
    var tierName = a.tier.toUpperCase().replace("TEE-", "TEE ").replace("PVM-", "pVM ");
    var def = a.defaultPerHour < 0 ? "reading the network's prices" + ELL
      : (a.defaultFrom ? "the cheapest " + tierName + " host's rate (" + a.defaultFrom + ")" : "the network's starting rate (no other " + tierName + " host yet)") + size;
    var note = a.override != null
      ? "Set by you. The default would be " + (a.defaultPerHour >= 0 ? usdPrice(a.defaultPerHour) + " an hour: " : "") + def + "." + posted
      : "Default: " + def + ". A deployment pays the share of it it leases.";
    return { line: line, note: note };
  }
  function trim1(x) { var s = (Math.round(x * 10) / 10).toFixed(1); return s.slice(-2) === ".0" ? s.slice(0, -2) : s; }
  /** A typed price: USDC an hour, above 0 and at most 1000 (a leading $ is fine). -> number or null */
  function parsePrice(t) {
    t = String(t || "").trim().replace(/^\$/, "").trim();
    if (!/^[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?$/i.test(t)) return null;
    var v = Number(t);
    return isFinite(v) && v > 0 && v <= 1000 ? v : null;
  }
  function priceHint(text, a, label) {
    var v = parsePrice(text), ok = v !== null;
    return { ok: ok, canSave: ok && (!a || a.override == null || Math.abs(v - a.override) > 1e-12),
             text: ok ? "USDC an hour for the whole " + label + (a && a.defaultPerHour > 0 ? " (default " + usdPrice(a.defaultPerHour) + ")" : "")
                      : "a price in USDC an hour, above 0 and at most 1000" };
  }

  /** The Earnings section's two lines. -> { line, note, warn } */
  function earningsLines(e, unavailable, noun) {
    if (!e || !e.readable)
      return { line: "earned " + DASH + DOT + "paid out " + (e ? usd(e.paidOut) : DASH), note: e ? e.why : unavailable || "", warn: false };
    var line = "earned " + usd(e.earned) + " not yet paid" + DOT + "paid out " + usd(e.paidOut);
    if (e.payTo)
      return { line: line, warn: false, note: "Credited every second to this " + noun + "'s operator key " + short(e.operator) + ", then paid to your wallet "
        + short(e.payTo) + " automatically from " + usd(e.minPayout) + "." + (e.lastError ? " Last try failed: " + e.lastError : "") };
    if (e.wallet) return { line: line, note: cap1(e.why) + ".", warn: true };
    return { line: line, warn: false, note: "Credited every second to this " + noun + "'s operator key " + short(e.operator)
      + ". Paste your wallet's address below to have them paid to it; until then they wait in the ledger." };
  }
  /** Under the payout wallet's field. -> { text, tone: "jade" | "dim" | "warn" | "text", canSave } */
  function walletHint(typed, saved, editing, ready) {
    var a = String(typed || "").trim(), changed = a.toLowerCase() !== String(saved || "").toLowerCase(), ok = isAddress(a);
    var canSave = editing && ready && changed && ok;
    if (!editing && saved) return { text: "✓ earnings are paid to this wallet", tone: "jade", canSave: canSave };
    if (!a) return { text: "your wallet's public address: 0x and 40 characters", tone: "dim", canSave: canSave };
    if (!changed) return { text: "this is the saved wallet: paste another to change it, or Cancel", tone: "dim", canSave: canSave };
    if (!ok) return { text: "not a wallet address yet: 0x followed by 40 characters 0-9, a-f (" + Math.max(0, a.length - 2) + " of 40)", tone: "warn", canSave: canSave };
    return { text: "a valid address: Save to have earnings paid to it", tone: "text", canSave: canSave };
  }

  /** The question before an Apply drops running work: what the node said it would drop, newest first. */
  function askDrop(units, cpu, gpu, v) {
    var n = units.length === 1 ? "1 deployment" : units.length + " deployments", one = units.length === 1;
    var list = units.map(function (u) {
      return cut(u.id, 10, 0) + "  " + cut(u.appRef, 22, 4) + "  " + pct(u.cpuShare || 0) + " CPU" + (u.gpuShare > 0 ? ", " + pct(u.gpuShare) + " GPU" : "");
    }).join("\n");
    return { heading: "Drop running work?",
             body: "Applying " + v.cpuLabel + " " + pct(cpu) + (v.gpuAxis ? DOT + "GPU " + pct(gpu) : "") + " leaves no room for " + n + " running on this " + v.noun + ". "
               + (one ? "It is" : "They are") + " stopped now and " + (one ? "its lease is" : "their leases are") + " handed back to the network, so another host can take "
               + (one ? "it" : "them") + " (newest first):",
             detail: list, ok: "Drop " + units.length + " and apply" };
  }
  /** The question before the switch turns hosting off with apps running: all of them stop. */
  function askOff(units, v) {
    var n = units.length === 1 ? "1 app" : units.length + " apps", one = units.length === 1;
    var list = units.map(function (u) { return cut(u.id, 10, 0) + "  " + cut(u.appRef, 22, 4); }).join("\n");
    return { heading: "Turn hosting off?",
             body: n + " running on this " + v.noun + " " + (one ? "is" : "are") + " stopped now and " + (one ? "its lease is" : "their leases are")
               + " handed back to the network, so another host takes " + (one ? "it" : "them") + " over. Nothing of the apps keeps running: this "
               + v.noun + "'s " + (v.gpuAxis ? "CPU, GPU and memory are" : "CPU and memory are") + " all yours until you turn hosting on again.",
             detail: list, ok: "Stop " + n + " and turn off" };
  }

  /** An automatic update the shell reports (Windows: update-host.ps1's update.json). */
  function updateSay(u) {
    return u.state === "installing" ? "Updating to " + u.to + ": installing. Hosting stops for a few minutes and resumes on its own."
                                    : "Downloading update " + u.to + "; hosting carries on until it installs.";
  }

  var T = { STEPS: STEPS, DASH: DASH, hostingView: hostingView, earningsView: earningsView, pct: pct, step: step, usd: usd, usdPrice: usdPrice,
            short: short, isAddress: isAddress, hostingLine: hostingLine, statusText: statusText, limitsRow: limitsRow, priceRow: priceRow,
            earningsRow: earningsRow, appsRow: appsRow, cpuLines: cpuLines, gpuLines: gpuLines, priceLines: priceLines, parsePrice: parsePrice,
            priceHint: priceHint, earningsLines: earningsLines, walletHint: walletHint, askDrop: askDrop, askOff: askOff, updateSay: updateSay };
  root.EnclaveHostText = T;
})(typeof window !== "undefined" ? window : globalThis);
