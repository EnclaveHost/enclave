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

export function createFleetReader(fetchImpl) {
  const good = new LastGood();
  return async function refreshInto(fl, base) {
    if (!fl) return;
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
