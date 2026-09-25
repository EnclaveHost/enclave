// lab.js -- the lab page's driver (lab.html; LAB, not production): one request per load, its outcome posted to the site.
//   ?relay=URL&label=L&path=P [&mode=stream [&cancel=K] [&trace=1]] [&app=HEX] [&runtime=HEX]
import { fetchVerified, fetchVerifiedStream } from "./pvm-client.js";
const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
let result;
try {
  const pins = await (await fetch("./pins.json", { cache: "no-store" })).json();   // the SITE's pins, never the relay's
  if (q.get("app")) pins.app = q.get("app");                                       // lab scenarios: a page expecting another app
  if (q.get("runtime")) pins.runtimeId = q.get("runtime");                         // ... or pinning another runtime
  const args = { relay: q.get("relay"), pins, path: q.get("path") || "/", label: q.get("label") || "ok" };
  if (q.get("mode") === "stream") {
    $("verdict").textContent = "streaming…";
    result = await fetchVerifiedStream({ ...args, cancelAfter: Number(q.get("cancel") || 0), trace: q.get("trace") === "1",
                                         onLine: (l) => { $("out").textContent += l + "\n"; } });
  } else result = await fetchVerified(args);
} catch (e) { result = { label: q.get("label") || "ok", step: "page", refused: String(e && e.message || e), sent: false }; }
result.userAgent = navigator.userAgent;
const good = result.mode === "stream" ? result.complete === true : result.status === 200;
$("verdict").textContent = good ? (result.mode === "stream" ? "verified, sealed, streamed, complete" : "verified, sealed, answered")
  : result.mode === "stream" && result.step === "sealed" && result.tokens ? `INCOMPLETE after ${result.tokens} tokens: ${result.refused}` : `refused at ${result.step}: ${result.refused}`;
$("verdict").className = good ? "ok" : "bad";
$("out").textContent += JSON.stringify({ ...result, lines: undefined }, null, 1);
try { await fetch("./result", { method: "POST", body: JSON.stringify(result), headers: { "content-type": "application/json" } }); } catch {}
document.title = "pVM Browser Channel Lab: done";
