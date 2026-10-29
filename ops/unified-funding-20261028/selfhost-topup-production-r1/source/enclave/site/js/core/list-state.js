/* ============================================================
   What a panel may show when the read behind it FAILS.

   A failed read is not an empty list. On 2026-09-25 a relay deploy
   crash-looped the API for about six minutes (the proxy answered 502
   with no CORS headers). The dashboard put one error line in the list
   body while its status counters read 0, and the fleet panel said "No
   app hosts available right now": an owner with twelve deployments was
   shown none, and nothing retried until the page was reloaded.

   The rules every list panel follows:
   - a failed read never renders as zero rows or zero counts;
   - the last successful rows come back, marked stale with their time,
     ONLY for the identity they were read for (the connected wallet and
     account session). Another wallet's rows are never shown;
   - the panel keeps retrying, and the next success clears the mark.
   ============================================================ */

/* Whose list this is: the connected wallet (case-insensitive) plus the
   passkey/card account session, since the dashboard merges both. An account
   session with no id cannot be told apart from another one, so it gets no
   identity at all, and a failure then shows an error, never cached rows. */
export function listIdentity(address, accountAuthed, accountId) {
  const wallet = String(address || "").toLowerCase();
  if (accountAuthed && !accountId) return null;
  const account = accountAuthed ? "account:" + String(accountId) : "";
  return wallet || account ? wallet + "|" + account : null;
}

/* The last successful read, remembered for one identity. */
export class LastGood {
  constructor() { this.key = null; this.rows = null; this.at = 0; }
  ok(key, rows, now = Date.now()) {
    this.key = key; this.rows = Array.isArray(rows) ? rows.slice() : []; this.at = now;
    return { kind: "fresh", rows: this.rows, at: now };
  }
  // stale: same identity, rows from `at`; error: nothing may be shown
  failed(key, error, now = Date.now()) {
    void now;
    if (key != null && this.rows && this.key === key) return { kind: "stale", rows: this.rows, at: this.at, error };
    return { kind: "error", rows: null, at: 0, error };
  }
}

/* A short, true reason. A fetch that never got a response (status 0) says
   only that: it is NOT evidence of a CORS problem, and during the outage it
   was a crashed upstream behind a proxy whose 502 carried no CORS headers. */
export function failureReason(e) {
  const status = e && typeof e.status === "number" ? e.status : null;
  if (status === 0) return "the Enclave API did not answer";
  if (status) {
    const m = e && e.message && !/^HTTP \d+/.test(e.message) ? ": " + String(e.message).slice(0, 160) : "";
    return "the Enclave API answered HTTP " + status + m;
  }
  return "the read failed";
}

/* "as of 01:47:12" for a stale mark, in the viewer's own clock. */
export function asOf(at) {
  try { return new Date(at).toLocaleTimeString(); } catch (e) { return new Date(at).toISOString(); }
}
