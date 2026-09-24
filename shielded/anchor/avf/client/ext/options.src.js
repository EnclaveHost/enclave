// options.src.js -- the extension's install anchor (client/DESIGN.md; LAB). The anchor is set ONCE: an installed anchor is
// never replaced from this page (a new anchor means reinstalling the extension). This page is not web-accessible: no site
// can open or script it. For lab automation it also accepts its fields as query parameters, applied on first install only.
import { initialState } from "../src/trust.js";
const $ = (id) => document.getElementById(id);
const fields = ["policyKeyFp", "serialFloor", "releaseKeyFp", "policyUrl", "relayUrl", "appId"];
async function install(v) {
  const have = await chrome.storage.local.get(["state"]);
  if (have.state) { $("out").textContent = "An anchor is already installed; reinstall the extension to change it."; return false; }
  const state = initialState({ policyKeyFp: v.policyKeyFp, serialFloor: Number(v.serialFloor), releaseKeyFp: v.releaseKeyFp });
  await chrome.storage.local.set({ state, config: { policyUrl: v.policyUrl, relayUrl: v.relayUrl, appId: v.appId, resultUrl: v.resultUrl || null } });
  $("out").textContent = `Installed: ${JSON.stringify(state)}`;
  if (v.resultUrl) await fetch(v.resultUrl, { method: "POST", body: JSON.stringify({ installed: true, anchor: { policyKeyFp: state.policyFp, serialFloor: state.serial, releaseKeyFp: state.releaseFp } }), credentials: "omit" }).catch(() => {});
  return true;
}
const q = new URLSearchParams(location.search);
if (q.get("install") === "1") install(Object.fromEntries([...fields, "resultUrl"].map((k) => [k, q.get(k)]))).catch((e) => { $("out").textContent = e.message; });
$("f").addEventListener("submit", (ev) => { ev.preventDefault(); install(Object.fromEntries(fields.map((k) => [k, $(k).value.trim()]))).catch((e) => { $("out").textContent = e.message; }); });
