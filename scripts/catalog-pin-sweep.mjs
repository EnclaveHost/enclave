#!/usr/bin/env node
// catalog-pin-sweep.mjs — every approved, non-yanked catalog version must be
// SERVABLE: its wasm CID (and its config CID, when the version keeps one at a
// CID) answers on the pin gateway AS A CAR CARRYING ITS ROOT BLOCK, which is
// the only form the runner can launch from. Run it and the answer is yes, or
// the exit code is 1 with a per-CID report of what the fleet cannot launch.
//
// Why this exists (2026-08-20): after the ipfs.enclave.host cutover, 27 of 29
// approved apps' wasm silently 404'd on the gateway. Nothing alarmed — apps
// kept launching from enclave-local caches until a fleet repoint wiped one,
// and then every claim of those apps died at the prefetch step with no record.
// A sweep like this, on a schedule, catches that class the day it happens.
// (.github/workflows/catalog-pin-check.yml runs it every 6 hours.)
//
// Usage:  node scripts/catalog-pin-sweep.mjs
// Env:    GATEWAY    pin gateway base (default https://ipfs.enclave.host —
//                    the same default the fleet's wasm_manager fetches from)
//         BASE_RPC   preferred Base RPC, tried before the public pool
//         SKIP_CIDS  comma-separated CIDs to tolerate missing (each one is
//                    logged loudly; use only for a known loss pending a yank)
//
// No dependencies beyond the CLI it spawns (cli/enclave.mjs reads the catalog
// through the address book, paging and schema revs included); the config-CID
// reads go over raw eth_call with hardcoded selectors, same pattern as
// catalog-status.mjs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// viem resolved exactly as the CLI resolves it (the pin-check workflow installs
// cli/ deps); decoding getPage's dynamic tuples by hand is not worth owning.
// LAZY on purpose: test/catalog-pin-sweep.test.mjs imports this module only for
// the CAR reader, and that reader has no business needing a chain library to
// load. viem currently resolves up to the root node_modules, so an eager
// require happens to work — this keeps it working if that ever stops being true.
let _viem = null;
const viem = () => (_viem ??= createRequire(path.join(REPO, "cli", "package.json"))("viem"));

const GATEWAY = (process.env.GATEWAY || "https://ipfs.enclave.host").replace(/\/+$/, "");
const SKIP = new Set((process.env.SKIP_CIDS || "").split(",").map((s) => s.trim()).filter(Boolean));

// The on-chain root (same constant the CLI bakes as DEFAULTS.ADDRESS_BOOK_ADDRESS
// and overrides nothing above it): the book names the catalog, so a catalog
// redeploy never stales this script.
const ADDRESS_BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const RPCS = [...new Set([process.env.BASE_RPC, "https://mainnet.base.org",
  "https://base-rpc.publicnode.com", "https://base.drpc.org"].filter(Boolean))];

const SEL_ALL               = "0x10c4e8b0"; // all() -> (bytes32[] keys, address[] addrs)
const SEL_CATALOG_SCHEMA    = "0x18cccf57"; // catalogSchema() -> uint256
const SEL_VERSION_CONFIGCID = "0x637d5777"; // versionConfigCid(bytes32,uint256) -> string

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ethCall(to, data) {
  let last;
  for (const rpc of RPCS) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
          signal: AbortSignal.timeout(15_000) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || "rpc error");
        return j.result;
      } catch (e) { last = e; await sleep(1000); }
    }
  }
  throw last;
}

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const num = (hex, i) => parseInt(word(hex, i), 16);
// one dynamic string return: head word = offset, then length + bytes
function decodeString(hex) {
  const off = num(hex, 0) / 32;
  const len = num(hex, off);
  return Buffer.from(hex.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2), "hex").toString("utf8");
}

async function bookAddress(wantKey) {
  const hex = await ethCall(ADDRESS_BOOK, SEL_ALL);
  const [keysOff, addrsOff] = [num(hex, 0) / 32, num(hex, 1) / 32];
  const n = num(hex, keysOff);
  for (let i = 0; i < n; i++) {
    const key = Buffer.from(word(hex, keysOff + 1 + i), "hex").toString("utf8").replace(/\0+$/, "");
    if (key === wantKey) return "0x" + word(hex, addrsOff + 1 + i).slice(24);
  }
  throw new Error(`the address book has no ${wantKey} entry`);
}

