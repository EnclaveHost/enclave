// client.src.js -- the extension's request page (client/DESIGN.md; LAB): the policy fetched from its carrier and verified
// under the installed anchor, the VM verified under the policy, the request sealed to the attested app key, the answer
// streamed. ?path=P&cancel=K&label=L (lab); with a configured resultUrl the outcome is also posted there (automation).
import { connect } from "../src/client.js";
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
let result;
try {
  const { state, config } = await chrome.storage.local.get(["state", "config"]);
  if (!state || !config) throw new Error("no anchor installed: open the options page");
  let policyEnv;
  try { policyEnv = await (await fetch(config.policyUrl, { cache: "no-store", credentials: "omit" })).json(); } catch (e) { policyEnv = null; }
  const r = await connect({ relay: config.relayUrl, policyEnv, state, appId: config.appId, path: q.get("path") || "/", stream: q.get("whole") !== "1",
                            cancelAfter: Number(q.get("cancel") || 0), label: q.get("label") || "extension",
                            onLine: (l) => { $("out").textContent += l + "\n"; } });
  if (r.state !== state) await chrome.storage.local.set({ state: r.state });
  result = r.result;
  if (config.resultUrl) await fetch(config.resultUrl, { method: "POST", body: JSON.stringify({ ...result, userAgent: navigator.userAgent, extension: chrome.runtime.id }), credentials: "omit" }).catch(() => {});
} catch (e) { result = { step: "client", refused: e.message, sent: false }; }
const good = result.complete === true || (result.mode !== "stream" && result.status === 200);
$("verdict").textContent = good ? "verified under the policy, sealed, answered" : `refused at ${result.step}: ${result.refused}`;
$("verdict").className = good ? "ok" : "bad";
$("out").textContent += JSON.stringify({ ...result, lines: undefined }, null, 1);
