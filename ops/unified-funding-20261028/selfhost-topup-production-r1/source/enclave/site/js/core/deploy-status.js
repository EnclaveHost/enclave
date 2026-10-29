/* ============================================================
   Deployment status buckets for the dashboard's filter bar: coarse
   groups beat ten raw statuses. Unknown or new statuses land in "ended"
   rather than vanishing.
   ============================================================ */
export const BUCKETS = ["running", "queued", "ended", "failed"];

export function bucketOf(st) {
  st = String(st || "").toLowerCase();
  if (st === "running") return "running";
  // the "queued" bucket matches the ledger's own vocabulary: everything on
  // its way (queued/claimed/provisioning/awaiting_payment/...) but not over -
  // unfunded (drained; resumes on top-up) waits here too, it just isn't "queued".
  // "unknown" = an account row the relay's ledger cache hasn't caught up to
  // yet (fresh deploy) - it's on its way, not over
  if (["provisioning", "queued", "pending", "claiming", "claimed", "starting", "created", "awaiting_payment", "unfunded", "unknown"].indexOf(st) !== -1) return "queued";
  if (["failed", "error"].indexOf(st) !== -1) return "failed";
  return "ended";   // stopped, stopping, terminated, expired, ...
}

/* { all, running, queued, ended, failed } for a list of deployment rows */
export function countBuckets(list) {
  const counts = { all: 0, running: 0, queued: 0, ended: 0, failed: 0 };
  for (const d of list || []) { counts.all++; counts[bucketOf(d && d.status)]++; }
  return counts;
}
