// READ-ONLY, bounded probe 2 (GET/HEAD and eth_call only; 25 s per request; no keys, no writes):
//   A. the ipns-publisher's public status page (its config error / value source line, if any)
//   B. the delegated-routing IPNS record, decoded (value, validity EOL, sequence, ttl)
//   C. for that CID and the known site CIDs: IPNI/delegated providers, trustless retrieval from Enclave's front and a
//      public trustless gateway
//   D. the publisher deployment's PUBLIC ledger row on Base (two RPCs agreeing), incl. its configCid
import fs from "node:fs";
import { createPublicClient, http } from "../../enclave/node_modules/viem/_esm/index.js";
import { base } from "../../enclave/node_modules/viem/_esm/chains/index.js";

const NAME = "k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52";
const PUB = "https://d9798e4c.app.enclave.host";
const DEP = "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a";
const { ENROLLMENT } = await import("../../lease-enrollment-signing/trust.mjs");
const LEDGER = ENROLLMENT.ledger;   // the reviewed production deployment ledger on Base
const KNOWN = { "nan-doc 2026-10-19 (seq 1026)": "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou",
  "production base of the reviewed release": "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y",
  "recovery release (unpublished)": "bafybeic7sud3ozsx7fbyo5iwwzqxs3pun54kppahf5eaocupahxmwikjzq" };
const out = { at: new Date().toISOString(), checks: [] };
async function get(url, { accept, method = "GET", limit = 65536 } = {}) {
  const t0 = Date.now(), r = { url, method };
  try {
    const res = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(25_000), headers: { "user-agent": "enclave-ens-diagnosis/2", ...(accept ? { accept } : {}) } });
    r.status = res.status;
    r.headers = Object.fromEntries([...res.headers].filter(([k]) => /content-type|content-length|location|x-ipfs|server|cache-control|etag/.test(k)));
    if (method === "GET") { const b = Buffer.from(await res.arrayBuffer()); r.bytes = b.length; r._body = b.subarray(0, limit); }
  } catch (e) { r.error = `${e.name}: ${e.message}`; }
  r.seconds = (Date.now() - t0) / 1000; return r;
}
const keep = (r, { show = 0, note } = {}) => { const b = r._body; delete r._body; if (show && b) r.sample = b.subarray(0, show).toString("utf8"); if (note) r.note = note; out.checks.push(r); return b; };
function varint(b, i) { let v = 0, s = 0, x; do { x = b[i++]; v += (x & 127) * 2 ** s; s += 7; } while (x & 128); return [v, i]; }
function record(b) {   // IpnsEntry: 1 value, 2 sigV1, 3 validityType, 4 validity, 5 sequence, 6 ttl, 7 pubKey, 8 sigV2, 9 data
  const f = {}; let i = 0;
  while (i < b.length) { let k; [k, i] = varint(b, i); const fn = Math.floor(k / 8), wt = k & 7;
    if (wt === 0) { let v; [v, i] = varint(b, i); f[fn] = v; } else if (wt === 2) { let n; [n, i] = varint(b, i); f[fn] = b.subarray(i, i + n); i += n; } else throw Error("wire type " + wt); }
  const validity = f[4] ? f[4].toString() : null;
  return { value: f[1]?.toString(), validity, expired: validity ? Date.parse(validity) < Date.now() : null, sequence: f[5], ttlSeconds: f[6] ? f[6] / 1e9 : null, hasV2: !!f[8], bytes: b.length };
}

// A
const page = keep(await get(PUB + "/"));
if (page) out.publisherPage = page.toString("utf8").replace(/<style>[\s\S]*?<\/style>/, "").replace(/<link[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2500);
keep(await get(PUB + "/api/status"), { show: 2000 });
// B
const recs = {};
for (const [label, url] of [["delegated-ipfs.dev", `https://delegated-ipfs.dev/routing/v1/ipns/${NAME}`], ["publisher", `${PUB}/routing/v1/ipns/${NAME}`]]) {
  const r = await get(url, { accept: "application/vnd.ipfs.ipns-record" }); const b = keep(r, { show: r.status === 200 ? 0 : 300 });
  if (r.status === 200 && b) { try { recs[label] = r.record = record(b); } catch (e) { r.decodeError = e.message; } }
}
out.records = recs;
// C
const cids = { ...KNOWN };
for (const [l, rec] of Object.entries(recs)) if (rec.value?.startsWith("/ipfs/")) cids[`IPNS record via ${l} (seq ${rec.sequence})`] = rec.value.slice(6).split("/")[0];
out.cids = cids;
for (const [label, cid] of Object.entries(cids)) {
  const isRecord = label.startsWith("IPNS record");
  const prov = keep(await get(`https://delegated-ipfs.dev/routing/v1/providers/${cid}`, { accept: "application/json" }), { show: 1500, note: label });
  keep(await get(`https://ipfs.enclave.host/ipfs/${cid}?format=raw`, { accept: "application/vnd.ipld.raw" }), { show: 200, note: label + ": Enclave front, trustless root block" });
  if (isRecord) {
    keep(await get(`https://cid.contact/routing/v1/providers/${cid}`, { accept: "application/json" }), { show: 1500, note: label + ": IPNI" });
    keep(await get(`https://trustless-gateway.link/ipfs/${cid}?format=raw`, { accept: "application/vnd.ipld.raw" }), { show: 200, note: label + ": public trustless gateway" });
  }
}
// D
const abi = JSON.parse(fs.readFileSync(new URL("../../enclave/contracts/EnclaveDeployments.abi.json", import.meta.url), "utf8"));
const rows = [];
for (const url of ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]) {
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { timeout: 20_000 }) });
    const block = await c.getBlockNumber() - 2n;
    const d = await c.readContract({ address: LEDGER, abi, functionName: "get", args: [DEP], blockNumber: block });
    rows.push({ url, block: String(block), row: JSON.parse(JSON.stringify(d, (k, v) => typeof v === "bigint" ? String(v) : v)) });
  } catch (e) { rows.push({ url, error: String(e.shortMessage || e.message).slice(0, 300) }); }
}
out.ledger = rows;
const cfg = rows.find((r) => r.row)?.row?.configCid;
if (cfg && /^(baf|Qm)/.test(cfg)) keep(await get(`https://ipfs.enclave.host/ipfs/${cfg}`), { show: 6000, note: "publisher deployment config (public)" });
fs.writeFileSync(new URL("./probe2.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ records: recs, cids, page: out.publisherPage?.slice(0, 1200), ledger: rows.map((r) => r.row ? { url: r.url, configCid: r.row.configCid, appRef: r.row.appRef, active: r.row.active } : r),
  checks: out.checks.map((c) => [c.note || "", c.url.slice(0, 95), c.status ?? c.error, c.seconds]) }, null, 1));
