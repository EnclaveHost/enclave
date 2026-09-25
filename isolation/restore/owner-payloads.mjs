#!/usr/bin/env node
// Steven's existing apps on the per-app SNP tier: the config/secret INVENTORY and the UNSIGNED owner transactions that
// move each one there (EnclaveDeployments.setConfig adding isolation.require). Codex's lane for enclave-5d, 2026-09-25.
//
// READ-ONLY. Nothing is signed or sent:
//   - every chain read goes to TWO independent Base RPCs at ONE pinned block, and they must agree;
//   - the relay is asked only its public, unauthenticated questions (does a deployment have staged secrets; is it
//     listed for the release), never for a secret or a secret's name;
//   - each payload is SIMULATED with eth_call from the owner at the pinned block, on both RPCs.
//
// setConfig(id, envelope) writes ONLY the deployment's options envelope (contracts/EnclaveDeployments.sol: d.configCid
// = envelope). The id, owner, app, shares, balance, cap and lease are untouched by construction, and --verify checks
// that after the owner signs. The envelope is REPLACED whole, so the new one is the current one with `isolation` added
// spliced onto the current BYTES, so every other namespace stays byte-for-byte (checked by re-parsing). The signatures come LAST, after canary acceptance
// (GUEST-POOL-ROLLOUT.md S6): once a deployment requires isolation, every runner without it refuses it.
//
// usage: node isolation/restore/owner-payloads.mjs <out dir>                 inventory.json + payloads.json
//        node isolation/restore/owner-payloads.mjs --check <payloads.json>    IMMEDIATELY BEFORE the owner signs: each
//                                     deployment is still exactly as the payload was built from, and the calldata
//                                     rebuilt from it now is byte-identical (enclave-d1: a stale payload would silently
//                                     revert an envelope edit made since, because setConfig replaces the whole envelope)
//        node isolation/restore/owner-payloads.mjs --verify <payloads.json> <0xid8…=0xtxhash> …   after signing: each
//                                     transaction IS its payload (input, to, from, success, exactly one ConfigSet from
//                                     the ledger for that id and envelope), and only the envelope changed
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, getAddress } from "viem";
import { base } from "viem/chains";

const OWNER = getAddress("0x0b2d009c0c9Af05b12100D77F3c815fea822eE61");   // Steven's governance key (a Trezor)
const ADDRESS_BOOK = getAddress("0xab214342d5A490150A4A977063A2f88E21F80907");
// two independent Base RPCs, which must agree (mainnet.base.org refused reads on 09-25). --verify reads RECEIPTS, which
// publicnode serves only with a personal token, so it uses its own pair. Either can be set: RPCS / VERIFY_RPCS=a,b
const pair = (env, dflt) => { const l = String(process.env[env] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return l.length === 2 ? l : dflt; };
const RPCS = pair("RPCS", ["https://base-rpc.publicnode.com", "https://base.drpc.org"]);
const VERIFY_RPCS = pair("VERIFY_RPCS", ["https://base.drpc.org", "https://1rpc.io/base"]);
const RELAY = "https://api.enclave.host";
const BACKEND = "snp-guest-per-app";
const ENVELOPE_MAX = 4096;                  // EnclaveDeployments MAX_CFG (rev >= 5)
const POOL_MIB = 65536;                     // metal-iso0's guest pool since 2026-09-25 (GUEST-POOL-ROLLOUT.md section 8)

const BOOK_ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [],
  outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
const DEP_TUPLE = [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" },
  { name: "ports", type: "string" }, { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" },
  { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" },
  { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" },
];
const DEP_ABI = [
  { type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEP_TUPLE }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "tuple", components: DEP_TUPLE }] },
  { type: "function", name: "capOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "maxRate6", type: "uint256" }] },
  { type: "function", name: "setConfig", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "configCid", type: "string" }], outputs: [] },
  { type: "event", name: "ConfigSet", inputs: [{ name: "id", type: "bytes32", indexed: true },
    { name: "configCid", type: "string", indexed: false }] },
];
const VERSION_TUPLE = [
  { name: "cid", type: "string" }, { name: "version", type: "string" }, { name: "vramMb", type: "uint32" },
  { name: "gpuGflops", type: "uint32" }, { name: "memMb", type: "uint32" }, { name: "cpuGflops", type: "uint32" },
  { name: "createdAt", type: "uint64" }, { name: "verified", type: "bool" }, { name: "yanked", type: "bool" },
  { name: "ports", type: "string" }, { name: "approval", type: "uint8" }, { name: "config", type: "string" },
];
const CAT_ABI = [{ type: "function", name: "getVersionsPage", stateMutability: "view",
  inputs: [{ name: "appId", type: "bytes32" }, { name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
  outputs: [{ type: "tuple[]", components: VERSION_TUPLE }] }];

const clientsFor = (urls) => urls.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 2, retryDelay: 800 }) }));
let clients = clientsFor(RPCS);
const plain = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// one read, from both RPCs, at the pinned block: agreement or an error
async function read2(blockNumber, address, abi, functionName, args = []) {
  const got = await Promise.all(clients.map((c) => c.readContract({ address, abi, functionName, args, blockNumber })));
  if (!same(got[0], got[1])) throw new Error(`the two RPCs disagree on ${functionName}(${plain(args).join(",")}) at block ${blockNumber}`);
  return got[0];
}

