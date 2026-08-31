// The relay's per-deployment connection log (relay/connlog.mjs).
//
// This is the only view of a deployment's traffic that exists OUTSIDE the CVM,
// and it is deliberately thin: an address, a direction, a time, and how many
// bytes the connection moved. A relay peeks SNI without terminating TLS on the
// way in and dials an already-authenticated destination on the way out, so
// there is no request, path or header here to record even if we wanted one.
//
// Worth testing rather than eyeballing, because every failure mode is silent.
// A row that is never closed reports no bandwidth; a double-close reports the
// wrong bandwidth; an unbounded table is a memory leak on a box whose whole
// security argument is that it holds nothing. None of those announce
// themselves in a graph - they just make it quietly wrong.
//
//   run: node --test test/connlog.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "connlog-"));
process.env.CONNLOG_DIR = DIR;
const cl = await import("../relay/connlog.mjs");

test("a connection is a row: who, which way, when, and what it moved", () => {
  const row = cl.note("0xdead", "in", "82.1.2.3", 443);
  assert.equal(row.d, "in");
  assert.equal(row.a, "82.1.2.3");
  assert.equal(row.p, 443);
  assert.ok(row.t > 0);
  assert.equal(row.e, undefined, "still open: no end time and no byte counts yet");
  assert.equal(row.u, undefined);

  cl.done(row, 1200, 340000);
  assert.ok(row.e >= row.t);
  assert.equal(row.u, 1200, "what the peer sent us");
  assert.equal(row.w, 340000, "what we sent the peer");
});

test("closing twice keeps the first answer", () => {
  // a splice tears down from either end and both ends fire `close`; the second
  // call must not overwrite real byte counts with a destroyed socket's zeroes
  const row = cl.note("0xbeef", "in", "10.0.0.1", 443);
  cl.done(row, 500, 9000);
  cl.done(row, 0, 0);
  assert.equal(row.u, 500);
  assert.equal(row.w, 9000);
});

test("an IPv4 client is one address, not two", () => {
  // node hands back "::ffff:1.2.3.4" or "1.2.3.4" depending on how the socket
  // was bound; storing both spellings would split one client across two rows
  assert.equal(cl.normAddr("::ffff:82.1.2.3"), "82.1.2.3");
  assert.equal(cl.normAddr("::FFFF:82.1.2.3"), "82.1.2.3");
  assert.equal(cl.normAddr("2a01:4f9::1"), "2a01:4f9::1");
  assert.equal(cl.normAddr(""), "");
});

test("outbound names the destination the APP asked for", () => {
  // "api.example.com" is the answer to "what is my app talking to"; the
  // address DNS happened to pick is not, and on anycast it is actively useless
  const row = cl.note("0xfeed", "out", "api.example.com", 443);
  assert.equal(row.d, "out");
  assert.equal(row.a, "api.example.com");
});

test("a nameless or addressless connection is not logged", () => {
  assert.equal(cl.note("", "in", "1.2.3.4", 1), undefined);
  assert.equal(cl.note("0xabc", "in", "", 1), undefined);
});

test("the table is bounded: rows per deployment, and deployments", () => {
  const dep = "0xcap";
  for (let i = 0; i < cl.limits.MAX_PER_DEP + 50; i++) cl.note(dep, "in", "9.9.9." + (i % 250), 443);
  assert.equal(cl.read(dep).length, cl.limits.MAX_PER_DEP, "oldest rows fall off the front");

  // past the deployment cap the OLDEST log is dropped whole rather than the
  // new name being refused - a permissionless relay must not let unknown names
  // pin the table, and must not stop recording the box's current traffic either
  for (let i = 0; i < cl.limits.MAX_DEPS + 5; i++) cl.note("dep-" + i, "in", "1.1.1.1", 443);
  assert.ok(cl.read("dep-0").length === 0, "the first name aged out of the table");
  assert.ok(cl.read("dep-" + (cl.limits.MAX_DEPS + 4)).length === 1, "the newest is still recorded");
});

test("the snapshot round-trips through tmpfs for the agent to serve", () => {
  // the collectors hold the sockets and have no way out; the agent has the
  // fleet tunnel and no sockets. This file is the whole channel between them.
  const dep = "0xsnap";
  const a = cl.note(dep, "in", "82.9.9.9", 443);
  cl.done(a, 10, 20);
  cl.note(dep, "out", "example.com", 443);
  cl.startSnapshot("unit-test", 60_000)();          // writes once, then stops

  const rows = cl.readSnapshots(dep);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.d), ["in", "out"], "oldest first, both directions");
  assert.equal(rows[0].u, 10);
  assert.equal(rows[0].w, 20);
  // and summing is how a caller gets a total back
  assert.equal(rows.reduce((n, r) => n + (r.u || 0) + (r.w || 0), 0), 30);
});

test("a torn or missing snapshot reads as no rows, never as a throw", () => {
  fs.writeFileSync(path.join(DIR, "garbage.json"), "{not json");
  assert.deepEqual(cl.readSnapshots("0xnothing"), []);
  // and a directory that does not exist at all
  process.env.CONNLOG_DIR = path.join(DIR, "gone");
  assert.doesNotThrow(() => cl.readSnapshots("0xsnap"));
  process.env.CONNLOG_DIR = DIR;
});
