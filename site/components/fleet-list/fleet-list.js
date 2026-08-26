/* ============================================================
   <c-fleet-list> - per-enclave capacity rows (the relay's
   /enclaves table). Assign `.rows` (already sorted upstream) and
   it renders each box's two capacity pools. Copy says "available",
   never "free": on a page that sells compute, "60 GB free" reads as
   a price, not as headroom.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { esc, fmtNum, short, showToast } from "../../js/core/util.js";
import { starsHtml } from "../../js/core/reviews.js";
import { hrevConfigured, hrevTallies, hrevMine, encCall, HREV_SEL, waitReceipt, REVIEW_MAX_BODY } from "../../js/core/chain.js";
import { HOST_REVIEWS_ADDRESS } from "../../js/core/config.js";
import { Enclave } from "../../js/core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { serverSpec, enclavePriceOf, enclaveClassOf, shieldedPoolOf } from "../../js/core/pricing.js";
import { REGISTRY_ADDRESS } from "../../js/core/config.js";
import { catExplorer } from "../../js/core/chain.js";

class FleetList extends EnclaveElement {
  static properties = { rows: null };
  static templateUrl = new URL("./fleet-list.html", import.meta.url);

  renderedCallback() {
    const list = this.querySelector(".fleet-list"); if (!list) return;
    // only enclaves that SERVE (take on-chain work) are shown: a live but
    // non-claiming box (relay row serving:false) is operational truth, not
    // sellable capacity - listing it would advertise hardware nobody can buy.
    // Rows from an older relay carry no verdict and stay visible.
    const rows = (this.rows || []).filter((e) => e.serving !== false);
    const meter = (pct) => '<i class="fleet-meter" aria-hidden="true"><b style="width:' + Math.max(0, Math.min(100, pct)) + '%"></b></i>';
    // one stat cell: bright available amount, then the "≈"/"/ total" context and
    // the label in dim ink so the number is what the eye lands on
    const stat = (avail, total, unit, label, title) =>
      '<span class="fleet-stat"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<b><i>≈</i>' + avail + '<i> / ' + total + '</i>' + (unit ? " " + unit : "") + '</b>'
      + '<small>' + label + '</small></span>';
    // the price sits directly under the pool's GPU/CPU label - bright number,
    // dim "/hr" - in the label column's otherwise-empty second row, so it
    // costs no space and each pool names its own rate (card vs node). It is
    // the WHOLE card / node per hour, the ledger's basis; a share pays its
    // fraction. Trailing ".00" trims like the docs' rates.
    const perHr = (v) => "$" + (v * 3600).toFixed(2).replace(/\.00$/, "");
    // one pool = a [label | meter | pct] header line, the price under the
    // label, stat cells underneath
    const pool = (label, pct, stats, price) =>
      '<div class="fleet-pool">'
      + '<span class="fleet-pool-label">' + label + '</span>'
      + meter(pct)
      + '<span class="fleet-pool-pct"><b>' + pct + '%</b> available</span>'
      // the label column's second row holds the pool's rate. A pool whose seller
      // has posted no ask simply leaves it empty rather than inventing one.
      + (price != null ? '<span class="fleet-pool-price"><b>' + perHr(price) + '</b>/hr</span>' : '')
      + '<span class="fleet-stats">' + stats + '</span>'
      + '</div>';
    list.innerHTML = (!rows.length
      ? '<div class="fleet-empty">no live enclaves right now</div>'
      : rows.map(e => {
          const a = e.availability || {};
          const gpu = a.gpu === true;
          const gFree = a.gpuShareFree != null ? a.gpuShareFree : (gpu ? a.maxShare || 0 : 0);
          const cFree = a.cpuShareFree != null ? a.cpuShareFree : (gpu ? 0 : a.maxShare || 0);
          const gPct = Math.floor(gFree * 100), cPct = Math.floor(cFree * 100);
          // the relay names each row (tunnel enclaves: their tunnel name, e.g.
          // "metal0"); the endpoint-derived fallback covers older relays — and
          // strips ANY scheme, so a tunnel:// row never renders as a pseudo-URL
          const name = e.name || String(e.endpoint || "").replace(/^[a-z]+:\/\//, "").split(".")[0] || "enclave";
          // Any host may also CARRY traffic; one with no resources at all only
          // carries it, and that is what this badge reads — no capacity, so
          // nothing to sell and nothing to meter. Empty CPU/GPU bars would say
          // "full", which is the opposite of the truth, so the row lists the
          // network services the box offers instead.
          if (e.relay === true) {
            const r = a.relay || {};
            const svc = [["sni", "app traffic"], ["tcp", "tcp ports"], ["udp", "udp ports"],
                         ["egress", "outbound ip"], ["tunnelHub", "tunnel hub"]]
              .filter(([k]) => r[k] === true).map(([, label]) => label);
            return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
              + '<span class="fleet-head">'
              + '<span class="ap-badge">relay</span>'
              + '<span class="fleet-name">' + esc(name) + '</span>'
              + (r.region ? '<span class="fleet-relay-region">' + esc(r.region) + '</span>' : '')
              + '</span>'
              + '<span class="fleet-relay-note">'
              + (svc.length ? 'carries ' + svc.map(esc).join(" · ") : 'carries no declared services')
              + (r.ports ? ' · ports ' + esc(r.ports) : '')
              + (r.v6Prefix ? ' · ' + esc(r.v6Prefix) : '')
              + '</span>'
              + '</div>';
          }
          // A card on the box's UNTRUSTED host, reached by masked offload — the
          // enclave uses it without trusting it, so the row must not read as an
          // in-enclave GPU. It gets its own badge and its own pool, and it is
          // deliberately NOT folded into `gpu`: that flag means the card is
          // inside the measured enclave, which is a different thing to buy.
          const sh = a.shielded && a.shielded.vramGb > 0 ? a.shielded : null;
          // A shielded box now reports `gpu: true` -- its card IS its card, and is
          // sold as one. So `gpu` alone no longer means "inside the enclave", and
          // reading it that way is how this row briefly badged a card on an
          // untrusted host as TEE GPU. The distinction a buyer needs is where the
          // silicon is, and that is exactly `sh`.
          const cls = enclaveClassOf(e);
          const inTee = cls.inTee;
          // What is SELLABLE is the worker's budget, not the physical card: the
          // untrusted host keeps the rest (on a desktop, an X server). Showing the
          // physical total here while the GPU pool showed the budget is what put
          // two differently-sized GPU rows on one single-card box.
          const shPool = shieldedPoolOf(e);
          const shTotal = shPool ? shPool.total : 0;
          const shFreeGb = shPool ? shPool.freeGb : 0;
          const shFree = shPool ? shPool.frac : 0;
          const shPct = Math.floor(shFree * 100);
          const s = serverSpec();   // adopted fleet hardware; display fallback for rows that omit their own
          const vramGb = a.cardVramGb || s.cardVramGb, tflops = a.cardTflops || s.cardTflops;
          const ramGb = a.nodeRamGb || s.nodeRamGb, vcpus = a.nodeVcpus || s.nodeVcpus;
          const price = enclavePriceOf(e);   // this box's posted ask; the fleet price where it posts none
          return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
            + '<span class="fleet-head">'
            // ONE badge, naming what the box is. Jade "TEE GPU" for a card INSIDE
            // the measured enclave, iris "GPU" for one on the untrusted host
            // reached by masked offload -- the ABSENCE of "tee" is the signal,
            // and the tooltip says outright that this card is outside the
            // enclave and outside its measurement. Plain "CPU" only when there
            // is no card at all — a box with a GPU is not a CPU box that happens to
            // have one, and badging it both ways buries the thing a buyer came
            // to look for. Every row still shows its CPU POOL underneath; the
            // badge answers what the box is, the pools answer what it has.
            + (inTee
                ? '<span class="ap-badge ok" title="This card is INSIDE the confidential'
                  + ' enclave and covered by its attestation.">tee gpu</span>'
                : sh
                ? '<span class="ap-badge info" title="' + esc(sh.card || "gpu")
                  + ' on this box\u2019s untrusted host, used by masked offload: it receives '
                  + 'public weights and one-time-padded activations, and every result is '
                  + 'verified. The card is outside the enclave and outside its measurement, '
                  + 'so this is NOT a TEE GPU \u2014 your activations are protected by the '
                  + 'masking, not by the card.">gpu</span>'
                : '<span class="ap-badge">cpu</span>')
            + '<span class="fleet-name">' + esc(name) + '</span>'
            + this._ratingHtml(e)
            + '</span>'
            + (sh ? pool("GPU", shPct,
                stat(fmtNum(shFreeGb), fmtNum(shTotal), "GB", "vram available")
                // The box reports what it measured -- G-MAC/s of the masked field
                // GEMM -- and the cell shows tflops, because that is the unit the
                // pool above it uses and a customer should not have to convert
                // between two throughput units to compare two boxes. One MAC is a
                // multiply and an add, so the factor is exactly 2; nothing is
                // being flattered here.
                //
                // The two numbers are NOT like for like, and the tooltip says so.
                // A GPU pool's tflops is the card's vendor peak; this one is a
                // sustained rate measured on the kernel that actually runs. The
                // honest fix is to measure both, not to quote a peak for this one
                // so the columns look comparable.
                + (sh.gmacPerSec > 0
                    ? stat(Math.round(shFree * sh.gmacPerSec * 2 / 1000),
                           Math.round(sh.gmacPerSec * 2 / 1000), "", "tflops available",
                           "Measured on this box: " + Math.round(sh.gmacPerSec)
                           + " G-MAC/s sustained by the masked field GEMM that actually runs "
                           + "here, converted at 2 FLOP per MAC. A GPU pool's tflops figure is "
                           + "the card's vendor peak, so the two are not directly comparable.")
                    : stat(esc(sh.card || "gpu"), "", "", "card")),
                price.shielded) : "")
            // ONLY when the card is in the enclave. A shielded card already drew its
            // pool above, from the numbers the probe actually measured; drawing
            // this one too would advertise one piece of silicon twice.
            + (inTee ? pool("GPU", gPct,
                stat(fmtNum(a.vramFreeGb != null ? a.vramFreeGb : gFree * vramGb), fmtNum(vramGb), "GB", "vram available")
                + stat(Math.round(gFree * tflops), Math.round(tflops), "", "tflops available"), price.full) : "")
            + pool("CPU", cPct,
                // prefer the enclave's own figure (the RAM-reservation ledger,
                // which is what actually gates admission) over the folded
                // fraction — same precedence the VRAM cell above uses
                stat(fmtNum(a.ramGbFree != null ? a.ramGbFree : cFree * ramGb), fmtNum(ramGb), "GB", "ram available")
                + stat(fmtNum(cFree * vcpus), fmtNum(vcpus), "", "vcpu available")
                // a box carrying model volumes can read ~85% used with every
                // tenant idle: preloaded weights are held, not free. Name that
                // term or the meter looks broken.
                + (a.ramNnResidentMb ? stat(fmtNum(a.ramNnResidentMb / 1024), fmtNum(ramGb), "GB", "held by models") : ""),
                price.node)
            + '<div class="fleet-rateform" data-form="' + esc(e.id || "") + '" hidden></div>'
            + '</div>';
        }).join(""));
    this._wireRate();
    // footer row: a manual refresh (dispatches `refresh`; the HOST owns the
    // fetch and re-assigns .rows, which re-renders and re-arms the button) +
    // the on-chain registry this table mirrors, linked once the address book
    // has resolved (enclaves register there)
    this._loadRatings(rows);      // stars per box, one eth_call for the panel
    const foot = this.querySelector(".fleet-foot");
    if (foot) {
      foot.innerHTML = '<button class="fleet-refresh" type="button" title="re-fetch the live fleet view">↻ refresh</button>'
        + (/^0x[0-9a-fA-F]{40}$/.test(REGISTRY_ADDRESS || "")
          ? '<a class="contract-link" href="' + catExplorer() + '/address/' + REGISTRY_ADDRESS + '" target="_blank" rel="noopener" title="EnclaveRegistry · ' + REGISTRY_ADDRESS + '">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
            + '<line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg> contract</a>'
          : "");
      const btn = foot.querySelector(".fleet-refresh");
      btn.addEventListener("click", () => {
        btn.disabled = true;
        this.dispatch("refresh");
        setTimeout(() => { btn.disabled = false; }, 4000);   // safety net if no host listener re-assigns .rows
      });
    }
  }

  /* The host page re-assigns .rows on a 20s poll, and every assignment
     repaints the whole list - which would yank an open rating form out from
     under the wallet mid-edit (nothing "auto-hides" it; the row simply gets
     rebuilt). While a form is open the repaint is DEFERRED, then flushed when
     it closes, so fresh capacity numbers still land the moment the user is
     done. */
  requestRender(){
    if (this._rateOpen){ this._renderDeferred = true; return; }
    super.requestRender();
  }
  _closeRate(box, btn){
    this._rateOpen = false;
    if (box){ box.hidden = true; box.innerHTML = ""; }
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (this._renderDeferred){ this._renderDeferred = false; super.requestRender(); }
  }

  /* ---- rating a host: the same 5-star control the app store uses ----
     The contract takes a RECEIPT - one of your funded deployments whose
     `runner` is this box - and checks it itself, so the form's job is to find
     that deployment first. Your deployment rows already name the enclave
     serving them (the relay stamps it), which is exactly the "runs here now"
     the receipt needs. No receipt = the form says why instead of offering a
     signature that would revert. */
  _wireRate(){
    for (const btn of this.querySelectorAll(".fleet-rate"))
      btn.addEventListener("click", () => this._openRate(btn));
  }
  async _openRate(btn){
    const encId = btn.dataset.encid, name = btn.dataset.rate;
    const box = this.querySelector('[data-form="' + CSS.escape(encId) + '"]');
    if (!box) return;
    if (!box.hidden) return this._closeRate(box, btn);
    box.hidden = false; btn.setAttribute("aria-expanded", "true");
    this._rateOpen = true;                 // hold off list repaints until this closes
    box.innerHTML = '<p class="fleet-gate dim">checking whether this enclave runs an app of yours…</p>';
    if (!Enclave.address){
      box.innerHTML = '<p class="fleet-gate">Only wallets whose apps this enclave has run can rate it. '
        + '<button class="btn btn-sm" data-act="connect" type="button">Connect wallet</button></p>';
      box.querySelector('[data-act="connect"]').addEventListener("click", () => connectWallet().then(() => this._openRate(btn)).catch(() => {}));
      return;
    }
    const [receipt, mine] = await Promise.all([
      this._receiptFor(name).catch(() => null),
      hrevMine(encId, Enclave.address).catch(() => null),
    ]);
    const already = mine && /^0x0*[1-9a-f]/i.test(mine.reviewer || "");
    if (!receipt && !already){
      box.innerHTML = '<p class="fleet-gate">Nothing of yours is running on <b>' + esc(name) + '</b> right now. '
        + 'Ratings come from wallets whose app this box actually ran - deploy here first, then rate it.</p>';
      return;
    }
    const d = { stars: already ? Number(mine.stars) : 0, body: already ? mine.body : "" };
    const pick = [1, 2, 3, 4, 5].map((n) =>
      '<label class="revs-pick-star' + (d.stars >= n ? " on" : "") + '">'
      + '<input class="sr-only" type="radio" name="hrevStars-' + esc(encId) + '" value="' + n + '"' + (d.stars === n ? " checked" : "") + '>'
      + '<span aria-hidden="true">★</span><span class="sr-only">' + n + (n === 1 ? " star" : " stars") + '</span></label>').join("");
    box.innerHTML = '<div class="revs-write">'
      + '<fieldset class="revs-pick"><legend>' + (already ? "Update your rating of " : "Rate ") + esc(name) + '</legend>' + pick + '</fieldset>'
      + '<textarea class="revs-body" rows="2" placeholder="How did this box run it? (optional)"></textarea>'
      + '<div class="revs-write-foot">'
        + '<span class="revs-count">' + REVIEW_MAX_BODY + ' left</span>'
        + (receipt ? '<span class="revs-receipt" title="the funded deployment this enclave is running for you">receipt ' + esc(short(receipt)) + '</span>'
                   : '<span class="revs-receipt" title="you have rated this box before, so an edit needs no fresh receipt">editing your rating</span>')
        + '<button class="btn btn-primary btn-sm" data-act="post" type="button" disabled>' + (already ? "Update rating" : "Post rating") + '</button>'
      + '</div></div>';
    const ta = box.querySelector(".revs-body"); ta.value = d.body || "";
    const post = box.querySelector('[data-act="post"]');
    const count = box.querySelector(".revs-count");
    const sync = () => {
      const on = box.querySelector('input[type="radio"]:checked');
      const left = REVIEW_MAX_BODY - new TextEncoder().encode(ta.value || "").length;
      count.textContent = left + " left"; count.classList.toggle("over", left < 0);
      post.disabled = this._busy || !on || left < 0;
      for (const l of box.querySelectorAll(".revs-pick-star"))
        l.classList.toggle("on", on && Number(l.querySelector("input").value) <= Number(on.value));
    };
    box.addEventListener("change", sync); ta.addEventListener("input", sync); sync();
    post.addEventListener("click", () => this._postRate(box, encId, name, receipt, post, sync));
  }

  /* One of MY deployments this box is running now (the relay stamps each row
     with the serving enclave's name). Funded is implied: a row only has a
     runner because a lease was claimed, and the contract re-checks anyway. */
  async _receiptFor(name){
    const res = await Enclave.listDeployments();
    const rows = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
    const hit = rows.find((d) => d && d.enclave === name && /^0x[0-9a-f]{64}$/i.test(d.id || "")
      && ["running", "claimed", "provisioning"].includes(d.status || ""));
    return hit ? hit.id : null;
  }

  async _postRate(box, encId, name, receipt, btn, sync){
    const on = box.querySelector('input[type="radio"]:checked');
    if (!on) return;
    const body = box.querySelector(".revs-body").value || "";
    this._busy = true; btn.disabled = true; btn.textContent = "signing…";
    try {
      if (!Enclave.provider) await connectWallet();
      await ensureBaseChain();
      const data = encCall(HREV_SEL.post, [
        { t: "bytes32", v: encId },
        { t: "bytes32", v: receipt || "0x" + "0".repeat(64) },
        { t: "uint", v: Number(on.value) },
        { t: "str", v: body },
      ]);
      const hash = await sendTx(HOST_REVIEWS_ADDRESS, data);
      showToast("rating " + name + " · " + hash.slice(0, 12) + "…");
      await waitReceipt(hash);
      showToast("rated " + name);
      this._closeRate(box, this.querySelector('.fleet-rate[data-encid="' + CSS.escape(encId) + '"]'));
      this._tallyKey = null;                 // force a re-read so the stars move
      this._loadRatings(this.rows || []);
    } catch (e) {
      showToast("rating failed: " + ((e && (e.shortMessage || e.message)) || e));
      btn.textContent = "Post rating";
    } finally { this._busy = false; if (sync) sync(); }
  }

  /* Stars for a box, from EnclaveHostReviews. Absent contract (not deployed /
     not in the address book yet) renders NOTHING rather than a fake 0 - an
     unrated fleet and an unreadable one are different claims. */
  _ratingHtml(e){
    const t = this._tallies && this._tallies[String(e.id || "").toLowerCase()];
    if (!hrevConfigured()) return "";
    const rate = '<button class="fleet-rate btn btn-sm" type="button" data-rate="' + esc(e.name || "") + '" data-encid="' + esc(e.id || "") + '" aria-expanded="false" '
      + 'title="Rate this enclave - open to wallets whose app it is running">rate</button>';
    if (!t || !t.count)
      return '<span class="fleet-rating fleet-unrated" title="No wallet has rated this enclave yet">unrated</span>' + rate;
    const avg = t.sum / t.count;
    return '<span class="fleet-rating" title="' + t.count + ' rating' + (t.count === 1 ? "" : "s") + ' from wallets whose apps this enclave ran">'
      + starsHtml(avg) + '<small>' + avg.toFixed(1) + ' (' + t.count + ')</small></span>' + rate;
  }

  /* One talliesOf call covers every visible box. Cached per paint; a fleet
     row set that hasn't changed doesn't re-read the chain. */
  async _loadRatings(rows){
    if (!hrevConfigured()) return;
    const ids = rows.map((e) => String(e.id || "")).filter((x) => /^0x[0-9a-f]{64}$/i.test(x));
    const key = ids.join(",");
    if (!ids.length || key === this._tallyKey) return;
    this._tallyKey = key;
    try {
      const rowsT = await hrevTallies(ids);
      this._tallies = Object.fromEntries(rowsT.map((r) => [String(r.enclaveId).toLowerCase(), r]));
      this.requestRender();    // repaint with the stars in place
    } catch { /* ratings are decoration: a chain hiccup must not blank the panel */ }
  }
}
register("c-fleet-list", FleetList);
