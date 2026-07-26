/* ============================================================
   Host page - the seller's pitch, with the live fleet on it.

   The fleet view (/enclaves on the relay) is PUBLIC data, so a
   prospective host sees the boxes they would be joining without
   connecting a wallet. The dashboard carries the same panel but
   bounces signed-out visitors, which is exactly the audience for
   this page - hence its own copy here rather than a link there.
   ============================================================ */
import { Enclave } from "../core/api.js";
import "../../components/fleet-list/fleet-list.js";

let _poll = null;

async function refreshFleet(){
  const fl = document.querySelector(".host-fleet c-fleet-list"); if (!fl) return;
  try {
    const r = await fetch(Enclave.base.replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("no fleet view");
    const j = await r.json();
    // GPU boxes first, then by endpoint, same order the dashboard uses
    fl.rows = (j.enclaves || []).slice().sort((a, b) =>
      ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
      || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));
  } catch(e){ fl.rows = []; }   // the component's empty state reads "no live enclaves"
}

export function boot(){
  refreshFleet();
  const fl = document.querySelector(".host-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", refreshFleet);
  // poll only while this page is mounted (the router leaves the interval
  // running otherwise, and a marketing page should not keep hitting the relay)
  if (!_poll) _poll = setInterval(() => {
    if (!document.querySelector('section[data-view="host"]')) return;
    refreshFleet();
  }, 30000);
}
