#!/usr/bin/env node
// Read-only guestd commitments probe for fullbench.py (REVISION.md). NOT RUN: source only.
//
//   node guestd_commitments_probe.mjs --client <control-client.mjs> --client-sha256 <hex> --key-file <path>
//        --url http://127.0.0.1:<port> [--every <sec> --max-sec <sec>]
//
// It imports the EXACT bytes of the pinned guestd control client it hashed (a data: URL, so no second read of the
// path), reads the pairing key file in this process only, opens ONE guestd-control/1 session and sends GET /health
// and GET /vms. Each poll prints one JSON line of sanitized numbers: a hashed guestd instance identity, the pool numbers
// guestd itself computes (pendingMiB is pool.go pendingLocked), the GPU card budget/allocation, and per held guest a
// hashed id, status and its reservation. No key, kid, nonce, token, app id, measurement, name, port, host data or
// config is printed. Any failure prints {"kind":"guestd-commitments-error/1","error":<fixed word>} and exits 2.
// It sends no POST, DELETE or lease; it changes nothing in guestd.
import crypto from "node:crypto";
import fs from "node:fs";

function fail(kind) {
  process.stdout.write(JSON.stringify({ kind: "guestd-commitments-error/1", error: kind }) + "\n");
  process.exit(2);
}
function arg(name, optional = false) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return optional ? null : fail("usage");
  return process.argv[i + 1];
}
const nat = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : fail("schema"));
const h16 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

const clientPath = arg("--client"), clientSha = arg("--client-sha256"), keyFile = arg("--key-file"), url = arg("--url");
const every = Number(arg("--every", true) ?? 0), maxSec = Number(arg("--max-sec", true) ?? 0);
if (!/^https?:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(url)) fail("url-not-loopback");
if (!Number.isInteger(every) || every < 0 || every > 60) fail("usage");
if (every && !(Number.isInteger(maxSec) && maxSec > 0 && maxSec <= 12 * 3600)) fail("usage");

let src;
try { src = fs.readFileSync(clientPath); } catch { fail("client-unreadable"); }
if (crypto.createHash("sha256").update(src).digest("hex") !== clientSha) fail("client-digest");
const { GuestdControl, parseKey } = await import("data:text/javascript;base64," + src.toString("base64"));

let key;
try { key = parseKey(fs.readFileSync(keyFile, "utf8")); } catch { fail("key-file"); }
const c = new GuestdControl(url, key, { handshakeTimeoutMs: 5000, requestTimeoutMs: 8000, maxResponseBytes: 1 << 20 });

async function once(seq) {
  let health, vms;
  try {
    health = await c.request("GET", "/health");
    vms = await c.request("GET", "/vms");
  } catch (e) {
    fail("guestd-" + (/^[a-z-]{1,24}$/.test(String(e.kind)) ? e.kind : "error"));
  }
  if (health.status !== 200 || vms.status !== 200) fail("status");
  const pool = health.body.pool || {}, host = pool.host || {}, inf = health.body.inference;
  if (!inf || !pool.allocated) fail("schema");
  if (!Array.isArray(vms.body.vms)) fail("vms-schema");
  const held = vms.body.vms.filter((m) => m && m.reserved).map((m) => ({
    idSha256: h16(m.id),
    status: /^[a-z_-]{1,16}$/.test(String(m.status)) ? m.status : "other",
    memMiB: nat(m.reserved.memMiB), cpuPct: nat(m.reserved.cpuPct), gpuCardBytes: nat(m.gpuCardBytes ?? 0),
  })).sort((a, b) => (a.idSha256 < b.idSha256 ? -1 : 1));
  if (held.length !== pool.guests || held.reduce((n,g) => n + g.memMiB, 0) !== pool.allocated.memMiB || held.reduce((n,g) => n + g.gpuCardBytes, 0) !== inf.cardAllocatedBytes) fail("snapshot-raced");
  const floors = {};
  for (const [k, v] of Object.entries(inf.modelFloorsMiB || {})) floors[String(k).slice(0, 64)] = nat(v);
  return {
    kind: "guestd-commitments/1", seq, instance: h16(c.instance),
    pool: {
      budgetMemMiB: pool.budget ? nat(pool.budget.memMiB) : null, allocatedMemMiB: nat(pool.allocated.memMiB),
      guests: nat(pool.guests), floorMiB: nat(host.floorMiB),
      memAvailableMiB: host.memAvailableMiB == null ? null : nat(host.memAvailableMiB),
      pendingMiB: nat(host.pendingMiB), unreadUnits: nat(host.unreadUnits),
    },
    inference: {
      cards: nat(inf.cards), cardBudgetBytes: nat(inf.cardBudgetBytes), cardAllocatedBytes: nat(inf.cardAllocatedBytes),
      cardFreeBytes: nat(inf.cardFreeBytes), shareBoundedMemory: inf.shareBoundedMemory === true, modelFloorsMiB: floors,
    },
    held,
  };
}

const end = Date.now() + maxSec * 1000;
for (let seq = 1; ; seq++) {
  process.stdout.write(JSON.stringify(await once(seq)) + "\n");
  if (!every || Date.now() + every * 1000 > end) break;
  await new Promise((r) => setTimeout(r, every * 1000));
}
key.fill(0);
