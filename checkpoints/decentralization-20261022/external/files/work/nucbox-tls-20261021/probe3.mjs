// READ-ONLY, bounded probe 3 (public GETs only; 20 s each): the relay's health, the nucbox fleet row (/enclaves), the box's
// own public surfaces through its tunnel (/t/nucbox-k11-4/availability, /health: the relay allows these for hv-node rows),
// and the route map sampled 3 times 45 s apart for the nucbox labels and pending reasons (is it recovering?).
import fs from "node:fs";
const out = { at: new Date().toISOString(), samples: [] };
const get = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "enclave-tls-diagnosis/3" } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: j ? null : t.slice(0, 600) }; } catch (e) { return { error: `${e.name}: ${e.message}` }; } };
const NUC = ["59f1273d", "d9798e4c", "7ae476a3", "e64f7cba", "a77d0c57", "a69dcbba", "38f368d6", "ef514ed3"];
const h = await get("https://api.enclave.host/health"); out.relayHealth = h.json ? Object.fromEntries(Object.entries(h.json).filter(([k, v]) => typeof v !== "object" || v === null).slice(0, 40)) : h;
const en = await get("https://api.enclave.host/enclaves");
if (en.json) {
  out.fleet = { updatedAt: en.json.updatedAt, rows: en.json.enclaves.length };
  const pick = (e) => ({ name: e.name, id: e.id?.slice(0, 10), mode: e.mode, tunnel: !!e.tunnel, serving: e.serving, eligible: e.eligible, ineligible: e.ineligible ?? null,
    ownerOnly: e.ownerOnly, tier: e.tier ?? null, appEvidenceRequired: e.appEvidenceRequired ?? null, lastSeen: e.lastSeen, liveness: e.liveness ?? null,
    attachedAt: e.attachedAt ?? e.since ?? null, claimEnabled: e.availability?.claimEnabled ?? null, servesDeployments: e.servesDeployments ?? null });
  out.fleet.nucbox = en.json.enclaves.filter((e) => /nucbox|2fcef48d/i.test(`${e.name} ${e.id}`)).map(pick);
  out.fleet.others = en.json.enclaves.filter((e) => !/nucbox|2fcef48d/i.test(`${e.name} ${e.id}`)).map((e) => ({ name: e.name, mode: e.mode, serving: e.serving, eligible: e.eligible }));
} else out.fleet = en;
for (const p of ["/availability", "/health"]) {
  const r = await get("https://api.enclave.host/t/nucbox-k11-4" + p);
  out["box" + p] = r.json ? Object.fromEntries(Object.entries(r.json).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v).slice(0, 300) : v]).slice(0, 40)) : r;
}
for (let i = 0; i < 3; i++) {
  if (i) await new Promise((r) => setTimeout(r, 45_000));
  const rm = await get("https://api.enclave.host/v1/network/routes"), now = Date.now();
  out.samples.push(rm.json ? { at: new Date().toISOString(), labels: Object.keys(rm.json.labels || {}),
    nucboxRouted: NUC.filter((l) => rm.json.labels?.[l]).map((l) => `${l}:${Math.round((rm.json.labels[l].expiresAt - now) / 1000)}s`),
    pending: (rm.json.pending || []).map((p) => `${p.id.slice(2, 10)}:${p.reason}`) } : rm);
}
fs.writeFileSync(new URL("./probe3.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
