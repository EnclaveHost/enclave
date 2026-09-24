// client.src.js -- the extension's request page (client/DESIGN.md; LAB): the policy fetched from its carrier, verified under
// the installed anchor and COMMITTED to the durable state (src/store-ext.js, under the browser-wide lock) before anything
// else; then the VM verified under the policy, the request sealed to the attested app key, the answer streamed.
// ?path=P&cancel=K&label=L (lab). With a configured resultUrl the outcome, and the commit as it happens, are also posted
// there (lab automation); the lab carrier also sees the page's label (?for=L) so a test can hand different tabs different
// policies.
import { connect } from "../src/client.js";
import { ExtStore } from "../src/store-ext.js";
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const label = q.get("label") || "extension";
let result, config;
try {
  ({ config } = await chrome.storage.local.get(["config"]));
  if (!config) throw new Error("no anchor installed: open the options page");
  const store = new ExtStore();
  if (!(await store.latest())) throw new Error("no anchor installed: open the options page");
  const post = (o) => config.resultUrl ? fetch(config.resultUrl, { method: "POST", body: JSON.stringify({ label, extension: chrome.runtime.id, ...o }), credentials: "omit" }).catch(() => {}) : null;
  let policyEnv;
  try { policyEnv = await (await fetch(`${config.policyUrl}${config.policyUrl.includes("?") ? "&" : "?"}for=${encodeURIComponent(label)}`, { cache: "no-store", credentials: "omit" })).json(); } catch { policyEnv = null; }
  const r = await connect({ relay: config.relayUrl, policyEnv, store, appId: config.appId, path: q.get("path") || "/", stream: q.get("whole") !== "1",
                            cancelAfter: Number(q.get("cancel") || 0), label, onCommitted: (c) => post({ event: "policy-committed", ...c }),
                            onLine: (l) => { $("out").textContent += l + "\n"; } });
  result = r.result;
} catch (e) { result = { label, step: "client", refused: e.message, sent: false }; }
if (config && config.resultUrl) await fetch(config.resultUrl, { method: "POST", body: JSON.stringify({ ...result, userAgent: navigator.userAgent, extension: chrome.runtime.id }), credentials: "omit" }).catch(() => {});
const good = result.complete === true || (result.mode !== "stream" && result.status === 200);
$("verdict").textContent = good ? "verified under the policy, sealed, answered" : `refused at ${result.step}: ${result.refused}`;
$("verdict").className = good ? "ok" : "bad";
$("out").textContent += JSON.stringify({ ...result, lines: undefined }, null, 1);
