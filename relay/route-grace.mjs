// Route eligibility that survives a host's tunnel BLIP (api-relay.js, the Enclave-network route map's `eligible`).
// A host whose tunnel detaches and re-attaches within seconds (a NAT rebinding, its uplink) has not stopped: its apps'
// routes run through the Enclave network's circuits, not that tunnel. Dropping their labels at the detach published
// NXDOMAIN that public resolvers then cached (2026-10-13 22:49:57Z: nucbox-k11-4 re-attached in 1 s; 8 names vanished
// ~35 s). So while the host's ROW IS MISSING, an app keeps its route for graceMs after it was last eligible, never past
// what it was eligible until; a host that is present but no longer eligible loses it at once - unless its verifier has
// not yet judged the app since the host (re)attached (pending), which is a detach still ending, not a verdict.
// The grace state can be kept across a relay restart (store), so a relay deploy is a detach too: before this, every
// app was off DNS from the restart until its host re-attached and each app was verified again (~40-60 s, 10-14).
//   rowOf(d) -> the host's live row or null; rowEligibility(row, d) -> false | true | expiry (ms);
//   pending(row, d) -> true while no verdict exists for d since row attached; store: { load() -> entries, save(entries) };
//   fingerprint(d) -> the ledger facts a route was granted for (owner, app, runner...): the grace holds only for the same
//   ones, so a ledger change (a transfer, a new app) withdraws the route at once, detached or not.
export function withDetachGrace({ rowOf, rowEligibility, pending = () => false, fingerprint = () => "", graceMs = 3 * 60_000,
  now = Date.now, store = null, saveEveryMs = 10_000 }) {
  const last = new Map();
  for (const [id, l] of (store?.load() || [])) {
    if (/^0x[0-9a-f]{64}$/.test(id) && Number.isFinite(l?.at) && (l.until === null || Number.isFinite(l.until)) && typeof l.fp === "string")
      last.set(id, { at: l.at, until: l.until === null ? Infinity : l.until, fp: l.fp });
  }
  let dirty = false;
  const set = (id, v) => { last.set(id, v); dirty = true; }, drop = (id) => { if (last.delete(id)) dirty = true; };
  const save = () => {
    if (!store || !dirty) return;
    dirty = false;
    try { store.save([...last].map(([id, l]) => [id, { at: l.at, until: l.until === Infinity ? null : l.until, fp: l.fp }])); }
    catch { dirty = true; }
  };
  if (store) setInterval(save, saveEveryMs).unref?.();
  const grace = (id, d) => {
    const l = last.get(id);
    if (!l) return false;
    if (l.fp !== fingerprint(d)) { drop(id); return false; }
    const until = Math.min(l.until, l.at + graceMs);
    if (until <= now()) { drop(id); return false; }
    return until;
  };
  const eligible = (d) => {
    const id = String(d.id || "").toLowerCase(), row = rowOf(d);
    if (!row) return grace(id, d);
    const v = rowEligibility(row, d);
    if (v && (typeof v !== "number" || v > now())) { set(id, { at: now(), until: typeof v === "number" ? v : Infinity, fp: fingerprint(d) }); return v; }
    if (pending(row, d)) return grace(id, d);
    drop(id);
    return v;
  };
  eligible.save = () => { dirty = true; save(); };
  return eligible;
}
