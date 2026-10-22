// R-ISO public catalog/ledger read (Claude control-package; scoped, root-authorized PUBLIC read-only RPC). eth_call/eth_getCode/
// eth_getBlock only, at ONE common confirmed block on TWO independent providers (the reviewed trust's rpcs, the reviewed paced
// clients). Never signs or sends. For ONLY the 9 expected ids of root's riso-read.json. Saves public ids/appRef/version/CIDs,
// gpuMilli and key-presence/non-emptiness flags; config values never leave this process (only flags, and sha256 for the
// two-provider equality check, are kept). Config interpretation = the FROZEN candidate node-bridge 6a80bb3c functions.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DNS, CATALOG_ABI, LEDGER_ABI } from "../../../enclavedns-stale-20261021/wallet-handoff/trust.mjs";
import { clientsFor } from "../../../lease-gas-wallet-signing/rpc-clients.mjs";
import { keccak256, pad, stringToHex, getAddress } from "../../../enclave/node_modules/viem/_esm/index.js";
import { encVolumesNamed, modelVolumesNamed, appConfigOf } from "../../../lease-readiness-20261022/tree/windows/vbslike/datapath/node-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), W = path.resolve(here, "../../..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const RISO = path.join(W, "root-control-final-20261022/control-package/riso-read.json");
const BRIDGE = path.join(W, "lease-readiness-20261022/tree/windows/vbslike/datapath/node-bridge.mjs");
if (sha(fs.readFileSync(BRIDGE)) !== "6a80bb3c09adffa5a12c780fbb3240de21a820361473ecb4ded6501e03c4a353") throw Error("node-bridge is not the frozen candidate");
const riso = JSON.parse(fs.readFileSync(RISO, "utf8"));
const IDS = riso.expectedIds; if (IDS.length !== 9 || !IDS.every((i) => /^0x[0-9a-f]{64}$/.test(i))) throw Error("expected exactly the 9 ids");
const probeRows = Object.fromEntries(riso.apps.flatMap((p) => p.apps).map((a) => [a.id, a]));
const BOOK_ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
const keyOf = (n) => pad(stringToHex(n), { dir: "right", size: 32 });
const rpcs = [...DNS.rpcs]; if (rpcs.length !== 2 || new Set(rpcs.map((u) => new URL(u).hostname)).size !== 2) throw Error("need two independent providers");
const clients = clientsFor(rpcs);
const both = async (f) => Promise.all(clients.map((c) => f(c)));
const canon = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));
const agree = (what, a) => { if (canon(a[0]) !== canon(a[1])) throw Error(`providers disagree on ${what}`); return a[0]; };

