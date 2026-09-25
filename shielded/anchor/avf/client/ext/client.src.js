// client.src.js -- the extension's request page (client/DESIGN.md; LAB): the policy fetched from its carrier, verified under
// the installed anchor and COMMITTED to the durable state (src/store-ext.js, under the browser-wide lock) before anything
// else; then the VM verified under the policy, the request sealed to the attested app key, the answer streamed.
// ?path=P&cancel=K&label=L (lab). With a configured resultUrl the outcome, and the commit as it happens, are also posted
// there (lab automation); the lab carrier also sees the page's label (?for=L) so a test can hand different tabs different
// policies.
// Deployments (client/DESIGN.md "Deployments"; since 0.4.0), the CLI's rules exactly:
//   ?deployments=1          verify and commit the policy, then list its signed table (links to select from)
//   ?deployment=ID[&app=A]  the app is the table's entry for ID (refused at "select" if the table does not name it, names
//                           another app than A, or there is no table); the install-time app is used only when neither
//                           ?deployment nor ?app is given. A repeated ?deployment or ?app is refused before anything runs.
import { connect, acceptPolicy } from "../src/client.js";
import { carrierFor } from "../src/carrier.js";
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
  const twice = ["deployment", "app"].filter((k) => q.getAll(k).length > 1);
  if (twice.length) result = { label, step: "select", refused: `${twice.join(" and ")} given more than once: ambiguous, nothing fetched or sent`, sent: false };
  else {
    let policyEnv;
    try { policyEnv = await (await fetch(`${config.policyUrl}${config.policyUrl.includes("?") ? "&" : "?"}for=${encodeURIComponent(label)}`, { cache: "no-store", credentials: "omit" })).json(); } catch { policyEnv = null; }
    if (q.get("deployments") === "1") {   // the selection list: from the verified, committed policy -- never from a catalog
      const pol = await acceptPolicy(store, policyEnv);
      result = pol.ok ? { label, step: "list", deployments: pol.policy.deployments || [], policySerial: pol.serial, gen: pol.gen, sent: false }
                      : { label, step: pol.commitFailed ? "commit" : "policy", refused: pol.reason, deployments: null, sent: false };
      if (pol.ok) for (const d of result.deployments) {
        const a = document.createElement("a"); a.href = `client.html?deployment=${d.id}`; a.textContent = `${d.id}  (app ${d.app.slice(0, 16)}...)`;
        $("list").append(a, document.createElement("br"));
      }
    } else {
      const deployment = q.get("deployment"), app = q.get("app") || (deployment === null ? config.appId : null);
      // a platform relay base routes by deployment (<base>/x/<id>/pvm); the id is a route, the app still the signed table's
      const carrier = carrierFor({ relay: config.relayUrl || null, relayBase: config.relayBase || null, deployment });
      if (!carrier.ok) throw new Error(carrier.reason);
      const r = await connect({ relay: carrier.url, policyEnv, store, appId: app, deployment, path: q.get("path") || "/", stream: q.get("whole") !== "1",
                                cancelAfter: Number(q.get("cancel") || 0), label, onCommitted: (c) => post({ event: "policy-committed", ...c }),
                                onLine: (l) => { $("out").textContent += l + "\n"; } });
      result = r.result;
    }
  }
} catch (e) { result = { label, step: "client", refused: e.message, sent: false }; }
if (config && config.resultUrl) await fetch(config.resultUrl, { method: "POST", body: JSON.stringify({ ...result, userAgent: navigator.userAgent, extension: chrome.runtime.id }), credentials: "omit" }).catch(() => {});
const good = result.complete === true || (result.mode !== "stream" && result.status === 200) || result.step === "list";
$("verdict").textContent = result.step === "list" ? `policy serial ${result.policySerial}: ${result.deployments.length} deployment(s), choose one` : good ? "verified under the policy, sealed, answered" : `refused at ${result.step}: ${result.refused}`;
$("verdict").className = good ? "ok" : "bad";
$("out").textContent += JSON.stringify({ ...result, lines: undefined }, null, 1);
