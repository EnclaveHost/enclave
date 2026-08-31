// Per-deployment CONNECTION log — who reached this app, and where it reached out to.
//
// A relay is the only place outside the CVM that sees either fact, and it sees
// exactly this much: an address and a time. It peeks SNI without terminating
// TLS on the way in and dials an already-authenticated destination on the way
// out, so there is no request, no path, no header and no body here to record
// even if we wanted one. That narrowness is the feature: the log answers "who
// talked to this deployment, and when" without the relay having to understand
// a single byte of what was said.
//
// WHY IT IS NOT A REQUEST COUNT. One connection carries many HTTP requests
// (h2 multiplexes; h1 keeps alive), so `in` is a count of CONNECTIONS and
// under-counts requests by an unknown factor. Callers must label it that way -
// a graph that says "requests" here would be wrong in a direction nobody could
// detect by looking at it.
//
// Bounded on purpose, twice over. A relay's security argument is that it holds
// nothing: this keeps a fixed number of rows, forgets the oldest as it goes and
// ages the rest out, so a busy deployment cannot grow it. The snapshot below
// lands on TMPFS (/run) rather than disk - it exists only so the read-only
// agent process can serve what the relay processes collected, and a reboot
// takes it with them. It is a live view, not a record.

import fs from "node:fs";
import path from "node:path";

const MAX_PER_DEP = Number(process.env.CONNLOG_MAX || 500);   // rows kept per deployment
const MAX_DEPS    = Number(process.env.CONNLOG_MAX_DEPS || 256);
const MAX_AGE_MS  = Number(process.env.CONNLOG_MAX_AGE_MS || 30 * 60 * 1000);

// dep -> { rows: [row] }
//   t  ms epoch the connection OPENED      d  "in" | "out"
//   a  peer address (or the host an        p  port
//      outbound dial named)
//   e  ms epoch it CLOSED (absent = still open)
//   u  bytes the peer sent us              w  bytes we sent the peer
//
// Bytes are per CONNECTION rather than a rolling total, because that is the
// breakdown that answers a question totals cannot: eight open connections
// moving nothing is a very different picture from eight moving megabytes, and
// only the per-connection split tells them apart. Summing them gives the total
// back whenever that is what a caller wants.
const _log = new Map();

// An IPv6-mapped IPv4 ("::ffff:1.2.3.4") is the same address a human would
// write as 1.2.3.4; storing the mapped form makes the same client look like
// two. Node hands us either depending on how the socket was bound.
export function normAddr(a) {
  const s = String(a || "").trim();
  if (!s) return "";
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return (m ? m[1] : s).toLowerCase().slice(0, 64);
}

/** Record one connection. `dep` is the deployment id (or label), `dir` is
 *  "in" (someone reached the app) or "out" (the app reached out). */
export function note(dep, dir, addr, port) {
  const key = String(dep || "").toLowerCase().slice(0, 80);
  const a = normAddr(addr);
  if (!key || !a) return;
  let e = _log.get(key);
  if (!e) {
    // A permissionless relay must not let unknown names grow this without
    // bound: past the cap the OLDEST deployment's log is dropped whole rather
    // than refusing the new one, so a quiet app cannot pin the table forever.
    if (_log.size >= MAX_DEPS) { const first = _log.keys().next().value; if (first) _log.delete(first); }
    e = { rows: [] };
    _log.set(key, e);
  }
  const row = { t: Date.now(), d: dir === "out" ? "out" : "in", a, p: Number(port) || 0 };
  e.rows.push(row);
  if (e.rows.length > MAX_PER_DEP) e.rows.splice(0, e.rows.length - MAX_PER_DEP);
  // Handed back so the caller can close it out. A row that is never finished
  // (relay killed mid-connection) simply keeps no `e` and no byte counts,
  // which reads correctly as "open when we last knew".
  return row;
}

/** Close a row out with what the connection actually moved. `up` is what the
 *  peer sent, `down` what we sent it. Safe to call twice: a splice tears down
 *  from either end and both ends fire. */
export function done(row, up, down) {
  if (!row || row.e) return;
  row.e = Date.now();
  row.u = Math.max(0, Number(up) || 0);
  row.w = Math.max(0, Number(down) || 0);
}

/** Rows for one deployment, oldest first, aged out. `sinceMs` trims further. */
export function read(dep, sinceMs = 0) {
  const e = _log.get(String(dep || "").toLowerCase());
  if (!e) return [];
  const floor = Math.max(Date.now() - MAX_AGE_MS, Number(sinceMs) || 0);
  return e.rows.filter((r) => r.t >= floor);
}

/** Everything, for the agent's snapshot. Aged rows are dropped as we go, which
 *  is also the only place expiry happens - there is no timer to leak. */
export function snapshot() {
  const floor = Date.now() - MAX_AGE_MS;
  const out = {};
  for (const [dep, e] of _log) {
    e.rows = e.rows.filter((r) => r.t >= floor);
    if (!e.rows.length) { _log.delete(dep); continue; }
    out[dep] = e.rows;
  }
  return out;
}

export const limits = { MAX_PER_DEP, MAX_DEPS, MAX_AGE_MS };

// ---- snapshot: the relay processes collect, the AGENT serves ---------------
// They are separate units on the same box (relay.js and egress-relay.js hold
// the sockets; relay-agent.mjs is the only one with a way out, over the fleet
// tunnel). So the collectors publish here and the agent reads. /run is tmpfs:
// no disk, and gone on reboot like the rest of this module's state.
export const SNAP_DIR = process.env.CONNLOG_DIR || "/run/enclave-relay";

/** Publish this process's rows every `everyMs` under `name`.json. Best effort
 *  throughout: a relay that cannot write its snapshot must keep relaying. */
export function startSnapshot(name, everyMs = 5000) {
  const file = path.join(SNAP_DIR, `${String(name).replace(/[^a-z0-9_-]/gi, "")}.json`);
  const tick = () => {
    try {
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      // write-then-rename: the agent must never read a half-written file
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), deps: snapshot() }));
      fs.renameSync(tmp, file);
    } catch { /* a relay that cannot snapshot still relays */ }
  };
  const t = setInterval(tick, Math.max(1000, everyMs));
  if (t.unref) t.unref();
  tick();
  return () => clearInterval(t);
}

/** Merge every collector's snapshot on this box. Rows for one deployment come
 *  from both directions and are returned oldest-first. */
export function readSnapshots(dep, sinceMs = 0) {
  const key = String(dep || "").toLowerCase();
  const floor = Math.max(Date.now() - MAX_AGE_MS, Number(sinceMs) || 0);
  let rows = [];
  let files = [];
  try { files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), "utf8"));
      const got = (j && j.deps && j.deps[key]) || [];
      for (const r of got) if (r && r.t >= floor) rows.push(r);
    } catch { /* a torn or absent file is simply no rows */ }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.slice(-MAX_PER_DEP);
}
