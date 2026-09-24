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

let _poll = null;

async function refreshFleet(){
  const fl = document.querySelector(".arch-fleet c-fleet-list"); if (!fl) return;
  try {
    const r = await fetch(Enclave.base.replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("no fleet view");
    const j = await r.json();
    fl.rows = (j.enclaves || []).slice().sort((a, b) =>
      ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
      || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));
  } catch(e){ fl.rows = []; }   // the component's empty state reads "no live enclaves"
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