// the deployment's envelope -> its delivered-config SOURCE, as host.mjs appConfig(strictCid) + chain.parseEnvelope +
// shield-startup.shieldStartupEnvelope route it (the same classification as riso-probe 7364c643's remote text)
function envelope(raw) {
  const s = String(raw || "").trim();
  if (!s) return { src: "version" };
  if (!s.startsWith("{")) return { src: "bare-envelope" };
  let o; try { o = JSON.parse(s); } catch { return { src: "envelope-unreadable" }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { src: "envelope-unreadable" };
  if (Object.hasOwn(o, "guestBootstrap")) return { src: "owner-startup" };
  if (Object.hasOwn(o, "configCid")) return /^[A-Za-z0-9]{10,100}$/.test(String(o.configCid)) ? { src: "envelope-cid", cid: String(o.configCid) } : { src: "envelope-cid-invalid" };
  if (Object.hasOwn(o, "config")) return (o.config && typeof o.config === "object" && !Array.isArray(o.config))
    ? { src: "envelope-inline", flags: flagsOf(JSON.stringify(o.config)) } : { src: "envelope-inline", flags: "not-an-object" };
  return { src: "version" };
}
// key presence + non-emptiness of one delivered config text, by the candidate's OWN functions
function flagsOf(text) {
  let o = null; try { o = JSON.parse(String(text || "")); } catch {}
  const isObj = !!o && typeof o === "object" && !Array.isArray(o);
  const delivered = appConfigOf(text);
  return { parse: isObj, encKey: isObj && Object.hasOwn(o, "encVolumes"), encNonEmpty: !!encVolumesNamed(delivered),
           volKey: isObj && Object.hasOwn(o, "volumes"), volNonEmpty: modelVolumesNamed(delivered).length > 0, mediaOnly: isObj && delivered === "" };
}

const out = { at: new Date().toISOString(), scope: "public read-only eth_call/eth_getCode/eth_getBlock; no signing/sending; 9 ids of riso-read.json",
              inputs: { risoRead: { path: "work/root-control-final-20261022/control-package/riso-read.json", sha256: sha(fs.readFileSync(RISO)) },
                        trust: "work/enclavedns-stale-20261021/wallet-handoff/trust.mjs", rpcClients: "work/lease-gas-wallet-signing/rpc-clients.mjs",
                        interpretation: "lease-readiness-20261022 frozen node-bridge.mjs 6a80bb3c (encVolumesNamed, modelVolumesNamed, appConfigOf)" },
              providers: rpcs.map((u) => new URL(u).hostname) };
const chain = await both((c) => c.getChainId()); if (!chain.every((x) => x === DNS.chainId)) throw Error(`chain ids ${chain}`);
const heads = await both((c) => c.getBlockNumber());
const B = (heads[0] < heads[1] ? heads[0] : heads[1]) - BigInt(DNS.confirmations);
const blocks = await both((c) => c.getBlock({ blockNumber: B }));
out.block = { number: B.toString(), hash: agree("block hash", blocks.map((b) => b.hash)), timestamp: blocks[0].timestamp.toString(), heads: heads.map(String), confirmations: String(DNS.confirmations) };
const at = { blockNumber: B };
const codes = {};
for (const [k, addr] of [["ledger", DNS.ledger], ["catalog", DNS.catalog]]) {
  const h = agree(`${k} code`, (await both((c) => c.getCode({ address: addr, ...at }))).map((x) => keccak256(x)));
  codes[k] = { address: getAddress(addr), codeHash: h, pinned: DNS.codeHashes[k], ok: h === DNS.codeHashes[k] };
}
out.contracts = codes;
const [keys, vals] = agree("address book", await both((c) => c.readContract({ address: DNS.book, abi: BOOK_ABI, functionName: "all", ...at })));
const bookOf = (n) => { const i = keys.findIndex((x) => x.toLowerCase() === keyOf(n).toLowerCase()); return i >= 0 ? getAddress(vals[i]) : null; };
out.addressBook = { book: getAddress(DNS.book), deployments: bookOf("deployments"), appCatalog: bookOf("appCatalog") };
out.addressBook.matchesTrust = out.addressBook.deployments === getAddress(DNS.ledger) && out.addressBook.appCatalog === getAddress(DNS.catalog);
const schema = agree("catalogSchema", await both((c) => c.readContract({ address: DNS.catalog, abi: CATALOG_ABI, functionName: "catalogSchema", ...at })));
out.catalogSchema = schema.toString();
if (!codes.ledger.ok || !codes.catalog.ok) throw Error("a contract is not its pinned code");

out.deployments = [];
for (const id of IDS) {
  const d = agree(`get ${id}`, await both((c) => c.readContract({ address: DNS.ledger, abi: LEDGER_ABI, functionName: "get", args: [id], ...at })));
  if (String(d.id).toLowerCase() !== id) throw Error(`ledger returned another id for ${id}`);
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(String(d.appRef).trim());
  const row = { id, appRef: d.appRef, gpuMilli: Number(d.gpuMilli), isPublic: d.isPublic, active: d.active };
  const env = envelope(d.configCid);
  row.envelope = { src: env.src, ...(env.cid ? { cid: env.cid } : {}), ...(env.flags !== undefined ? { flags: env.flags } : {}) };
  const p = probeRows[id] || {};
  row.envelope.matchesRisoRead = p.src === env.src && (p.cid ?? null) === (env.cid ?? null) &&
    (env.src !== "envelope-inline" || canon(p.flags) === canon(env.flags));
  if (!m) { row.version = { error: "appRef is not catalog://<appId>/<index>" }; out.deployments.push(row); continue; }
  const v = agree(`getVersion ${d.appRef}`, (await both((c) => c.readContract({ address: DNS.catalog, abi: CATALOG_ABI, functionName: "getVersion", args: [m[1], BigInt(m[2])], ...at })))
    .map((x) => ({ cid: x.cid, version: x.version, memMb: Number(x.memMb), yanked: x.yanked, configSha256: sha(String(x.config || "")), config: x.config })));
  const vcid = schema >= 7n ? agree(`versionConfigCid ${d.appRef}`, (await both((c) => c.readContract({ address: DNS.catalog, abi: CATALOG_ABI,
    functionName: "versionConfigCid", args: [m[1], BigInt(m[2])], ...at }))).map((x) => String(x || ""))) : "";
  // the version's inline field: host.mjs isolationVerdict's `volumes` (cfg.volumes, null when unreadable) and, when the
  // version is the delivered source WITHOUT a configCid, the delivered config itself (appConfig: String(v.config || ""))
  let cfg = null, volumesParam = null;
  try { cfg = v.config ? JSON.parse(v.config) : {}; volumesParam = Array.isArray(cfg.volumes) ? cfg.volumes.slice() : []; } catch { volumesParam = null; }
  const namedFromParam = volumesParam === null ? null : volumesParam.map((x) => String(x).trim()).filter(Boolean).length > 0;
  row.version = { appId: m[1], index: Number(m[2]), version: v.version, artifactCid: v.cid, memMb: v.memMb, yanked: v.yanked, configCid: vcid,
                  inlineFlags: flagsOf(String(v.config || "")), volumesParamNonEmpty: namedFromParam };
  if (env.src === "version") {
    if (vcid) row.delivered = { source: "version-configCid", cid: vcid, flags: "NEEDS the cached node\\apps\\cfg-<cid>.json (re-probe with --version-cids)" };
    else {
      const f = flagsOf(String(v.config || ""));
      // isolationPlan: named = deliveredConfig ? configVolumes(deliveredConfig) : the volumes param
      row.delivered = { source: "version-inline", flags: f, volNonEmptyAsPlanned: f.mediaOnly || !v.config ? namedFromParam : f.volNonEmpty, encNonEmpty: f.encNonEmpty };
    }
  }
  out.deployments.push(row);
}
// never persist config text: drop it from every row (it was only hashed and flagged in memory)
const text = JSON.stringify(out, (k, x) => (k === "config" ? undefined : typeof x === "bigint" ? x.toString() : x), 1);
if (/"config"\s*:/.test(text)) throw Error("a config value would be written");
fs.writeFileSync(path.join(here, "public-read.json"), text + "\n");
console.log(JSON.stringify({ block: out.block, contracts: out.contracts, addressBook: out.addressBook, catalogSchema: out.catalogSchema,
  rows: out.deployments.map((r) => ({ id: r.id.slice(0, 10), appRef: r.appRef, gpuMilli: r.gpuMilli, src: r.envelope.src, match: r.envelope.matchesRisoRead, vcid: r.version?.configCid, delivered: r.delivered?.source })) }, null, 1));
