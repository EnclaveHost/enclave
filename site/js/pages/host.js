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
import "../../components/code/code.js";

let _poll = null;

async function refreshFleet(){
  // a failed read shows the last good table marked stale, or an error state -
  // never the component's "no app hosts" empty state (js/core/fleet-read.js)
  await refreshFleetInto(document.querySelector(".host-fleet c-fleet-list"), Enclave.base);
}

// The hero's primary download is the visitor's own platform: on an Android phone the Android app (its notes say what it
// needs and offer Windows instead); everywhere else Windows, with the Android app on a line under the buttons.
function downloadForThisDevice(){
  if (!/Android/i.test(navigator.userAgent || "")) return;
  const btn = document.querySelector('.host-hero-cta [data-download="windows"]');
  if (btn) {
    btn.href = "https://get.enclave.host/android/Enclave.apk";
    btn.dataset.download = "android";
    btn.firstChild.textContent = "Download for Android ";
  }
  document.querySelectorAll(".host-hero-note[data-platform]").forEach((p) => { p.hidden = p.dataset.platform !== "android"; });
}

export function boot(){
  downloadForThisDevice();
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
