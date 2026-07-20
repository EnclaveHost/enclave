// OFAC SDN screening for inbound USDC payers (hard invariant: screen BEFORE
// provisioning; hits and stale data go to manual review, never auto-provision).
//
// Source: the official OFAC SDN list, XML edition - public domain,
// authoritative, no API key. Digital-currency addresses are structured id
// entries: <idType>Digital Currency Address - ETH</idType> with the address in
// <idNumber>. We extract EVERY "Digital Currency Address - *" entry with a
// regex scan (no XML dependency; ~10MB of the file's structure is boilerplate)
// and screen against the full set lowercased - Base shares the ETH address
// space, and a sanctioned party's tagged-for-another-chain EVM address is
// still the same keypair.
//
// Refresh daily (hourly retry on failure), cached to ofac-sdn.json so a relay
// restart screens immediately. Two guards:
//   - a refresh that returns an empty or >50%-shrunken ETH set is REFUSED
//     (torn download / format change must not blank the screen)
//   - data older than OFAC_MAX_AGE_SEC (48h) reports "stale", which the
//     caller routes to review - the screen fails closed, never open.

import { atomicWriteJson, dataFile } from "./store.js";
import fs from "node:fs";

const URLS = (process.env.OFAC_SDN_URLS ||
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML," +
  "https://www.treasury.gov/ofac/downloads/sdn.xml")
  .split(",").map((s) => s.trim()).filter(Boolean);
const REFRESH_SEC = parseInt(process.env.OFAC_REFRESH_SEC || "86400", 10);
const MAX_AGE_SEC = parseInt(process.env.OFAC_MAX_AGE_SEC || "172800", 10);
const MAX_BYTES = parseInt(process.env.OFAC_MAX_BYTES || "104857600", 10);

let file = "";
let cache = null;   // { fetchedAt, publishDate, source, eth: [..], other: [..] }
let ethSet = new Set();

export function parseSdnXml(xml) {
  const eth = new Set(), other = new Set();
  const re = /<idType>Digital Currency Address - ([A-Z0-9.]+)<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g;
  let m;
  while ((m = re.exec(xml))) {
    const addr = m[2].trim().toLowerCase();
    // every EVM-shaped address screens as ETH regardless of the tagged asset
    if (/^0x[0-9a-f]{40}$/.test(addr)) eth.add(addr);
    else other.add(`${m[1]}:${addr}`);
  }
  const pub = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(xml);
  return { eth: [...eth], other: [...other], publishDate: pub ? pub[1] : "" };
}

function adopt(parsed, source, fetchedAt) {
  cache = { fetchedAt, publishDate: parsed.publishDate, source, eth: parsed.eth, other: parsed.other };
  ethSet = new Set(parsed.eth);
}

export async function refreshSdn() {
  for (const url of URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120_000);
      let xml;
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const len = Number(r.headers.get("content-length") || 0);
        if (len > MAX_BYTES) throw new Error(`too large (${len} bytes)`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error(`too large (${buf.length} bytes)`);
        xml = buf.toString("utf8");
      } finally { clearTimeout(t); }
      const parsed = parseSdnXml(xml);
      if (!parsed.eth.length)
        throw new Error("no ETH addresses parsed - refusing to blank the screen");
      if (cache && parsed.eth.length < cache.eth.length * 0.5)
        throw new Error(`parsed set shrank ${cache.eth.length} -> ${parsed.eth.length} - refusing (torn download?)`);
      adopt(parsed, url, new Date().toISOString());
      if (file) atomicWriteJson(file, cache);
      console.log(`[ofac] SDN refreshed from ${url}: ${parsed.eth.length} EVM addresses (published ${parsed.publishDate || "?"})`);
      return true;
    } catch (e) {
      console.warn(`[ofac] refresh via ${url} failed: ${e.message}`);
    }
  }
  return false;
}

// -> { result: "clear"|"hit"|"stale", dataAgeSec, matched? }
export function screenAddress(addr) {
  if (!cache || !cache.fetchedAt)
    return { result: "stale", dataAgeSec: null };
  const ageSec = Math.floor((Date.now() - Date.parse(cache.fetchedAt)) / 1000);
  if (!(ageSec < MAX_AGE_SEC))
    return { result: "stale", dataAgeSec: ageSec };
  const a = String(addr || "").toLowerCase();
  if (ethSet.has(a)) return { result: "hit", matched: a, dataAgeSec: ageSec };
  return { result: "clear", dataAgeSec: ageSec };
}

export function initOfac(dir) {
  file = dataFile(dir, "ofac-sdn.json");
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    if (onDisk && Array.isArray(onDisk.eth)) { cache = onDisk; ethSet = new Set(onDisk.eth); }
  } catch {}
  if (cache) console.log(`[ofac] cache loaded: ${cache.eth.length} EVM addresses (fetched ${cache.fetchedAt})`);
  refreshSdn();
  const t = setInterval(() => {
    const ageSec = cache ? (Date.now() - Date.parse(cache.fetchedAt)) / 1000 : Infinity;
    if (ageSec > REFRESH_SEC) refreshSdn();
  }, 3600_000);
  t.unref?.();
}
