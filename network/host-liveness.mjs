// Host liveness, kept apart from registry authority (docs/network/host-liveness.md). No imports: the relay ships a
// byte-identical copy (relay/host-liveness.mjs, pinned by test/host-liveness.test.mjs).
//
// ADMISSION (may this host be listed at all) is the registry and the reader's own platform filters: a registered row,
// ACTIVE, and wherever a reader has one, its operator allowlist. A reader applies those first; nothing here relaxes them.
//
// LIVENESS (is it up now) is bounded-fresh, authenticated evidence, one of:
//   signed-record    an operator-signed host capacity record (network/host-capacity.mjs) that the CALLER verified against
//                    THIS row (signer = the row's operator, its endpoint and hostId, the chain and registry, the row
//                    active) and that has not expired; a record lives at most 15 minutes, and a copy held by a directory
//                    or a cache dies with it, so an old record is never current evidence;
//   registry-update  an on-chain write by the row's operator key within the window (register, setPrices, setProofKey,
//                    setMeasurement, setCaps, or a legacy heartbeat): lastSeen moves only through the operator's own
//                    transaction. Hosts that predate signed records stay listed through it during the transition, and a
//                    host that just registered is listed before its first record is read. No host sends a PERIODIC
//                    write for it any more; a reader may set the window to 0 once every host it relies on serves records;
//   observed         the reader's own authenticated observation, passed in by that reader (the relay's attached tunnel).
// No evidence, expired evidence, or an inactive or unregistered row: not live, with the reason.

export const REGISTRY_UPDATE_WINDOW_SEC = 3600;
const ZERO = /^0x0{40}$/i;

/**
 * hostLiveness(row, opts) -> { live, evidence: "signed-record"|"observed"|"registry-update"|null, untilMs, reason }
 *   row: a registry row { operator, active, lastSeen } (null: not registered)
 *   nowMs: the reader's clock (signed records and observations); chainNowSec: the agreed block's time. lastSeen is judged
 *   against the LATER of the two, so a stale RPC snapshot cannot extend a registry write's window
 *   signedUntilMs: expiresAt of a capacity record the caller VERIFIED for this row, or null
 *   observedAtMs / observedWindowMs: the reader's own authenticated observation and how long it counts
 *   registryUpdateWindowSec: how long an operator registry write counts (0: never)
 */
export function hostLiveness(row, { nowMs = Date.now(), chainNowSec, signedUntilMs = null, observedAtMs = null, observedWindowMs = 0,
                                    registryUpdateWindowSec = REGISTRY_UPDATE_WINDOW_SEC } = {}) {
  const no = (reason) => ({ live: false, evidence: null, untilMs: null, reason });
  if (!row || !row.operator || ZERO.test(String(row.operator))) return no("not registered");
  if (row.active !== true) return no("inactive in the registry");
  if (Number.isFinite(signedUntilMs) && signedUntilMs > nowMs) return { live: true, evidence: "signed-record", untilMs: signedUntilMs, reason: null };
  if (Number.isFinite(observedAtMs) && observedWindowMs > 0 && observedAtMs <= nowMs && nowMs - observedAtMs <= observedWindowMs)
    return { live: true, evidence: "observed", untilMs: observedAtMs + observedWindowMs, reason: null };
  const t = Math.max(Number.isFinite(chainNowSec) ? chainNowSec : 0, Math.floor(nowMs / 1000)), seen = Number(row.lastSeen);
  if (registryUpdateWindowSec > 0 && Number.isFinite(seen) && seen > 0 && seen <= t + 60 && t - seen <= registryUpdateWindowSec)
    return { live: true, evidence: "registry-update", untilMs: (seen + registryUpdateWindowSec) * 1000, reason: null };
  return no(`no fresh authenticated liveness: no unexpired signed capacity record${Number.isFinite(seen) && seen > 0 ? `, and the last registry write was ${Math.max(0, t - seen)} s ago` : ""}`);
}