// A deployment's options envelope may pin its app config at a CID
// (`{"configCid": "…"}`), and the LAUNCH fetches those bytes — a lost
// envelope config CID strands its deployment exactly like lost wasm (found
// live 2026-08-22: eyesoff-ai failed provision on "ipfs fetch failed for
// config bafkreicl…" — a CID no catalog row references). Rows that are
// inactive with nothing left to spend are skipped: nothing can launch them.
const DEP_PAGE_ABI = [{ type: "function", name: "getPage", stateMutability: "view",
  inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
  outputs: [{ type: "tuple[]", components: [
    { name: "id", type: "bytes32" }, { name: "owner", type: "address" },
    { name: "appRef", type: "string" }, { name: "ports", type: "string" },
    { name: "configCid", type: "string" },
    { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
    { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
    { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
    { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" },
    { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
    { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
  ] }] }];
async function deploymentEnvelopeCids() {
  const ledger = await bookAddress("deployments");
  const out = [];
  for (let start = 0; ; start += 100) {
    const data = viem().encodeFunctionData({ abi: DEP_PAGE_ABI, functionName: "getPage",
      args: [BigInt(start), 100n] });
    const page = viem().decodeFunctionResult({ abi: DEP_PAGE_ABI, functionName: "getPage",
      data: await ethCall(ledger, data) });
    for (const d of page) {
      if (!d.active && d.balance6 === 0n) continue;
      const s = String(d.configCid || "").trim();
      if (!s.startsWith("{")) continue;
      let cid = null;
      try { cid = JSON.parse(s).configCid; } catch { continue; }
      if (typeof cid === "string" && /^[a-zA-Z0-9]{10,100}$/.test(cid.trim()))
        out.push({ cid: cid.trim(), label: `deployment ${d.id.slice(0, 10)} (envelope config)` });
    }
    if (page.length < 100) break;
  }
  return out;
}

// ---- CARv1, just enough of it to answer "can the runner actually launch this?"
//
// The plain path is NOT the check. The runner prefetches a CAR
// (wasm/ipfs_fetch.py fetch_verified -> ?format=car&dag-scope=all) and refuses
// with "CAR does not contain the requested CID" unless the root arrives as a
// BLOCK. nan's local kubo answers a CID it does not have with HTTP 200 and a
// 59-byte header-only CAR — a valid CARv1 naming the root in its `roots` array
// and carrying no blocks at all. Nothing in that exchange looks like an error.
// A plain-path sweep therefore green-lights a gateway the fleet cannot launch
// from, which is exactly what happened on 2026-08-26: this script reported
// "1 CID missing" while the runner was failing to prefetch one of the 140 it
// had just passed. So skip the header exactly as parse_car does and look for
// the root among the block entries.
const CAR_SCAN_CAP = 16 * 1024 * 1024;   // the root block comes first; this is slack, not a budget

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function cidStrToBytes(str) {
  if (str.startsWith("b")) {                       // CIDv1, base32 lower, rfc4648, no pad
    let bits = 0, acc = 0;
    const out = [];
    for (const ch of str.slice(1)) {
      const v = B32.indexOf(ch);
      if (v < 0) throw new Error(`bad base32 char ${ch} in ${str}`);
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    return Buffer.from(out);
  }
  if (str.startsWith("Qm")) {                      // CIDv0, base58btc
    const n = [0];
    for (const ch of str) {
      const v = B58.indexOf(ch);
      if (v < 0) throw new Error(`bad base58 char ${ch} in ${str}`);
      let carry = v;
      for (let i = 0; i < n.length; i++) { carry += n[i] * 58; n[i] = carry & 0xff; carry >>= 8; }
      while (carry) { n.push(carry & 0xff); carry >>= 8; }
    }
    for (let i = 0; i < str.length && str[i] === "1"; i++) n.push(0);
    return Buffer.from(n.reverse());
  }
  throw new Error(`unsupported CID encoding: ${str}`);
}

// [value, nextPos] — or null when the buffer stops mid-varint (need more bytes)
function uvarint(buf, pos) {
  let x = 0, shift = 0;
  for (let i = pos; i < buf.length; i++) {
    const b = buf[i];
    x += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [x, i + 1];
    shift += 7;
    if (shift > 63) throw new Error("varint too long");
  }
  return null;
}

// byte length of the CID sitting at `pos` — or null when the buffer is short
function cidLen(buf, pos) {
  if (pos + 2 > buf.length) return null;
  if (buf[pos] === 0x12 && buf[pos + 1] === 0x20)  // CIDv0: sha2-256, 32 bytes
    return pos + 34 <= buf.length ? 34 : null;
  let r = uvarint(buf, pos); if (!r) return null;          // version
  r = uvarint(buf, r[1]);    if (!r) return null;          // codec
  r = uvarint(buf, r[1]);    if (!r) return null;          // multihash code
  r = uvarint(buf, r[1]);    if (!r) return null;          // digest length
  const end = r[1] + r[0];
  return end <= buf.length ? end - pos : null;
}

// Stream the CAR only until the root block shows up, then hang up: the root is
// emitted first, so this reads a few KB off a 55 MB app rather than the lot.
async function fetchCarRoot(cid) {
  const want = cidStrToBytes(cid);
  const r = await fetch(`${GATEWAY}/ipfs/${cid}?format=car&dag-scope=all`,
    { headers: { accept: "application/vnd.ipld.car" }, signal: AbortSignal.timeout(60_000) });
  if (r.status !== 200 && r.status !== 206) {
    const body = (await r.text().catch(() => "")).slice(0, 200);
    return { status: r.status, body, found: false, total: 0 };
  }
  const { found, total, truncated } = await carHasRoot(r.body, want);
  return { status: r.status, found, total, truncated, body: "" };
}

// Scan a CARv1 byte stream for `want` among the BLOCK entries, stopping the
// moment it appears. Chunk boundaries fall anywhere, so every read is
// resumable: a frame that runs past what we hold is skipped forward through
// `pending` rather than buffered whole.
async function carHasRoot(stream, want) {
  const reader = stream.getReader();
  let buf = Buffer.alloc(0), pending = 0, total = 0;
  let headerDone = false, found = false, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      let chunk = Buffer.from(value);
      if (pending) {                                  // discarding a block we already judged
        const n = Math.min(pending, chunk.length);
        pending -= n; chunk = chunk.subarray(n);
      }
      if (chunk.length) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let pos = 0;
        for (;;) {
          const v = uvarint(buf, pos); if (!v) break;
          const [len, afterLen] = v;
          const end = afterLen + len;
          if (!headerDone) {                          // header names the roots; blocks are the proof
            if (end > buf.length) break;
            pos = end; headerDone = true; continue;
          }
          const cl = cidLen(buf, afterLen);
          if (cl === null) break;
          if (buf.subarray(afterLen, afterLen + cl).equals(want)) { found = true; break; }
          if (end <= buf.length) { pos = end; continue; }
          pending = end - buf.length; buf = Buffer.alloc(0); pos = 0; break;
        }
        if (found) break;
        if (pos) buf = buf.subarray(pos);
      }
      if (total > CAR_SCAN_CAP) { truncated = true; break; }
    }
  } finally { try { await reader.cancel(); } catch {} }
  return { found, total, truncated };
}

// Diagnostic only, and only when the CAR check has already failed: "plain 200,
// CAR 59 B" is the kubo-fallback signature and worth naming in the report.
async function plainStatus(cid) {
  try {
    const r = await fetch(`${GATEWAY}/ipfs/${cid}`, { headers: { range: "bytes=0-99" },
      signal: AbortSignal.timeout(20_000) });
    try { await r.body?.cancel(); } catch {}
    return `HTTP ${r.status}`;
  } catch { return "no response"; }
}

// One CAR probe per CID. Root block present = launchable; 404/410 (or the
// adapter's index-miss JSON) or a rootless CAR = MISSING; anything else retries
// as weather (the gateway rate-limits per IP, so the sweep is SERIAL with a gap
// on purpose — a parallel sweep reads as one big connect-failure and proves
// nothing).
async function probe(cid) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try { res = await fetchCarRoot(cid); } catch { /* connect/timeout: transient */ }
    if (res?.found) return { ok: true };
    const status = res?.status ?? 0;
    if (status === 404 || status === 410 || /not in this gateway's index/i.test(res?.body || ""))
      return { ok: false, kind: "MISSING", detail: `HTTP ${status}` };
    if (res && (status === 200 || status === 206) && !res.truncated)
      return { ok: false, kind: "MISSING",
               detail: `CAR of ${res.total} B carries no root block (plain path: ${await plainStatus(cid)})` };
    if (res?.truncated)
      return { ok: false, kind: "UNREACHABLE",
               detail: `no root block in the first ${CAR_SCAN_CAP} B of the CAR` };
    if (attempt >= 2) return { ok: false, kind: "UNREACHABLE", detail: status ? `HTTP ${status}` : "no response" };
    await sleep(status === 429 ? 5000 : 2000 * (attempt + 1));
  }
}

async function main() {
  const { stdout } = await pexec(process.execPath, [path.join(REPO, "cli", "enclave.mjs"), "apps", "--json"],
                                 { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  const apps = JSON.parse(stdout).apps || [];

  // cid -> the versions that need it (several versions may share bytes)
  const need = new Map();
  const want = (cid, label) => {
    if (!cid) return;
    if (!need.has(cid)) need.set(cid, []);
    need.get(cid).push(label);
  };
  const approvedVersions = [];
  for (const a of apps)
    a.versions.forEach((v, index) => {
      if (v.approval !== "approved" || v.yanked) return;
      approvedVersions.push({ appId: a.appId, index, slug: a.slug, version: v.version });
      want(v.cid, `${a.slug}:${v.version} (wasm)`);
    });

  // rev-7 large configs live at their own CID: a launch fetches those bytes
  // too, so a lost config CID strands its versions exactly like lost wasm.
  try {
    const catalog = await bookAddress("appCatalog");
    const rev = num(await ethCall(catalog, SEL_CATALOG_SCHEMA), 0);
    if (rev >= 7) {
      for (const v of approvedVersions) {
        const data = SEL_VERSION_CONFIGCID + v.appId.slice(2).padStart(64, "0")
                   + v.index.toString(16).padStart(64, "0");
        want(decodeString(await ethCall(catalog, data)).trim(), `${v.slug}:${v.version} (config)`);
      }
    }
    for (const d of await deploymentEnvelopeCids()) want(d.cid, d.label);
  } catch (e) {
    // the catalog itself unreadable is its own alarm — do not report "all served"
    console.error(`config-CID reads failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`sweeping ${need.size} distinct CIDs (${approvedVersions.length} approved versions) against ${GATEWAY}\n`);
  const misses = [];
  let skipped = 0;
  for (const [cid, labels] of need) {
    if (SKIP.has(cid)) { skipped++; console.log(`SKIPPED (allowlisted) ${cid}  <- ${labels.join(", ")}`); continue; }
    const r = await probe(cid);
    if (!r.ok) {
      misses.push({ cid, labels, ...r });
      console.log(`${r.kind} (${r.detail}) ${cid}  <- ${labels.join(", ")}`);
    }
    await sleep(250);
  }

  if (skipped) console.log(`\n${skipped} CID(s) allowlisted via SKIP_CIDS — the gateway does NOT serve them.`);
  if (!misses.length) { console.log(`OK: every non-skipped CID is served.`); return; }
  const missing = misses.filter((m) => m.kind === "MISSING").length;
  console.error(`\nFAIL: ${missing} CID(s) missing from the gateway, ${misses.length - missing} unreachable.`
    + `\nA missing wasm/config CID makes its versions unLAUNCHABLE fleet-wide the moment enclave`
    + `\ncaches drop it. Re-pin the exact bytes (CID unchanged) via /add-wasm — see`
    + `\nmemory/enclave-catalog-wasm-unpinned.md for the recipe — or yank the version.`);
  process.exit(1);
}

// Importable so test/catalog-pin-sweep.test.mjs can exercise the CAR reader
// against hand-built CARs — a parser that says "root present" when it is not is
// the exact failure this whole script exists to catch.
export { cidStrToBytes, uvarint, cidLen, carHasRoot };

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url))
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
