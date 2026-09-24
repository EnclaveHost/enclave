// Driven by TestTheJSClientInteroperates: the JS client against the Go server, same key. Prints one JSON object.
//   node interop.mjs <authenticated url> <key hex> <bundle path> <unauthenticated url>
import { GuestdControl, parseKey } from "../control-client.mjs";
import crypto from "node:crypto";
const [url, keyHex, bundle, labUrl] = process.argv.slice(2);
const out = {};
const step = async (name, f) => { try { out[name] = await f(); } catch (e) { out[name] = "THREW: " + e.message; } };
const c = new GuestdControl(url, parseKey(keyHex));
await step("connect", async () => { await c.connect(); return "ok"; });
await step("health", async () => (await c.request("GET", "/health")).status);
await step("launch", async () => { const r = await c.request("POST", "/vms", { image: "file://" + bundle, name: "0xjs" }); return r.status + " " + r.body.status; });
await step("lease", async () => { const r = await c.request("POST", "/vms/lease", { ids: ["0xjs"] }); return r.status + " " + JSON.stringify(r.body.extended); });
await step("replay", async () => {
  const { headers } = c.sign("GET", "/vms", "");
  const a = await fetch(url + "/vms", { headers }); const b = await fetch(url + "/vms", { headers });
  return a.status + " then " + b.status;
});
await step("tampered", async () => {
  const good = JSON.stringify({ ids: ["0xjs"] });
  const { headers } = c.sign("POST", "/vms/lease", good);
  const r = await fetch(url + "/vms/lease", { method: "POST", headers, body: JSON.stringify({ ids: [] }) });
  return r.status;
});
await step("reauth", async () => {
  // a session guestd does not know (sessions are frozen, so substitute a copy with another id): it asks for reauth
  c.session = Object.freeze({ ...c.session, id: crypto.randomBytes(16).toString("hex") });
  const before = c.instance;
  const r = await c.request("GET", "/vms");
  return r.status + (c.session && c.instance === before ? " reconnected" : " ?");
});
await step("otherKey", async () => { await new GuestdControl(url, crypto.randomBytes(32)).connect(); return "CONNECTED"; });
await step("labMode", async () => { await new GuestdControl(labUrl, parseKey(keyHex)).connect(); return "CONNECTED"; });
await step("zeroKey", async () => { parseKey("0".repeat(64)); return "ACCEPTED"; });
console.log(JSON.stringify(out));
