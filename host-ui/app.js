// host-ui/app.js -- the hosting panel's behaviour, the same on every host app (README.md). The node's answer is the truth:
// sliders move freely and are sent only by Apply; the switch and Save ask, and only the node's answer moves them. Nothing
// here waits on anything but the node: the panel draws what it last heard at once and refreshes behind it.
"use strict";
(function () {
  var T = window.EnclaveHostText, H = window.EnclaveHost;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = "/v1/local/hosting";
  var POLL_MS = 10000, EARNINGS_MS = 60000;

  var view = null, earnings = null, earningsWhy = "not asked yet", update = null, platform = { platform: "browser", titleBar: true };
  var dragging = false, applying = false, switching = false, refreshing = false, earningsBusy = false;
  var editingWallet = false, price = { cpu: { editing: false, busy: false }, gpu: { editing: false, busy: false } };
  var visible = document.visibilityState !== "hidden", pollTimer = null, earnTimer = null;

  var el = {
    panel: $("panel"), mast: $("mast"), sw: $("switch"), hostingLine: $("hostingLine"),
    rows: { limits: $("rowLimits"), price: $("rowPrice"), earnings: $("rowEarnings"), apps: $("rowApps") },
    pages: { limits: $("pageLimits"), price: $("pagePrice"), earnings: $("pageEarnings"), apps: $("pageApps") },
    vals: { limits: $("valLimits"), price: $("valPrice"), earnings: $("valEarnings"), apps: $("valApps") },
    cpu: $("cpu"), gpu: $("gpu"), cpuTitle: $("cpuTitle"), cpuLine: $("cpuLine"), cpuNote: $("cpuNote"),
    gpuBlock: $("gpuBlock"), gpuLine: $("gpuLine"), gpuNote: $("gpuNote"),
    unsaved: $("unsaved"), apply: $("apply"), reset: $("reset"),
    earnLine: $("earnLine"), earnNote: $("earnNote"), wallet: $("wallet"), walletHint: $("walletHint"),
    saveWallet: $("saveWallet"), editWallet: $("editWallet"), cancelWallet: $("cancelWallet"), payNow: $("payNow"),
    apps: $("apps"), status: $("status"), error: $("error"),
    ask: $("ask"), askHeading: $("askHeading"), askBody: $("askBody"), askDetail: $("askDetail"), askOk: $("askOk"), askCancel: $("askCancel"),
  };
  var priceEls = {};
  Array.prototype.forEach.call(document.querySelectorAll(".price"), function (box) {
    var part = function (p) { return box.querySelector('[data-part="' + p + '"]'); };
    priceEls[box.dataset.axis] = { box: box, label: box.dataset.label, line: part("line"), note: part("note"), field: part("box"), hint: part("hint"),
                                   edit: part("edit"), save: part("save"), cancel: part("cancel"), def: part("default") };
  });

  // ---- talking to the node --------------------------------------------------------------------------------------------
  /** -> { ok, body } | { ok: false, unreachable, message } | { ok: false, wouldDrop: [...], message } */
  function call(method, path, body) {
    return H.request(method, BASE + path, body).then(function (r) {
      if ("update" in r) update = r.update || null;
      if (!r.status) return { ok: false, unreachable: true, message: r.message || "the node is not answering" };
      var b = r.body || {};
      if (r.status >= 200 && r.status < 300) return { ok: true, body: b };
      if (r.status === 409 && b.error === "would_drop" && Array.isArray(b.drop))
        return { ok: false, wouldDrop: b.drop.filter(function (u) { return u && typeof u.id === "string"; }), message: b.message || "these caps would drop running work" };
      return { ok: false, message: "the node answered HTTP " + r.status + ": " + (typeof b.message === "string" ? b.message : JSON.stringify(b).slice(0, 200)) };
    });
  }

  // ---- what the panel shows ---------------------------------------------------------------------------------------------
  function cpuValue() { return Number(el.cpu.value) / T.STEPS; }
  function gpuValue() { return Number(el.gpu.value) / T.STEPS; }
  /** The sliders say something the node does not: moved and not applied (or being applied). */
  function pending() { return !!view && (Number(el.cpu.value) !== T.step(view.cpuCap) || (view.gpuAxis && Number(el.gpu.value) !== T.step(view.gpuCap))); }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function setWarn(node, warn) { node.classList.toggle("warn", !!warn); }
  function fill(slider) { slider.style.setProperty("--fill", (Number(slider.value) / T.STEPS * 100) + "%"); }
  function setSlider(slider, share) { slider.value = String(T.step(share)); fill(slider); }

  function sayRow(key, said) { setText(el.vals[key], said.text); setWarn(el.vals[key], said.warn); }
  function sayRows() {
    sayRow("limits", T.limitsRow(view, cpuValue(), gpuValue(), pending()));
    sayRow("price", T.priceRow(view));
    sayRow("earnings", T.earningsRow(earnings));
    el.rows.apps.hidden = !view || !view.apps;
    if (view && view.apps) sayRow("apps", T.appsRow(view));
  }

  function showError(message) { el.error.classList.remove("notice"); setText(el.error, message); el.error.hidden = !message; }
  function showNotice(message) { el.error.classList.add("notice"); setText(el.error, message); el.error.hidden = !message; }

  /**
   * The node's truth. The sliders move to it unless the owner is moving them or has moved them and not applied (judged
   * against the answer they were last set from, not this one).
   */
  function showView(v, snap) {
    var keep = !snap && (dragging || pending());
    view = v;
    if (!keep) { setSlider(el.cpu, v.cpuCap); setSlider(el.gpu, v.gpuCap); }
    el.cpu.disabled = el.gpu.disabled = false;
    setText(el.cpuTitle, v.cpuLabel + " share offered");
    el.gpuBlock.hidden = !v.gpuAxis;
    el.sw.setAttribute("aria-checked", String(!v.paused));
    var status = T.statusText(v);
    if (update && update.state === "downloading") status += "\n" + T.updateSay(update);
    setText(el.status, status);
    // a refresh never wipes what the owner was just told; the next Apply, switch or Reset does
    if (v.capsError) showError(v.capsError);
    showPrice("cpu"); showPrice("gpu");
    showApps();
    relabel();
    el.panel.removeAttribute("aria-busy");
  }

  function showUnreachable(why) {
    view = null;
    el.cpu.disabled = el.gpu.disabled = true;
    relabel();
    setText(el.cpuLine, "offered " + T.DASH + " · in use " + T.DASH); setText(el.gpuLine, el.cpuLine.textContent);
    setText(el.cpuNote, ""); setText(el.gpuNote, "");
    // an automatic update stops the node for a few minutes: say that, not "not reachable"
    setText(el.status, update ? T.updateSay(update) : "Node: not reachable. " + why);
    showError("");
    showPrice("cpu"); showPrice("gpu");
    el.panel.removeAttribute("aria-busy");
  }

  function relabel() {
    var v = view;
    // the switch, and the buttons: armed only by a change the node has not got
    el.sw.disabled = !v || !v.canPause || switching;
    var said = T.hostingLine(v, switching);
    setText(el.hostingLine, said.text); setWarn(el.hostingLine, said.warn);
    var p = pending();
    el.apply.disabled = el.reset.disabled = !p || applying;
    setText(el.apply, applying ? "Applying…" : "Apply");
    setText(el.unsaved, p && !applying ? "not applied" : "");
    sayRows();
    if (!v) return;
    var c = T.cpuLines(v, cpuValue(), p), g = T.gpuLines(v, gpuValue(), p);
    setText(el.cpuLine, c.line); setText(el.cpuNote, c.note); setWarn(el.cpuNote, c.warn);
    setText(el.gpuLine, g.line); setText(el.gpuNote, g.note); setWarn(el.gpuNote, g.warn);
  }

  // ---- Price: what this machine asks an hour for the whole of it; Edit opens a field with Save, Cancel and Use default ----
  function showPrice(axis) {
    var p = priceEls[axis], st = price[axis], a = view ? (axis === "gpu" ? view.gpuPrice : view.cpuPrice) : null;
    if (axis === "gpu") p.box.hidden = !view || !view.gpuAxis || !a;
    var open = st.editing && !!a, said = T.priceLines(a, axis, p.label, view ? view.noun : "PC");
    setText(p.line, said.line); setText(p.note, said.note);
    p.field.hidden = p.hint.hidden = p.save.hidden = p.cancel.hidden = !open;
    p.def.hidden = !open || a.override == null;
    p.edit.hidden = !a || open;
    p.def.disabled = st.busy;
    priceHint(axis);
  }
  function priceHint(axis) {
    var p = priceEls[axis], st = price[axis];
    if (!st.editing) return;
    var a = view ? (axis === "gpu" ? view.gpuPrice : view.cpuPrice) : null, h = T.priceHint(p.field.value, a, p.label);
    p.save.disabled = !h.canSave || st.busy;
    setText(p.hint, h.text); p.hint.className = "mono hint " + (h.ok ? "text" : "warn");
  }
  function editPrice(axis) {
    var p = priceEls[axis], a = view ? (axis === "gpu" ? view.gpuPrice : view.cpuPrice) : null;
    if (!a) return;
    price[axis].editing = true;
    var v = a.override != null ? a.override : a.perHour;
    p.field.value = String(Math.round(v * 1e4) / 1e4);
    showPrice(axis); p.field.focus(); p.field.select();
  }
  function cancelPrice(axis) { price[axis].editing = false; showPrice(axis); priceEls[axis].edit.focus(); }
  /** The owner's price (or null: back to the default). The node posts it to the registry on its next tick. */
  function savePrice(axis, perHour) {
    var st = price[axis];
    if (st.busy) return;
    st.busy = true; showPrice(axis);
    var body = {}; body[axis + "PerHour"] = perHour;
    call("PUT", "/price", body).then(function (r) {
      st.busy = false; st.editing = false;
      if (!r.ok) { showPrice(axis); showError("Price not saved: " + r.message); refresh(); return; }
      showView(T.hostingView(r.body), false);
      showNotice(perHour !== null ? "Price saved: new deployments are charged it once the registry has it (a minute or so)." : "Back to the default price.");
    });
  }

  // ---- Earnings and the payout wallet: pasted here, format-checked only (no wallet connects; nothing is signed) ----------
  function showEarnings(e, unavailable) {
    earnings = e; earningsWhy = unavailable || "";
    var noun = view ? view.noun : "PC", said = T.earningsLines(e, unavailable, noun);
    setText(el.earnLine, said.line); setText(el.earnNote, said.note); setWarn(el.earnNote, said.warn);
    el.payNow.disabled = !e || !e.readable || !e.payTo || !(e.earned > 0) || e.paying;
    showWallet();
    sayRows();
  }
  function savedWallet() { return earnings ? earnings.wallet : ""; }
  function walletReady() { return !!earnings && !!earnings.enclaveId; }
  /**
   * Saved: read-only (it can still be selected and copied), with Edit. Editing: open, with Save (armed only by a valid,
   * changed address) and Cancel (back to the saved address). No wallet yet: open for the first one, nothing to cancel.
   */
  function showWallet() {
    var saved = savedWallet();
    if (!saved && walletReady()) editingWallet = true;
    if (!editingWallet && el.wallet.value !== saved) el.wallet.value = saved;
    walletMode();
  }
  function walletMode() {
    var ready = walletReady(), open = editingWallet && ready;
    el.wallet.readOnly = !open; el.wallet.disabled = !ready; el.wallet.tabIndex = open ? 0 : -1;
    el.saveWallet.hidden = !open;
    el.cancelWallet.hidden = !(open && savedWallet());
    el.editWallet.hidden = !(ready && !open);
    walletHintNow();
  }
  function walletHintNow() {
    var h = T.walletHint(el.wallet.value, savedWallet(), editingWallet, walletReady());
    el.saveWallet.disabled = !h.canSave;
    setText(el.walletHint, h.text); el.walletHint.className = "mono hint " + h.tone;
  }
  function editWallet() { if (!walletReady()) return; editingWallet = true; walletMode(); el.wallet.focus(); el.wallet.select(); }
  function cancelWallet() { editingWallet = false; el.wallet.value = savedWallet(); walletMode(); if (!el.editWallet.hidden) el.editWallet.focus(); }
  function saveWallet() {
    var a = el.wallet.value.trim();
    if (!T.isAddress(a) || el.saveWallet.disabled) return;
    el.saveWallet.disabled = true;
    call("PUT", "/payout-wallet", { address: a }).then(function (r) {
      if (!r.ok) { showError("Payout wallet not saved: " + r.message); refreshEarnings(); return; }
      editingWallet = false;
      showEarnings(T.earningsView(r.body), null);
      showNotice("Payout wallet saved: earnings go to " + T.short(a) + ".");
    });
  }
  function payoutNow() {
    el.payNow.disabled = true;
    call("POST", "/payout").then(function (r) {
      if (!r.ok) { showError("Not paid out: " + r.message); refreshEarnings(); return; }
      return call("GET", "/earnings").then(function (g) {
        if (g.ok) { showEarnings(T.earningsView(g.body), null); showNotice("Paid out" + (earnings.lastTx ? " (tx " + T.short(earnings.lastTx) + ")" : "") + "."); }
        else showNotice("Paid out.");
      });
    });
  }

  // ---- Apps: what runs here, each by the name it is reached at -------------------------------------------------------
  function showApps() {
    if (!view || !view.apps) return;
    var key = JSON.stringify(view.apps);
    if (el.apps.dataset.key === key) return;
    el.apps.dataset.key = key;
    el.apps.textContent = "";
    if (!view.apps.length) { var li = document.createElement("li"); li.className = "none"; li.textContent = "None right now."; el.apps.appendChild(li); return; }
    view.apps.forEach(function (a) {
      var li = document.createElement("li"), name = document.createElement(a.host ? "a" : "span"), phase = document.createElement("span");
      name.textContent = a.host || a.id.slice(0, 10) + "…";
      if (a.host) { name.href = "https://" + a.host + "/"; name.title = a.id; name.addEventListener("click", function (ev) { ev.preventDefault(); H.send("open", { url: name.href }); }); }
      phase.className = "phase" + (a.phase === "serving" ? "" : " warn");
      phase.textContent = a.phase === "serving" ? "serving" : (a.phase || "starting") + "…";
      li.appendChild(name); li.appendChild(phase); el.apps.appendChild(li);
    });
  }

  // ---- the accordion: a row per section, its details under it, at most one open ---------------------------------------
  function openKey() { for (var k in el.rows) if (el.rows[k].getAttribute("aria-expanded") === "true") return k; return null; }
  function toggle(key) {
    var open = el.rows[key].getAttribute("aria-expanded") !== "true";
    closeAll(false);
    el.rows[key].setAttribute("aria-expanded", String(open)); el.pages[key].hidden = !open;
    el.rows[key].focus();
    if (open) el.rows[key].scrollIntoView({ block: "nearest" });
  }
  function closeAll(focusRow) {
    var was = openKey();
    for (var k in el.rows) { el.rows[k].setAttribute("aria-expanded", "false"); el.pages[k].hidden = true; }
    if (focusRow && was) el.rows[was].focus();
  }

  // ---- the node's answers, applied ----------------------------------------------------------------------------------------
  function show(r, snap) {
    if (r.ok) { showView(T.hostingView(r.body), snap); return; }
    showUnreachable(r.message);
  }
  function refresh() {
    if (refreshing || applying || switching) return;
    refreshing = true;
    call("GET", "").then(function (r) { refreshing = false; if (r.ok || r.unreachable) show(r, false); else showUnreachable(r.message); });
  }
  function refreshEarnings() {
    if (earningsBusy) return;
    earningsBusy = true;
    call("GET", "/earnings").then(function (r) {
      earningsBusy = false;
      if (r.ok) showEarnings(T.earningsView(r.body), null);
      else showEarnings(null, update ? "back when the update finishes" : r.message);
    });
  }

  function confirmAsk(said) {
    return new Promise(function (resolve) {
      setText(el.askHeading, said.heading); setText(el.askBody, said.body); setText(el.askDetail, said.detail || ""); setText(el.askOk, said.ok);
      // Esc closes a modal dialog by itself (and may skip its cancel event): any close that is not the OK button is Cancel
      var done = function (yes) { el.askOk.onclick = el.askCancel.onclick = el.ask.onclose = null; if (el.ask.open) el.ask.close(); resolve(yes); };
      el.askOk.onclick = function () { done(true); };
      el.askCancel.onclick = function () { done(false); };
      el.ask.onclose = function () { done(false); };
      el.ask.showModal();
      el.askCancel.focus();                          // Cancel is the default: nothing happens unless the owner presses the other
    });
  }

  function requestApply() { if (pending() && !applying && view) apply(); }
  function apply() {
    applying = true; relabel();
    var cpu = cpuValue(), gpu = view.gpuAxis ? gpuValue() : view.gpuCap;
    send(cpu, gpu, null);
  }
  /**
   * PUT the caps. The first try confirms nothing, so caps that would drop running work come back as the node's list (409
   * would_drop) having changed nothing; the owner sees that list and only "Drop N and apply" sends it back confirmed.
   */
  function send(cpu, gpu, confirmed) {
    var body = { cpuShare: Math.round(cpu * 100) / 100 };
    if (view && view.gpuAxis) body.gpuShare = Math.round(gpu * 100) / 100;
    if (confirmed) body.drop = confirmed;
    call("PUT", "", body).then(function (r) {
      if (r.wouldDrop && r.wouldDrop.length) {
        // asked again if what it would drop changed between the warning and the confirmation
        return confirmAsk(T.askDrop(r.wouldDrop, cpu, gpu, view)).then(function (yes) {
          if (yes) { send(cpu, gpu, r.wouldDrop.map(function (u) { return u.id; })); return; }
          applying = false; relabel();
          showNotice("Not applied: nothing was dropped. Raise the caps, or Reset.");
        });
      }
      applying = false;
      if (!r.ok) { relabel(); showError("Not applied: " + r.message); refresh(); return; }   // the sliders keep the owner's values
      var v = T.hostingView(r.body);
      showView(v, true);
      if (v.dropped > 0) showNotice("Dropped " + (v.dropped === 1 ? "1 deployment" : v.dropped + " deployments") + ": "
                                    + (v.dropped === 1 ? "its lease goes" : "their leases go") + " back to the network.");
      else showError("");
    });
  }

  /**
   * The switch. ON takes work under the caps. OFF stops EVERYTHING: with apps running the node first answers with their
   * list (409 would_drop) having changed nothing; only "Stop N and turn off" sends it back confirmed. The caps are kept.
   */
  function setPaused(paused, confirmed) {
    if (!view || switching) return;
    switching = true; relabel();
    var body = { paused: paused }; if (confirmed) body.drop = confirmed;
    call("PUT", "", body).then(function (r) {
      switching = false;
      if (r.wouldDrop && r.wouldDrop.length) {
        return confirmAsk(T.askOff(r.wouldDrop, view)).then(function (yes) {
          relabel();
          if (yes) { setPaused(true, r.wouldDrop.map(function (u) { return u.id; })); return; }
          showNotice("Hosting is still on: nothing was stopped.");
          refresh();
        });
      }
      if (!r.ok) { relabel(); showError("Hosting was not turned " + (paused ? "off" : "on") + ": " + r.message); refresh(); return; }
      showView(T.hostingView(r.body), false);                  // a move not yet applied stays as it is
      showError("");
    });
  }

  // ---- wiring -------------------------------------------------------------------------------------------------------------
  Object.keys(el.rows).forEach(function (k) { el.rows[k].addEventListener("click", function () { toggle(k); }); });
  [el.cpu, el.gpu].forEach(function (s) {
    s.addEventListener("pointerdown", function () { dragging = true; });
    var up = function () { if (dragging) { dragging = false; relabel(); } };
    s.addEventListener("pointerup", up); s.addEventListener("pointercancel", up); s.addEventListener("change", up);
    // nothing is sent until Apply: a move only relabels and arms the buttons
    s.addEventListener("input", function () { fill(s); relabel(); });
    s.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); requestApply(); } });
    s.addEventListener("wheel", function (ev) {
      if (s.disabled) return;
      ev.preventDefault();
      s.value = String(Math.max(0, Math.min(T.STEPS, Number(s.value) + (ev.deltaY < 0 ? 1 : -1)))); fill(s); relabel();
    }, { passive: false });
  });
  el.apply.addEventListener("click", requestApply);
  el.reset.addEventListener("click", function () { if (view && !applying) { showView(view, true); showError(""); } });
  el.sw.addEventListener("click", function () { if (view && !switching) setPaused(!view.paused, null); });

  Object.keys(priceEls).forEach(function (axis) {
    var p = priceEls[axis];
    p.edit.addEventListener("click", function () { editPrice(axis); });
    p.cancel.addEventListener("click", function () { cancelPrice(axis); });
    p.save.addEventListener("click", function () { var v = T.parsePrice(p.field.value); if (!p.save.disabled && v !== null) savePrice(axis, v); });
    p.def.addEventListener("click", function () { savePrice(axis, null); });
    p.field.addEventListener("input", function () { priceHint(axis); });
    p.field.addEventListener("keydown", function (ev) {
      var v = T.parsePrice(p.field.value);
      if (ev.key === "Enter" && !p.save.disabled && v !== null) { ev.preventDefault(); savePrice(axis, v); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancelPrice(axis); }
    });
  });

  el.wallet.addEventListener("input", function () { if (editingWallet) walletHintNow(); });
  el.wallet.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && editingWallet && !el.saveWallet.disabled) { ev.preventDefault(); saveWallet(); }
    else if (ev.key === "Escape" && editingWallet && !el.cancelWallet.hidden) { ev.preventDefault(); ev.stopPropagation(); cancelWallet(); }
  });
  el.saveWallet.addEventListener("click", saveWallet);
  el.editWallet.addEventListener("click", editWallet);
  el.cancelWallet.addEventListener("click", cancelWallet);
  el.payNow.addEventListener("click", payoutNow);

  /** Esc (or Android's Back): closes the open section, else hides the window. An open field's Esc is the field's. */
  function back() {
    if (el.ask.open) return true;
    if (openKey()) { closeAll(true); return true; }
    H.send("hide");
    return false;
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape" || ev.defaultPrevented || el.ask.open) return;   // an open question's Esc is its Cancel
    var f = document.activeElement;
    if (f && f.tagName === "INPUT" && f.type === "text" && !f.readOnly) return;
    ev.preventDefault(); back();
  });

  // Hiding with changes not applied discards them: the panel opens again on what the node says, every section closed.
  function hidden() { if (view && !applying) showView(view, true); closeAll(false); visible = false; schedule(); }
  function shown() { visible = true; refresh(); refreshEarnings(); schedule(); }
  H.on("show", shown);
  H.on("hidden", hidden);
  H.on("back", back);
  H.on("refresh", function () { refresh(); refreshEarnings(); });
  // the tray menu's switch: the panel's own, so turning off with apps running asks here first
  H.on("toggle", function () { if (view && !switching) setPaused(!view.paused, null); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") { visible = false; schedule(); } else shown(); });

  /** Polls only while the panel can be seen: the node every 10 s, the chain's earnings every minute. */
  function schedule() {
    clearInterval(pollTimer); clearInterval(earnTimer); pollTimer = earnTimer = null;
    if (!visible) return;
    pollTimer = setInterval(refresh, POLL_MS);
    earnTimer = setInterval(refreshEarnings, EARNINGS_MS);
  }

  // the window's height follows the panel (the Windows tray grows up from the taskbar as sections open)
  var lastH = 0;
  function reportSize() {
    var h = Math.ceil(el.panel.getBoundingClientRect().height);
    if (h !== lastH) { lastH = h; H.send("size", { height: h }); }
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(el.panel);

  H.hello().then(function (r) {
    if (r && r.platform) platform = r;
    el.mast.hidden = platform.titleBar !== false;
    if (typeof platform.notice === "string" && platform.notice) showError(platform.notice);
    document.documentElement.dataset.platform = platform.platform || "browser";
  });
  showUnreachable("not asked yet");
  showEarnings(null, "not asked yet");
  refresh(); refreshEarnings(); schedule();
  window.EnclaveHostPanel = { refresh: refresh, refreshEarnings: refreshEarnings, back: back };
})();
