const LIMIT = 2 ** 24;
export const MAX_ACK_RANGES = 64;
export function ackProgress(rec) {
  const ack_floor = rec?.ack_floor ?? 0, acked = rec?.acked ?? [];
  if (!Number.isSafeInteger(ack_floor) || ack_floor < 0 || ack_floor > LIMIT || !Array.isArray(acked) || acked.length > MAX_ACK_RANGES)
    throw new Error("invalid persisted pad acknowledgments");
  let end = ack_floor;
  for (const range of acked) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] <= end || range[1] <= range[0] || range[1] > LIMIT)
      throw new Error("invalid persisted pad acknowledgment range");
    end = range[1];
  }
  return { ack_floor, acked: acked.map(r => [...r]), finalized: !!(rec?.finalReceiptOnly && rec?.usage?.runs > 0) };
}
export function ackCovers(progress, lo, hi) {
  return hi <= progress.ack_floor || progress.acked.some(([a,b]) => a <= lo && hi <= b);
}
export function mergeAck(progress, lo, hi) {
  let floor = progress.ack_floor;
  const merged = [];
  for (const [a,b] of [...progress.acked, [lo,hi]].sort((a,b) => a[0]-b[0])) {
    if (a <= floor) { floor = Math.max(floor,b); continue; }
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1],b);
    else merged.push([a,b]);
  }
  return merged.length > MAX_ACK_RANGES ? null : { ack_floor: floor, acked: merged };
}
