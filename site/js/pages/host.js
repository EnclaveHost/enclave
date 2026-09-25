/* ============================================================
   Host page - the seller's pitch, with the live fleet on it.

   The fleet view (/enclaves on the relay) is PUBLIC data, so a
   prospective host sees the boxes they would be joining without
   connecting a wallet. The dashboard carries the same panel but
   bounces signed-out visitors, which is exactly the audience for
   this page - hence its own copy here rather than a link there.
   ============================================================ */
import { Enclave } from "../core/api.js";
import { refreshFleetInto } from "../core/fleet-read.js";
import "../../components/fleet-list/fleet-list.js";

let _poll = null;

async function refreshFleet(){
  // a failed read shows the last good table marked stale, or an error state -
  // never the component's "no app hosts" empty state (js/core/fleet-read.js)
  await refreshFleetInto(document.querySelector(".host-fleet c-fleet-list"), Enclave.base);
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
