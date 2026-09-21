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
import { serverSpec, enclavePriceOf, enclaveClassOf, shieldedPoolOf, teeCpuOf,
         appHostingOf, servesWork, sellsFullService } from "../../js/core/pricing.js";
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
    // A CONSUMER NODE (a PC attested as a VBS enclave, teeCpuOf) is the one
    // exception, and it has TWO states now. Before it claims, it sells nothing: it
    // holds a model inside its enclave rather than the app shares this list meters,
    // the relay records serving:false, and hiding it would say the tier does not
    // exist while a real attested node is attached - so it is shown as what it is,
    // with no capacity bars and no price. Once it claims (claimEnabled) it is a
    // seller like any other and gets the full row: pool, share, price, rating. What
    // it does NOT get is silence about where a hosted app runs (see `honest`).
    // A relay row stays hidden either way: it sells nothing at all.
    const consumerNode = (e) => e.relay !== true && teeCpuOf(e).consumer === true;
    const rows = (this.rows || []).filter((e) => e.serving !== false || consumerNode(e));
    const meter = (pct) => '<i class="fleet-meter" aria-hidden="true"><b style="width:' + Math.max(0, Math.min(100, pct)) + '%"></b></i>';
    // one stat cell: bright available amount, then the "≈"/"/ total" context and
    // the label in dim ink so the number is what the eye lands on
    const stat = (avail, total, unit, label, title) =>
      '<span class="fleet-stat"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<b><i>≈</i>' + avail + '<i> / ' + total + '</i>' + (unit ? " " + unit : "") + '</b>'
      + '<small>' + label + '</small></span>';
    // the price sits directly under the pool's label (its badge) - bright number,
    // dim "/hr" - in the label column's otherwise-empty second row, so it
    // costs no space and each pool names its own rate (card vs node). It is
    // the WHOLE card / node per hour, the ledger's basis; a share pays its
    // fraction. Trailing ".00" trims like the docs' rates.
    const perHr = (v) => "$" + (v * 3600).toFixed(2).replace(/\.00$/, "");
    // one pool = a [label | meter | pct] header line, the price under the
    // label, stat cells underneath. The label is the pool's badge (see the
    // row builder): the pill names the pool, so nothing else has to.
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
          // THE CONSUMER PILL, needed by two row kinds below, so it is built once here.
          // The tier earned its pill with real evidence against a weaker threat model, and
          // the pill says which: "vbs enclave", never "tee cpu"; a dev-tier row (a relay
          // that admitted a test-signed build) says "development, unsigned".
          const tc = teeCpuOf(e);
          const serves = servesWork(e);          // does this box take work from the market?
          const hosting = appHostingOf(e);       // ...and where does an app it takes RUN?
          const consumerBadge = !tc.consumer ? '' :
            '<span class="ap-badge ' + (tc.dev ? 'warn' : 'ok') + '" title="' + esc(tc.label) + ': ' + esc(tc.note)
              + '. The relay verified this PC’s TPM quote, measured-boot log and enclave report when it attached.'
              + (tc.dev ? ' This build is ' + esc(tc.dev) + ': admitted by a development policy.' : '')
              // The pill says what is ATTESTED, and on this tier that is the enclave
              // holding the model, the pads and the keys. It must not be read as
              // covering a hosted app as well, so where the box itself says the app
              // runs elsewhere, the pill says so too rather than leaving the reader
              // to infer the scope of a green badge.
              + (hosting.outsideTee ? ' It covers the enclave that holds the model and the keys.'
                  + ' An app hosted here runs outside that enclave.' : '')
              + '">' + (tc.dev ? 'vbs enclave (dev)' : 'vbs enclave') + '</span>';
          /* THE APP RESIDENCY CALLOUT - the whole point of this row kind.
             Every other box in the fleet runs a tenant's app INSIDE the TEE whose
             attestation this row badges. A box reporting apps.inTee:false does not:
             its enclave holds the model and the keys, and the app runs in the
             machine's ordinary session, which the owner can read. Once such a box
             claims, the row is an OFFER of app hosting, so the difference has to be
             on the row, in a sentence, unprompted.

             WHY THIS TREATMENT, out of the three that were on the table:
             - Not a second badge beside the vbs pill. That pill is the CPU pool's
               LABEL, column 1 of the row's subgrid, and the column is sized by its
               widest badge: a second pill there widens the label column and squashes
               every meter in the panel. It is also the wrong scope - this is a fact
               about the box, not about its CPU pool.
             - Not a badge alone anywhere. A badge can only carry three words, and the
               rest would live in a `title`, which is not disclosed at all on a touch
               device. A caveat nobody can read is not a disclosure.
             - So: the site's OWN honesty-callout idiom, the "what we do not claim"
               box from the isolation section (.iso-honest), scaled to row density.
               Amber hairline with the 3px left accent, amber-deep tint, a mono
               uppercase amber label that scans like a badge, and the sentence itself
               in sans - prose gets the human typeface (DESIGN.md's Mono Voice Rule),
               which is also what makes it stand out in a panel of instrument mono.
               Amber, not red: the box is not broken and is not lying. It sells
               something narrower and says so itself.
             It sits directly under the name and ABOVE the pools on purpose: the
             caveat has to be read before the price, not after it. The label is a
             <b>, not a heading - one heading per fleet row would add five entries to
             the page outline for a caption. */
          const honest = !(serves && hosting.outsideTee) ? '' :
            '<div class="fleet-honest"><b>apps run outside the enclave</b>'
            + '<p>An app you deploy here runs beside the enclave on this machine’s ordinary'
            + ' desktop, not inside it, so the box’s owner can read the app’s memory and its'
            + ' traffic. The enclave holds the model and the keys, and its attestation covers'
            + ' those, not your app. If your app’s data has to stay private from the person who'
            + ' owns the box, deploy it on a box without this notice.</p></div>';
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
          // WHAT THE ENCLAVE ITSELF RUNS: the model it holds and the card it offloads
          // to without trusting it. This is exactly the set the pill's attestation
          // covers, so both consumer states below carry it - on a serving row it is
          // the counterweight to the callout, naming what IS inside the enclave right
          // beside the statement of what is not.
          const shn = a.shielded || {};
          const encRuns = !tc.consumer ? [] : [
            ...(a.model ? ['holds ' + esc(String(a.model).replace(/\.gguf$/i, '')) + ' inside its enclave'] : []),
            ...(shn.device ? ['masked offload to ' + esc(shn.device)
              + (shn.vramGiB || shn.vramGb ? ' (' + esc(String(shn.vramGiB || shn.vramGb)) + ' GiB)' : '')] : []),
          ];
          // The consumer node BEFORE it claims: what it RUNS, not what it sells, because
          // it sells nothing yet. Empty share meters would read as "full", which is the
          // opposite of the truth, and a price would quote capacity nobody can buy.
          if (consumerNode(e) && !serves) {
            const parts = encRuns.slice();
            // Apps, when it hosts any. The residency is the point and is never implied: on this
            // tier the enclave holds the model, while an app is a wasm component on the Windows
            // host, which its owner can read. So the row says where, in those words.
            if (hosting.running > 0)
              parts.push(String(hosting.running) + ' app' + (hosting.running === 1 ? '' : 's')
                + ' on the host' + (hosting.outsideTee ? ', outside the enclave' : ''));
            return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
              + '<span class="fleet-head">'
              + consumerBadge
              + '<span class="fleet-name">' + esc(name) + '</span>'
              + '</span>'
              + '<span class="fleet-relay-note">'
              + (parts.length ? parts.join(" \u00b7 ") : 'runs a model inside its enclave')
              + (hosting.ownerOnly ? ' \u00b7 takes app work only from its own owner' : ' \u00b7 serves its own inference, not app deployments')
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
          // THE POOL LABELS ARE THE BADGES. Each pool is named by what it is, in
          // the colour that means it, right beside its own meter; the header
          // carries only the box's name and rating. Pills in the header and a
          // plain "CPU"/"GPU" beside the meters said the same thing twice in two
          // registers, and the reader had to pair them up.
          //
          // The CPU pool: jade "TEE CPU" only when there is EVIDENCE the box's
          // CPU is a confidential-computing TEE (the technology its own
          // attestation document presented, or the relay's verified SEV-SNP
          // attach, see teeCpuOf) -- never inferred from the box having no card.
          // A separate root of trust is coming (hosts anchored on a phone), and
          // those boxes must not inherit a green pill they did not prove: amber
          // "NO TEE CPU" when the box reports a non-TEE document (a metal dev
          // box), plain "CPU" when it has not said.
          const teeCpuBadge = tc.real && tc.consumer
            ? consumerBadge
            : tc.real
            ? '<span class="ap-badge ok" title="' + esc(tc.label) + ' confidential VM: '
              + (tc.source === "relay"
                  ? 'the relay verified a fresh hardware quote from this box when it attached'
                  : 'this box\u2019s attestation document presents a hardware quote')
              + ', so every vCPU it sells runs inside the measured enclave and is covered by'
              + ' its attestation.">tee cpu</span>'
            : tc.known
            ? '<span class="ap-badge warn" title="This box reports no CPU TEE (attestation format '
              + esc(tc.technology) + '): nothing it sells is covered by a hardware attestation.">no tee cpu</span>'
            : '<span class="ap-badge" title="This box has not reported whether its CPU is a TEE:'
              + ' its build predates the field, or its attestation document has not been read yet.'
              + ' Only a hardware quote earns the green pill.">cpu</span>';
          // The GPU pool: jade "TEE GPU" for a card INSIDE the measured enclave,
          // iris "GPU" for one on the untrusted host reached by masked offload --
          // the ABSENCE of "tee" is the signal, and the tooltip says outright
          // that this card is outside the enclave and outside its measurement.
          const cardBadge = inTee
            ? '<span class="ap-badge ok" title="This card is INSIDE the confidential'
              + ' enclave and covered by its attestation.">tee gpu</span>'
            : sh
            ? '<span class="ap-badge info" title="' + esc(sh.card || "gpu")
              + ' on this box\u2019s untrusted host, used by masked offload: it receives '
              + 'public weights and one-time-padded activations, and every result is '
              + 'verified. The card is outside the enclave and outside its measurement, '
              + 'so this is NOT a TEE GPU \u2014 your activations are protected by the '
              + 'masking, not by the card.">gpu</span>'
            : "";
          // What is SELLABLE is the worker's budget, not the physical card: the
          // untrusted host keeps the rest (on a desktop, an X server). Showing the
          // physical total here while the GPU pool showed the budget is what put
          // two differently-sized GPU rows on one single-card box.
          const shPool = shieldedPoolOf(e);
          const shTotal = shPool ? shPool.total : 0;
          // LEASABLE, not resident. A shielded worker keeps only the model's
          // encoded weights on the card, so the silicon reads nearly empty while
          // the card is fully booked; showing that reading as "available" quoted
          // capacity the allocator would refuse to sell. The physical number is
          // still true and still worth saying, so it moves into the tooltip.
          const shLeasableGb = shPool ? shPool.leasableGb : 0;
          const shPhysFreeGb = shPool ? shPool.freeGb : 0;
          const shReservedGb = shPool ? shPool.reservedGb : 0;
          const shFree = shPool ? shPool.frac : 0;
          const shPct = Math.floor(shFree * 100);
          const shVramTitle = sh?.pooled
            ? fmtNum(shTotal) + ' GB combined across ' + sh.cardCount + ' GPUs. Each share reserves the same fraction of every card. Models are split automatically; overflow uses the enclave CPU.'
            : shPool
            ? fmtNum(shPhysFreeGb) + ' GB of the ' + fmtNum(shTotal) + ' GB budget is free on the card'
              + (shReservedGb > 0 ? ' (' + fmtNum(shReservedGb) + ' GB is held by tenants)' : '')
              + ', and ' + shPct + '% is available to lease. A tenant reserves its share of the'
              + ' card when it connects and the worker holds exactly that, so the two figures'
              + ' differ only by what the host is doing with the card outside Enclave.'
            : '';
          const s = serverSpec();   // adopted fleet hardware; display fallback for rows that omit their own
          const vramGb = a.cardVramGb || s.cardVramGb, tflops = a.cardTflops || s.cardTflops;
          const ramGb = a.nodeRamGb || s.nodeRamGb, vcpus = a.nodeVcpus || s.nodeVcpus;
          const price = enclavePriceOf(e);   // this box's posted ask; the fleet price where it posts none
          // The app-hosting slots this box declares, which on a node that caps them is
          // a second admission gate beside the share meter: a buyer can read 60% of the
          // node as available and still not land, because every slot is taken.
          const slots = hosting.capacity > 0
            ? String(hosting.running) + ' of ' + hosting.capacity + ' app slots in use' : '';
          // A box that has DECLARED it sells a subset (fullService:false). Worth a line
          // because the missing options are refused at claim rather than ignored, so a
          // deployment that needs one sits in the queue instead of running here. The
          // named ones come from the row's own explicit falses only: an absent
          // capability field means an older build never said, and reading absence as
          // "not offered" would invent a limitation the box never claimed.
          const lacks = [["waf", "WAF"], ["secrets", "deployment secrets"],
                         ["customDomains", "custom domains"], ["shareResize", "live resizes"]]
            .filter(([k]) => a[k] === false).map(([, label]) => label);
          const subset = sellsFullService(e) ? '' :
            '<span class="fleet-relay-note">sells a subset of the platform'
            + (lacks.length ? ': no ' + lacks.map(esc).join(', no ') : '')
            + '. An option it cannot honour is refused rather than ignored, so a deployment'
            + ' that needs one waits for another box.</span>';
          return '<div class="fleet-row" title="' + esc(e.endpoint || "") + '">'
            + '<span class="fleet-head">'
            + '<span class="fleet-name">' + esc(name) + '</span>'
            + this._ratingHtml(e)
            + '</span>'
            + honest
            + (sh ? pool(cardBadge, shPct,
                stat(fmtNum(shLeasableGb), fmtNum(shTotal), "GB", "vram available", shVramTitle)
                // The card's RATED figure, which is what every other row quotes and
                // what a share is sized against. This cell used to show the MEASURED
                // masked rate instead -- honest in isolation, and unreadable in a
                // list: an RTX 3070 drew "0 / 2 tflops" beside an H200's "175 / 989",
                // so the columns implied a 500x gap where the real one is ~23x, and
                // the number did not match the basis the same row's share was
                // computed from.
                //
                // The measured rate has not been dropped, it has moved to the
                // tooltip, which is the only place the two can sit together without
                // being read as one scale. Rows too old to report a rated figure
                // keep the previous behaviour.
                + ((sh.cardTflops || a.cardTflops) > 0
                    ? stat(fmtNum(shFree * (sh.cardTflops || a.cardTflops)), fmtNum(sh.cardTflops || a.cardTflops), "", "tflops available",
                           (sh.pooled ? "Combined rated dense fp16 across the GPU pool. Model layers are distributed across cards; a single request is not guaranteed this aggregate throughput. " : "Rated dense fp16 for this card. ")
                           + "The same basis every other box "
                           + "quotes, so boxes and shares compare like for like."
                           + (sh.gmacPerSec > 0
                               ? " The masked path itself sustains " + Math.round(sh.gmacPerSec)
                                 + " G-MAC/s here, about " + fmtNum(sh.gmacPerSec * 2 / 1000)
                                 + " TFLOPS at 2 FLOP per MAC -- that is what this tier delivers, "
                                 + "and it is measured rather than rated."
                               : ""))
                    : sh.gmacPerSec > 0
                      ? stat(Math.round(shFree * sh.gmacPerSec * 2 / 1000),
                             Math.round(sh.gmacPerSec * 2 / 1000), "", "tflops available",
                             "Measured on this box: " + Math.round(sh.gmacPerSec)
                             + " G-MAC/s sustained by the masked field GEMM that actually runs "
                             + "here, converted at 2 FLOP per MAC. This box reports no rated "
                             + "figure, so the two columns are not directly comparable.")
                      : stat(esc(sh.card || "gpu"), "", "", "card")),
                price.shielded) : "")
            + (!sh?.pooled && Array.isArray(a.shieldedCards) ? a.shieldedCards.filter(c => c.id !== sh?.id).map(c => {
                const p = shieldedPoolOf({ availability: { shielded: c, gpuShareFree: c.gpuShareFree } });
                if (!p) return "";
                const badge = '<span class="ap-badge info" title="Shielded inference on the host GPU; masked inputs and verified results.">'
                  + esc(c.card || "gpu") + '</span>';
                return pool(badge, Math.floor(p.frac * 100),
                  stat(fmtNum(p.leasableGb), fmtNum(p.total), "GB", "vram available",
                    fmtNum(p.freeGb) + " GB free on the card; " + fmtNum(p.reservedGb) + " GB reserved by tenants.")
                  + stat(fmtNum(p.frac * c.cardTflops), fmtNum(c.cardTflops), "", "tflops available",
                    "Rated dense fp16. Masked field GEMM measured at " + Math.round(c.gmacPerSec) + " G-MAC/s."),
                  price.shielded);
              }).join("") : "")
            // ONLY when the card is in the enclave. A shielded card already drew its
            // pool above, from the numbers the probe actually measured; drawing
            // this one too would advertise one piece of silicon twice.
            + (inTee ? pool(cardBadge, gPct,
                stat(fmtNum(a.vramFreeGb != null ? a.vramFreeGb : gFree * vramGb), fmtNum(vramGb), "GB", "vram available")
                + stat(Math.round(gFree * tflops), Math.round(tflops), "", "tflops available"), price.full) : "")
            + pool(teeCpuBadge, cPct,
                // prefer the enclave's own figure (the RAM-reservation ledger,
                // which is what actually gates admission) over the folded
                // fraction — same precedence the VRAM cell above uses
                stat(fmtNum(a.ramGbFree != null ? a.ramGbFree : cFree * ramGb), fmtNum(ramGb), "GB", "ram available")
                + stat(fmtNum(cFree * vcpus), fmtNum(vcpus), "", "vcpu available"),
                // A "held by models" cell used to sit here, reading
                // ramNnResidentMb against the node's RAM. It was written for a box
                // whose preloaded weights make the meter read ~85% used while every
                // tenant is idle -- worth naming, at that size. In practice the only
                // boxes reporting the field hold a fraction of a percent (metal0:
                // 0.6 of 64 GB), so it explained nothing and spent a third row of the
                // CPU pool saying so. The field still crosses the wire, so bring the
                // cell back if a box ever carries enough resident weight to need it.
                price.node)
            // Under the pools, in the row's quiet ink: what the enclave itself is
            // holding (the attested part), how many app slots are left, and whether
            // this box takes work from anyone. Capacity is what a buyer reads first;
            // these are what they read next.
            + (encRuns.length || slots || hosting.ownerOnly
                ? '<span class="fleet-relay-note">'
                  + [...encRuns, ...(slots ? [slots] : []),
                     ...(hosting.ownerOnly ? ['takes app work only from its own owner'] : [])].join(" · ")
                  + '</span>' : '')
            + subset
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
