/* ============================================================
   Architecture tab (Develop > Architecture) - the architecture
   Enclave is building and the isolation contract behind it.
   Static prose over the shared chrome; the one live wire is the
   fleet panel, which shows the evidence badges the copy
   describes on the boxes that are actually attached (the same
   public /enclaves read the Host page makes, polled only while
   the tab's section is mounted).
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/fleet-list/fleet-list.js";
import { Enclave } from "../core/api.js";
import { refreshFleetInto } from "../core/fleet-read.js";

let _poll = null;

async function refreshFleet(){
  // a failed read shows the last good table marked stale, or an error state -
  // never the component's "no app hosts" empty state (js/core/fleet-read.js)
  await refreshFleetInto(document.querySelector(".arch-fleet c-fleet-list"), Enclave.base);
}

export function boot(){
  refreshFleet();
  const fl = document.querySelector(".arch-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", refreshFleet);
  // Poll only while the Develop page's Architecture pane is mounted. The
  // pane may be hidden behind another Develop sub-tab, but it is removed when
  // soft navigation swaps to another page.
  if (!_poll) _poll = setInterval(() => {
    if (!document.getElementById("architecture")) return;
    refreshFleet();
  }, 30000);
}
