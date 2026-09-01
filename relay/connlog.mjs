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
// Inbound the relay learns an 8-hex LABEL off the SNI; outbound the enclave
// sends the full 64-hex id. Both name the same deployment and neither can be
// derived from the other upward, so the LABEL is the canonical key - the same
// short name the app zone already uses in public. Without this the two
// directions filed under different keys and every query found half the truth.
export function depKey(dep) {
  const raw = String(dep || "").toLowerCase().replace(/^0x/, "").slice(0, 80);
  return /^[0-9a-f]{8,}$/.test(raw) ? raw.slice(0, 8) : raw;
}

export function note(dep, dir, addr, port) {
  const key = depKey(dep);
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
  const e = _log.get(depKey(dep));
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

// ---- publishing: the relay processes collect, the AGENT serves -------------
// They are separate units on the same box - relay.js and egress-relay.js hold
// the sockets, relay-agent.mjs is the only one with a way out (the fleet
// tunnel) - so the collectors have to hand their rows over somehow.
//
// NOT through a file. Every one of these units runs DynamicUser=yes with
// ProtectSystem=strict: an ephemeral UID and a read-only filesystem, so a
// write to /run fails, and RuntimeDirectory= does not rescue it either because
// two collectors with two different ephemeral UIDs cannot share one directory.
// The first cut of this wrote a tmpfs snapshot, failed silently (the write is
// best-effort by design) and produced an endpoint that answered `rows: []`
// forever - a shape that looks exactly like "no traffic".
//
// Loopback HTTP instead: no filesystem, no ownership, nothing to get right.
// PrivateNetwork is not set on these units, so 127.0.0.1 is shared between
// them and reachable from nowhere else.
import http from "node:http";

// Above the relay's own listener range (1-49999) and below the pinned
// ephemeral floor (58000), so this can never race a tenant port or an
// outbound connection for the same number.
export const PORT_IN  = Number(process.env.CONNLOG_PORT_IN  || 50123);
export const PORT_OUT = Number(process.env.CONNLOG_PORT_OUT || 50124);

/** Publish this process's rows on loopback. Best effort: a relay that cannot
 *  bind the port must keep relaying, so the failure is logged and dropped. */
export function serve(port) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ at: Date.now(), deps: snapshot() }));
  });
  srv.on("error", (e) => console.error(`[connlog] not publishing on ${port}: ${e.message}`));
  srv.listen(port, "127.0.0.1");
  if (srv.unref) srv.unref();
  return srv;
}

/** Merge every collector on this box. Rows for one deployment come from both
 *  directions and are returned oldest-first. A collector that is not running
 *  (nan-relay runs no agent; us-west runs no udp relay) simply contributes
 *  nothing rather than failing the read. */
export async function collect(dep, sinceMs = 0, ports = [PORT_IN, PORT_OUT]) {
  const key = depKey(dep);
  const floor = Math.max(Date.now() - MAX_AGE_MS, Number(sinceMs) || 0);
  const got = await Promise.all(ports.map((p) => new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: p, path: "/", timeout: 2000 }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => { if (b.length < 4e6) b += d; });
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  })));
  const rows = [];
  for (const j of got) for (const r of ((j && j.deps && j.deps[key]) || [])) if (r.t >= floor) rows.push(r);
  rows.sort((a, b) => a.t - b.t);
  return rows.slice(-MAX_PER_DEP);
}
