// READ-ONLY, public: the relay's lease-free /v1/secrets/exists lookup (what the node's hasSecrets asks; host.mjs #secretsState)
// sampled 6x, 10 s apart, for 59f1273d and 7ae476a3, with status/time. A lookup only: no secret is read or written.
import fs from "node:fs";
const IDS = { "59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "7ae476a3": "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33" };
const out = [];
for (let i = 0; i < 6; i++) {
  if (i) await new Promise((r) => setTimeout(r, 10_000));
  for (const [k, id] of Object.entries(IDS)) {
    const t0 = Date.now();
    try { const r = await fetch("https://api.enclave.host/v1/secrets/exists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(15000) });
      out.push({ at: new Date().toISOString().slice(11, 19), k, status: r.status, body: (await r.text()).slice(0, 160), s: (Date.now() - t0) / 1000 }); }
    catch (e) { out.push({ at: new Date().toISOString().slice(11, 19), k, error: `${e.name}: ${e.message}`.slice(0, 160), s: (Date.now() - t0) / 1000 }); }
  }
}
fs.writeFileSync(new URL("./exists-probe.json", import.meta.url), JSON.stringify(out, null, 1));
for (const o of out) console.log(o.at, o.k, o.status ?? "-", o.error ?? o.body, o.s + "s");
