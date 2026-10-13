// Route eligibility that survives a host's tunnel BLIP (api-relay.js, the Enclave-network route map's `eligible`).
// A host whose tunnel detaches and re-attaches within seconds (a NAT rebinding, its uplink) has not stopped: its apps'
// routes run through the Enclave network's circuits, not that tunnel. Dropping their labels at the detach published
// NXDOMAIN that public resolvers then cached (2026-10-13 22:49:57Z: nucbox-k11-4 re-attached in 1 s; 8 names vanished
// ~35 s). So while the host's ROW IS MISSING, an app keeps its route for graceMs after it was last eligible, never past
// what it was eligible until; a host that is present but no longer eligible loses it at once.
//   rowOf(d) -> the host's live row or null; rowEligibility(row, d) -> false | true | expiry (ms)
export function withDetachGrace({ rowOf, rowEligibility, graceMs = 3 * 60_000, now = Date.now }) {
  const last = new Map();
  return (d) => {
    const id = String(d.id || "").toLowerCase(), row = rowOf(d);
    if (!row) {
      const l = last.get(id);
      if (!l) return false;
      const until = Math.min(l.until, l.at + graceMs);
      if (until <= now()) { last.delete(id); return false; }
      return until;
    }
    const v = rowEligibility(row, d);
    if (v && (typeof v !== "number" || v > now())) last.set(id, { at: now(), until: typeof v === "number" ? v : Infinity });
    else last.delete(id);
    return v;
  };
}