async function pinBlock() {
  // a block both RPCs have, a few behind the lower head, so neither is asked for state it lacks
  const heads = await Promise.all(clients.map((c) => c.getBlockNumber()));
  return (heads[0] < heads[1] ? heads[0] : heads[1]) - 5n;
}

async function book(blockNumber) {
  const [keys, values] = await read2(blockNumber, ADDRESS_BOOK, BOOK_ABI, "all");
  const out = {};
  keys.forEach((k, i) => { out[Buffer.from(k.slice(2), "hex").toString("utf8").replace(/\0+$/, "")] = getAddress(values[i]); });
  if (!out.deployments || !out.appCatalog) throw new Error("the address book names no deployments/appCatalog");
  return out;
}

async function relayJSON(method, url, body) {
  try {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  } catch (e) { return { status: 0, error: String(e.message || e) }; }
}

function parseEnvelope(raw) {
  const s = String(raw || "").trim();
  if (!s) return { kind: "empty", obj: {} };
  if (!s.startsWith("{")) return { kind: "legacy-string", obj: null };
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object" && !Array.isArray(o)) return { kind: "json", obj: o };
  } catch {}
  return { kind: "unparseable", obj: null };
}

// a raw-codec CIDv1 (bafkrei…) names sha256(bytes): fetched from a gateway and checked against the CID, or refused
function rawCidSha256(cid) {
  const m = /^b([a-z2-7]+)$/.exec(String(cid || ""));
  if (!m) return null;
  const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0; const out = [];
  for (const ch of m[1]) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 0xff); bits -= 8; } }
  const b = Buffer.from(out);   // 0x01 (v1) 0x55 (raw) 0x12 (sha2-256) 0x20 (32) <digest>
  return b.length === 36 && b[0] === 0x01 && b[1] === 0x55 && b[2] === 0x12 && b[3] === 0x20 ? b.subarray(4).toString("hex") : null;
}
async function fetchRawCid(cid) {
  const want = rawCidSha256(cid);
  if (!want) return { error: "not a raw sha256 CID; not fetched" };
  try {
    const r = await fetch(`https://trustless-gateway.link/ipfs/${cid}?format=raw`, { signal: AbortSignal.timeout(20000) });
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok) return { error: `gateway ${r.status}` };
    if (crypto.createHash("sha256").update(b).digest("hex") !== want) return { error: "the gateway's bytes do not match the CID" };
    return { text: b.toString("utf8") };
  } catch (e) { return { error: String(e.message || e) } }
}
// the config the app receives (the relay's precedence: the deployment's envelope, a pinned CID first, then the version's)
async function effectiveConfig(env, version) {
  const o = env.obj || {};
  if (o.configCid) { const f = await fetchRawCid(o.configCid); return { source: `envelope configCid ${o.configCid}`, ...f }; }
  if ("config" in o) return { source: "envelope inline config", text: JSON.stringify(o.config) };
  if (version && version.config) return { source: "the catalog version's config", text: version.config };
  return { source: "none", text: "" };
}
// every $NAME / ${NAME} in the config's STRING values (appconfig's rule), and the literal https origins it names
function tokensAndOrigins(text) {
  const tokens = new Set(), origins = new Set();
  let doc = null; try { doc = JSON.parse(text); } catch { return { tokens: null, origins: null, parse: "not JSON" }; }
  const walk = (x) => {
    if (typeof x === "string") {
      for (const m of x.matchAll(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) if (m[1] || m[2]) tokens.add(m[1] || m[2]);
      for (const m of x.matchAll(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)) origins.add(m[0]);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(doc);
  const all = [...tokens].sort();
  // secret names by convention are UPPER_SNAKE; anything else is most likely the app's own template variable
  return { secretLike: all.filter((t) => /^[A-Z][A-Z0-9_]*$/.test(t)), appTokens: all.filter((t) => !/^[A-Z][A-Z0-9_]*$/.test(t)),
           literalHttpsOrigins: [...origins].sort() };
}
// the new envelope: the current bytes with isolation appended, so every namespace stays byte-for-byte
function withIsolation(raw, env) {
  const add = `"isolation":{"require":"${BACKEND}"}`;
  const s = String(raw || "").trim();
  const next = env.kind === "empty" || !env.obj || !Object.keys(env.obj).length ? `{${add}}` : s.slice(0, -1) + "," + add + "}";
  const want = { ...(env.obj || {}), isolation: { require: BACKEND } };
  if (!same(JSON.parse(next), want)) throw new Error("the spliced envelope does not parse to the old one plus isolation");
  return next;
}

// the claim gate's static half (supervisor.js isolationClaimVerdict + parseDepOptions), from the ledger and catalog
function blockers(d, v, env, secretsProbe) {
  const b = [];
  if (!d.active) b.push("inactive (setActive(true) is a separate owner decision)");
  if (!d.isPublic) b.push("private: its owner gate needs request plaintext, which exists only inside the guest on this tier");
  if (Number(d.gpuMilli) > 0 || (v && Number(v.vramMb) > 0)) b.push("needs a GPU share or VRAM: a per-app SNP guest has no GPU path");
  if (env.kind === "legacy-string" || env.kind === "unparseable") b.push(`its envelope is not a JSON object (${env.kind}); setConfig would replace it, which is a config change to decide first`);
  const o = env.obj || {};
  if (o.waf && Object.keys(o.waf).length) b.push("sets protection rules (waf), which need request plaintext: dropping them is the owner's decision, not this payload's");
  const unknown = Object.keys(o).filter((k) => !["waf", "config", "configCid", "gpu", "network", "isolation"].includes(k));
  if (unknown.length) b.push(`unknown envelope namespace(s) ${unknown.join(", ")}`);
  if (o.isolation && (typeof o.isolation !== "object" || o.isolation.require !== BACKEND)) b.push(`already sets isolation to ${JSON.stringify(o.isolation)}`);
  const vols = (o.config && o.config.volumes) || [];
  if (Array.isArray(vols) && vols.length) b.push("needs model volumes, which are not mounted into a per-app guest");
  const ports = String((v && v.ports) || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ports.length > 1) b.push(`declares ports ${ports.join(", ")}: a per-app guest forwards at most one HTTP port`);
  if (secretsProbe.exists === null) b.push("the relay could not say whether it has staged secrets");
  return b;
}

// what setConfig must leave exactly as it was; rate included: only setShares changes it, so a change means someone else
// acted in between (enclave-d1). balance6, spent6, runner and leaseUntil move on their own with leases.
const preservedOf = (d, cap) => plain({ owner: d.owner, appRef: d.appRef, ports: d.ports, gpuMilli: d.gpuMilli,
  cpuMilli: d.cpuMilli, appPort: d.appPort, isPublic: d.isPublic, active: d.active, createdAt: d.createdAt, rate: d.rate,
  cap6: cap });

async function inventory(outDir) {
  const blockNumber = await pinBlock();
  const addr = await book(blockNumber);
  const schema = await read2(blockNumber, addr.deployments, DEP_ABI, "deploymentsSchema");
  const count = Number(await read2(blockNumber, addr.deployments, DEP_ABI, "count"));
  const mine = [];
  for (let s = 0; s < count; s += 100) {
    const page = await read2(blockNumber, addr.deployments, DEP_ABI, "getPage", [BigInt(s), 100n]);
    for (const d of page) if (getAddress(d.owner) === OWNER) mine.push(d);
  }
  const apps = [];
  const payloads = [];
  for (const d of mine) {
    const cap = await read2(blockNumber, addr.deployments, DEP_ABI, "capOf", [d.id]);
    let version = null, versionIndex = null, catalogApp = null;
    const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(d.appRef || "");
    if (m) {
      catalogApp = m[1].toLowerCase(); versionIndex = Number(m[2]);
      const vs = await read2(blockNumber, addr.appCatalog, CAT_ABI, "getVersionsPage", [catalogApp, 0n, BigInt(versionIndex + 1)]);
      version = vs[versionIndex] || null;
    }
    const ex = await relayJSON("POST", `${RELAY}/v1/secrets/exists`, { id: d.id.toLowerCase() });
    const secretsProbe = { status: ex.status,
      exists: ex.status === 200 && ex.body && typeof ex.body.exists === "boolean" ? ex.body.exists
        : ex.status === 503 && ex.body && ex.body.error === "secrets_disabled" ? false : null };
    const rs = await relayJSON("GET", `${RELAY}/v1/secrets/release-status?id=${d.id.toLowerCase()}`);
    const env = parseEnvelope(d.configCid);
    const bl = blockers(d, version, env, secretsProbe);
    const floorPct = version ? Math.ceil((Number(version.memMb) * 100) / POOL_MIB) : null;
    const cfg = await effectiveConfig(env, version);
    const cfgFacts = cfg.text ? tokensAndOrigins(cfg.text) : { secretLike: [], appTokens: [], literalHttpsOrigins: [] };
    const notes = [];
    if (env.obj && env.obj.network) notes.push(`routes through a named relay (${JSON.stringify(env.obj.network)}): confirm that relay serves this tier (U7) before the owner signs`);
    if (String((version && version.ports) || "").trim()) notes.push(`serves HTTP on its own port (${version.ports}): the enclave-catalog-bundle/2 derivation`);
    if (secretsProbe.exists && !(cfgFacts.secretLike || []).length) notes.push("secrets are staged but the config references none: they would reach the app only as env vars on the standard runtime, which this tier does not do");
    const entry = {
      id: d.id, short: d.id.slice(2, 10), appRef: d.appRef, catalogApp, versionIndex,
      version: version && { version: version.version, cid: version.cid, memMb: version.memMb, vramMb: version.vramMb,
        ports: version.ports, approval: version.approval, yanked: version.yanked,
        configBytes: Buffer.byteLength(version.config || ""), configSha256: version.config ? sha256(version.config) : null },
      ledger: { active: d.active, isPublic: d.isPublic, gpuMilli: d.gpuMilli, cpuMilli: d.cpuMilli, appPort: d.appPort,
        ports: d.ports, rate: d.rate, balance6: d.balance6, spent6: d.spent6, cap6: cap, leaseUntil: d.leaseUntil,
        runner: d.runner, runnerOperator: d.runnerOperator, createdAt: d.createdAt },
      envelope: { kind: env.kind, bytes: Buffer.byteLength(String(d.configCid || "")), sha256: sha256(String(d.configCid || "")),
        namespaces: env.obj ? Object.keys(env.obj) : null,
        configCid: env.obj && env.obj.configCid || null, inlineConfig: !!(env.obj && "config" in env.obj) },
      relay: { secretsStaged: secretsProbe.exists, secretsProbeStatus: secretsProbe.status,
        releaseStatus: rs.status, releaseListed: rs.body && typeof rs.body.listed === "boolean" ? rs.body.listed : null },
      config: { source: cfg.source, bytes: cfg.text ? Buffer.byteLength(cfg.text) : 0, sha256: cfg.text ? sha256(cfg.text) : null,
        error: cfg.error || null, ...cfgFacts },
      notes,
      tier: { shareFloorPctAtPool64GiB: floorPct, sharePctBought: Number(d.cpuMilli) / 10,
        shareFits: floorPct !== null && Number(d.cpuMilli) / 10 >= floorPct },
      blockers: bl,
    };
    if (entry.tier.shareFits === false) bl.push(`bought ${entry.tier.sharePctBought}% but this tier's floor for ${version.memMb} MB is ${floorPct}% (a resize is an owner decision, not this payload)`);
    apps.push(entry);
    if (bl.length) continue;
        const envelope = withIsolation(d.configCid, env);
    if (Buffer.byteLength(envelope) > ENVELOPE_MAX) { bl.push(`the new envelope is ${Buffer.byteLength(envelope)} bytes, over ${ENVELOPE_MAX}`); continue; }
    const data = encodeFunctionData({ abi: DEP_ABI, functionName: "setConfig", args: [d.id, envelope] });
    const sim = await Promise.all(clients.map((c) => c.call({ account: OWNER, to: addr.deployments, data, blockNumber })
      .then(() => "ok").catch((e) => "REVERT " + (e.shortMessage || e.message))));
    payloads.push({
      deployment: d.id, short: entry.short, chainId: 8453, from: OWNER, to: addr.deployments, value: "0",
      function: "setConfig(bytes32,string)", args: { id: d.id, configCid: envelope }, data,
      dataSha256: crypto.createHash("sha256").update(Buffer.from(data.slice(2), "hex")).digest("hex"),   // of the calldata BYTES
      envelopeBefore: String(d.configCid || ""), envelopeAfter: envelope, envelopeAfterBytes: Buffer.byteLength(envelope),
      simulation: { block: blockNumber, from: OWNER, results: Object.fromEntries(RPCS.map((u, i) => [u, sim[i]])) },
      // what --verify requires unchanged after the owner signs
      preserved: preservedOf(d, cap),
      ledgerAtBlock: plain({ balance6: d.balance6, spent6: d.spent6, leaseUntil: d.leaseUntil }),
    });
  }
  const head = { generatedAt: new Date().toISOString(), block: blockNumber.toString(), rpcs: RPCS, addressBook: ADDRESS_BOOK,
    deployments: addr.deployments, appCatalog: addr.appCatalog, deploymentsSchema: schema.toString(), owner: OWNER,
    poolMiB: POOL_MIB, relay: RELAY };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "inventory.json"), JSON.stringify(plain({ ...head, apps }), null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "payloads.json"), JSON.stringify(plain({ ...head,
    note: "UNSIGNED. For the owner to sign LAST, after canary acceptance (S6). Each is setConfig(id, envelope) with only `isolation` added.",
    payloads }), null, 2) + "\n");
  for (const a of apps) console.log(`${a.short} ${a.appRef} v=${a.version ? a.version.version : "?"} ${a.blockers.length ? "BLOCKED: " + a.blockers.join("; ") : "payload ready"}`);
  for (const p of payloads) console.log(`payload ${p.short}: ${p.envelopeAfterBytes} B envelope, simulation ${Object.values(p.simulation.results).join(" / ")}`);
}

// --check: the step immediately before the owner signs. Refuses unless every deployment is still what its payload was
// built from (the same envelope bytes, the same preserved fields) and the calldata rebuilt from it NOW is identical.
async function check(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const blockNumber = await pinBlock();
  const addr = await book(blockNumber);
  if (getAddress(addr.deployments) !== getAddress(doc.deployments)) { console.log(`the address book now names another ledger (${addr.deployments}); REFUSED`); process.exit(1); }
  let bad = 0;
  for (const p of doc.payloads) {
    const d = await read2(blockNumber, doc.deployments, DEP_ABI, "get", [p.deployment]);
    const cap = await read2(blockNumber, doc.deployments, DEP_ABI, "capOf", [p.deployment]);
    const why = [];
    if (String(d.configCid || "") !== p.envelopeBefore) why.push("its envelope CHANGED since the payload was built (signing would revert that change)");
    const now = preservedOf(d, cap);
    const moved = Object.keys(p.preserved).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(p.preserved[k]));
    if (moved.length) why.push(`preserved fields changed: ${moved.join(", ")}`);
    const env = parseEnvelope(d.configCid);
    let data = "";
    try { data = encodeFunctionData({ abi: DEP_ABI, functionName: "setConfig", args: [d.id, withIsolation(d.configCid, env)] }); }
    catch (e) { why.push(`cannot rebuild: ${e.message}`); }
    if (data && data !== p.data) why.push("the calldata rebuilt now differs from the payload's");
    const sim = await Promise.all(clients.map((c) => c.call({ account: getAddress(p.from), to: getAddress(p.to), data: p.data, blockNumber })
      .then(() => "ok").catch((e) => "REVERT " + (e.shortMessage || e.message))));
    if (sim.some((r) => r !== "ok")) why.push(`simulation: ${sim.join(" / ")}`);
    console.log(`${p.short}: ${why.length ? "REFUSED - " + why.join("; ") : "OK to sign (block " + blockNumber + ", calldata sha256 " + p.dataSha256 + ")"}`);
    if (why.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}

// --verify: after signing. Each named transaction must BE its payload, and the deployment afterwards must differ only in
// its envelope.
async function verify(file, txArgs) {
  clients = clientsFor(VERIFY_RPCS);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const txs = Object.fromEntries(txArgs.map((a) => a.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.toLowerCase().replace(/^0x/, ""), v]));
  const blockNumber = await pinBlock();
  let bad = 0;
  for (const p of doc.payloads) {
    const why = [];
    const txh = txs[p.short] || txs[p.deployment.slice(2)];
    if (!txh) { console.log(`${p.short}: no transaction named (pass ${p.short}=0x<tx hash>); not verified`); bad++; continue; }
    let tx0, tx1, rc0, rc1;
    try {
      [tx0, tx1] = await Promise.all(clients.map((c) => c.getTransaction({ hash: txh })));
      [rc0, rc1] = await Promise.all(clients.map((c) => c.getTransactionReceipt({ hash: txh })));
    } catch (e) { console.log(`${p.short}: FAILED - transaction ${txh} not found on both RPCs (${e.shortMessage || e.message})`); bad++; continue; }
    if (!same(tx0.input, tx1.input) || !same(rc0.logs, rc1.logs) || rc0.status !== rc1.status) why.push("the two RPCs disagree about the transaction");
    if (tx0.input !== p.data) why.push("its input is NOT the reviewed calldata");
    if (getAddress(tx0.to) !== getAddress(p.to)) why.push(`it went to ${tx0.to}, not the ledger`);
    if (getAddress(tx0.from) !== getAddress(p.from)) why.push(`it came from ${tx0.from}, not the owner`);
    if (BigInt(tx0.value) !== 0n) why.push("it carried value");
    if (rc0.status !== "success") why.push(`its receipt says ${rc0.status}`);
    const sets = rc0.logs.filter((l) => getAddress(l.address) === getAddress(p.to)).map((l) => {
      try { return decodeEventLog({ abi: DEP_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
      .filter((e) => e && e.eventName === "ConfigSet");
    if (sets.length !== 1 || sets[0].args.id.toLowerCase() !== p.deployment.toLowerCase() || sets[0].args.configCid !== p.envelopeAfter)
      why.push(`the ledger emitted ${sets.length} ConfigSet event(s), not exactly one for this id and envelope`);
    const d = await read2(blockNumber, doc.deployments, DEP_ABI, "get", [p.deployment]);
    const cap = await read2(blockNumber, doc.deployments, DEP_ABI, "capOf", [p.deployment]);
    if (d.configCid !== p.envelopeAfter) why.push("the envelope now is not the signed one");
    const now = preservedOf(d, cap);
    const moved = Object.keys(p.preserved).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(p.preserved[k]));
    if (moved.length) why.push(`preserved fields changed: ${moved.join(", ")}`);
    console.log(`${p.short}: ${why.length ? "FAILED - " + why.join("; ") : `verified (tx ${txh} in block ${rc0.blockNumber}; balance6 ${d.balance6}, was ${p.ledgerAtBlock.balance6})`}`);
    if (why.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const a = process.argv.slice(2);
if (a[0] === "--check" && a[1]) await check(a[1]);
else if (a[0] === "--verify" && a[1]) await verify(a[1], a.slice(2));
else if (a[0] && !a[0].startsWith("-")) await inventory(a[0]);
else { console.error("usage: owner-payloads.mjs <out dir> | --check <payloads.json> | --verify <payloads.json> <id8=0xtx> …"); process.exit(2); }
