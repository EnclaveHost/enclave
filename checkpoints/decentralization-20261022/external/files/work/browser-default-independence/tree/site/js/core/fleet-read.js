/* ============================================================
   The relay's public /enclaves table, read into a <c-fleet-list>.
   Shared by the dashboard, host and architecture pages, which each
   used to set `rows = []` on ANY failure, so the component's empty
   state claimed "No app hosts available right now" whenever the API
   was unreachable. A failure now shows the last good table marked
   stale (it is public data, the same for every viewer) or, with none
   yet, an error state. See list-state.js.
   ============================================================ */
import { LastGood, failureReason } from "./list-state.js";

// GPU boxes first, then by endpoint (the order every fleet panel uses)
export const sortFleet = (rows) => rows.slice().sort((a, b) =>
  ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
  || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));

/* Independent mode: no relay table. The hosts are the pinned registry's rows at a block the profile's RPCs agree on, and
   each row's `availability` is that host's OWN signed capacity record (js/core/host-capacity.js: signature by its current
   registry operator, at most 15 minutes old), the same document the relay table carried, verified here instead of
   trusted. A host without a valid record is listed with no availability ("no capacity report"), never as full. */
let _indRows = null, _indAt = 0;
export async function independentFleetRows({ maxAgeMs = 60000 } = {}){
  if (_indRows && Date.now() - _indAt < maxAgeMs) return _indRows;
  _indRows = await readIndependentFleet(); _indAt = Date.now();
  return _indRows;
}
async function readIndependentFleet(){
  const IC = await import("./independent-chain.js");
  const { snap, hosts } = await IC.registryHosts();
  const live = new Set(IC.liveHosts(hosts, snap.timestamp));
  let cap = null;
  try { cap = await IC.hostCapacityTexts(hosts); } catch (e){ cap = null; }
  // every registry row goes to the component, which owns visibility (fleet-list appHostVisible: serving === true);
  // an inactive row is simply not serving
  return hosts.map((h) => {
    const hostId = IC.hostIdOfEndpoint(h.endpoint), c = cap ? cap.byHost.get(hostId) : null;
    const availability = c && c.availability ? c.availability : null;
    return { name: h.endpoint, endpoint: h.endpoint, hostId, operator: h.operator, payoutWallet: h.payoutWallet || null,
      cpuPricePerSec6: Number(h.cpuPricePerSec6), gpuPricePerSec6: Number(h.gpuPricePerSec6 || 0), lastSeen: Number(h.lastSeen),
      active: h.active === true, serving: h.active === true && live.has(h) && !!(availability && availability.claimEnabled !== false), availability, selfReported: true,
      capacityText: cap ? cap.line(c) : "capacity reports could not be read", independent: true, block: snap.number };
  });
}

export function createFleetReader(fetchImpl, independentImpl) {
  const good = new LastGood();
  return async function refreshInto(fl, base) {
    if (!fl) return;
    const { INDEPENDENT } = await import("./config.js");
    if (INDEPENDENT.state !== "off"){
      try {
        if (INDEPENDENT.state !== "on") throw Object.assign(new Error("the network profile is not active in this tab"), { status: 0 });
        const v = good.ok("fleet", sortFleet(await (independentImpl || independentFleetRows)()));
        fl.error = null; fl.staleAt = 0; fl.rows = v.rows;
      } catch (e) {
        const v = good.failed("fleet", e);
        fl.error = failureReason(e); fl.staleAt = v.kind === "stale" ? v.at : 0; fl.rows = v.kind === "stale" ? v.rows : [];
      }
      return;
    }
    try {
      let r;
      try { r = await (fetchImpl || fetch)(String(base).replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } }); }
      catch (e) { throw Object.assign(new Error("no answer"), { status: 0 }); }
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
      const j = await r.json();
      const v = good.ok("fleet", sortFleet((j && j.enclaves) || []));
      fl.error = null; fl.staleAt = 0; fl.rows = v.rows;
    } catch (e) {
      const v = good.failed("fleet", e);
      fl.error = failureReason(e);
      fl.staleAt = v.kind === "stale" ? v.at : 0;
      fl.rows = v.kind === "stale" ? v.rows : [];
    }
  };
}

// one reader per page load: the table is public, so every page may reuse it
export const refreshFleetInto = createFleetReader();
