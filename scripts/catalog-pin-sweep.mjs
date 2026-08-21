#!/usr/bin/env node
// catalog-pin-sweep.mjs — every approved, non-yanked catalog version must be
// SERVABLE: its wasm CID (and its config CID, when the version keeps one at a
// CID) answers on the pin gateway. Run it and the answer is yes, or the exit
// code is 1 with a per-CID report of what the fleet cannot launch.
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

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function catalogAddress() {
  const hex = await ethCall(ADDRESS_BOOK, SEL_ALL);
  const [keysOff, addrsOff] = [num(hex, 0) / 32, num(hex, 1) / 32];
  const n = num(hex, keysOff);
  for (let i = 0; i < n; i++) {
    const key = Buffer.from(word(hex, keysOff + 1 + i), "hex").toString("utf8").replace(/\0+$/, "");
    if (key === "appCatalog") return "0x" + word(hex, addrsOff + 1 + i).slice(24);
  }
  throw new Error("the address book has no appCatalog entry");
}

// One ranged read per CID. 200/206 = served; 404/410 (or the adapter's
// index-miss JSON) = MISSING; anything else retries as weather (the gateway
// rate-limits per IP, so the sweep is SERIAL with a gap on purpose — a
// parallel sweep reads as one big connect-failure and proves nothing).
async function probe(cid) {
  for (let attempt = 0; ; attempt++) {
    let status = 0, bodyStart = "";
    try {
      const r = await fetch(`${GATEWAY}/ipfs/${cid}`, { headers: { range: "bytes=0-99" },
        signal: AbortSignal.timeout(20_000) });
      status = r.status;
      if (status !== 200 && status !== 206) bodyStart = (await r.text().catch(() => "")).slice(0, 200);
      else try { await r.body?.cancel(); } catch {}
    } catch { /* connect/timeout: transient */ }
    if (status === 200 || status === 206) return { ok: true };
    if (status === 404 || status === 410 || /not in this gateway's index/i.test(bodyStart))
      return { ok: false, kind: "MISSING", detail: `HTTP ${status}` };
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
    const catalog = await catalogAddress();
    const rev = num(await ethCall(catalog, SEL_CATALOG_SCHEMA), 0);
    if (rev >= 7) {
      for (const v of approvedVersions) {
        const data = SEL_VERSION_CONFIGCID + v.appId.slice(2).padStart(64, "0")
                   + v.index.toString(16).padStart(64, "0");
        want(decodeString(await ethCall(catalog, data)).trim(), `${v.slug}:${v.version} (config)`);
      }
    }
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

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
