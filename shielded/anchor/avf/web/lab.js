// lab.js -- the lab page's driver (lab.html; LAB, not production): one request per load, its outcome posted to the site.
import { fetchVerified } from "./pvm-client.js";
const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
let result;
try {
  const pins = await (await fetch("./pins.json", { cache: "no-store" })).json();   // the SITE's pins, never the relay's
  if (q.get("app")) pins.app = q.get("app");                                       // lab scenarios: a page expecting another app
  if (q.get("runtime")) pins.runtimeId = q.get("runtime");                         // ... or pinning another runtime
  result = await fetchVerified({ relay: q.get("relay"), pins, path: q.get("path") || "/", label: q.get("label") || "ok" });
} catch (e) { result = { label: q.get("label") || "ok", step: "page", refused: String(e && e.message || e), sent: false }; }
result.userAgent = navigator.userAgent;
$("verdict").textContent = result.status === 200 ? "verified, sealed, answered" : `refused at ${result.step}: ${result.refused}`;
$("verdict").className = result.status === 200 ? "ok" : "bad";
$("out").textContent = JSON.stringify(result, null, 1);
try { await fetch("./result", { method: "POST", body: JSON.stringify(result), headers: { "content-type": "application/json" } }); } catch {}
document.title = "pVM Browser Channel Lab: done";
