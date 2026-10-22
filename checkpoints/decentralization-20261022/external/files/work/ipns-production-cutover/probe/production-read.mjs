#!/usr/bin/env node
// Public, read-only state of the production ipns-publisher: the deployment record, its catalog version and config
// commitment through agreed reads (lib/chain.mjs Quorum, one blockHash), the publisher's own status, and every
// reachable copy of the IPNS record, each verified against the name by kubo (`ipfs name inspect --verify`, offline).
// Secrets: the envelope may carry config values; it is hashed (the commitment) and only a redacted form is stored.
// The highest sequence SEEN here is a floor for what exists, never a proof that nothing higher was ever signed.
//
//   node probe/production-read.mjs [--out FILE] [--dht]
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Quorum, redactConfig, viem } from "../lib/chain.mjs";
import { ABI, PRODUCTION } from "../lib/production.mjs";

import { ANCHOR, WORKSPACE_PROFILE } from "../lib/paths.mjs";
const WS = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
const profile = JSON.parse(readFileSync(argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : WORKSPACE_PROFILE, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const out = { kind: "production-read", capturedAt: new Date().toISOString(), production: PRODUCTION };

// ---- chain: one agreed block for every read --------------------------------------------------------------------
const q = new Quorum({ rpcs: profile.review.rpcHosts.map((h) => `https://${h}`), chainId: profile.chainId, quorum: 2, confirmations: 6, maxBlockAgeSecs: 120 });
await q.block();
const ledger = profile.contracts.deployments.address;
const catalog = profile.contracts.appCatalog.address;
const ledgerCode = await q.code(ledger);
const catalogCode = await q.code(catalog);
const schema = Number(await q.read(ledger, ABI.ledger, "deploymentsSchema"));
const d = await q.read(ledger, ABI.ledger, "get", [PRODUCTION.deployment]);
const catSchema = Number(await q.read(catalog, ABI.catalog, "catalogSchema"));
const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(d.appRef);
let version = null, app = null, versionConfigCid = null;
if (m) {
  const [v] = await q.read(catalog, catSchema >= 4 ? ABI.catalogV3 : ABI.catalog, "getVersionsPage", [m[1], BigInt(m[2]), 1n]);
  version = v;
  if (catSchema >= 7) versionConfigCid = await q.read(catalog, ABI.catalog, "versionConfigCid", [m[1], BigInt(m[2])]);
  app = { appId: m[1], index: Number(m[2]), numVersions: Number(await q.read(catalog, ABI.catalog, "numVersions", [m[1]])) };
}
const ownerCode = await q.code(d.owner);
const ownerNonce = await q.nonce(d.owner);
const ownerBalance = await q.balance(d.owner);
const createCode = await q.code(PRODUCTION.create2Deployer);
out.chain = q.close();
out.chain.codeHashes = {
  deployments: { observed: viem.keccak256(ledgerCode), pinned: profile.contracts.deployments.codeHash },
  appCatalog: { observed: viem.keccak256(catalogCode), pinned: profile.contracts.appCatalog.codeHash },
  create2Deployer: { address: PRODUCTION.create2Deployer, observed: createCode === "0x" ? null : viem.keccak256(createCode), expected: PRODUCTION.create2DeployerCodeHash },
};
out.chain.deploymentsSchema = schema;
out.chain.catalogSchema = catSchema;

let envelope = String(d.configCid ?? "");
let parsed = null;
try { parsed = envelope.trim().startsWith("{") ? JSON.parse(envelope) : null; } catch {}
out.deployment = {
  id: PRODUCTION.deployment, owner: d.owner, ownerIsContract: ownerCode !== "0x", ownerNonce, ownerBalanceWei: String(ownerBalance),
  appRef: d.appRef, active: d.active, isPublic: d.isPublic, appPort: Number(d.appPort), cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli),
  createdAt: Number(d.createdAt), leaseUntil: Number(d.leaseUntil), runner: d.runner, runnerOperator: d.runnerOperator,
  balance6: String(d.balance6), rate: String(d.rate),
  envelope: {
    commitmentSha256: sha256(Buffer.from(envelope, "utf8")), bytes: Buffer.byteLength(envelope),
    namespaces: parsed ? Object.keys(parsed) : null,
    configCid: parsed?.configCid ?? null,
    guestBootstrapSha256: parsed?.guestBootstrap?.sha256 ?? null,
    configRedacted: parsed?.config ? redactConfig(parsed.config) : null,
    waf: parsed?.waf ?? null,
  },
};
envelope = null; // never stored raw
out.version = version && {
  ...app, cid: version.cid, version: version.version, approval: Number(version.approval), yanked: version.yanked, verified: version.verified,
  memMb: Number(version.memMb), ports: version.ports, createdAt: Number(version.createdAt),
  configSha256: version.config ? sha256(Buffer.from(version.config, "utf8")) : null,
  configRedacted: (() => { try { return version.config ? redactConfig(JSON.parse(version.config)) : null; } catch { return "unparseable"; } })(),
  versionConfigCid,
};

// ---- the publisher's own report (self-reported, not authority) --------------------------------------------------
try {
  const r = await fetch(`${PRODUCTION.publisherUrl}/api/status`, { signal: AbortSignal.timeout(20_000) });
  const s = await r.json();
  out.publisherStatus = { http: r.status, ...s };
} catch (e) { out.publisherStatus = { error: String(e.message ?? e) }; }

// ---- every reachable IPNS record, verified against the name ---------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), "prodread-kubo-"));
const env = { ...process.env, IPFS_PATH: join(repo, "kubo") };
execFileSync("ipfs", ["init", "--profile=test"], { env, stdio: "ignore" });
function inspect(bytes) {
  const j = JSON.parse(execFileSync("ipfs", ["name", "inspect", "--enc=json", "--dump=false", "--verify", PRODUCTION.name], { env, input: bytes }).toString());
  return { valid: j.Validation?.Valid === true, sequence: j.Entry?.Sequence, value: j.Entry?.Value, validity: j.Entry?.Validity, ttlSecs: Number(j.Entry?.TTL) / 1e9, signatureType: j.SignatureType, bytes: bytes.length, sha256: sha256(bytes) };
}
const sources = {
  publisher: `${PRODUCTION.publisherUrl}/routing/v1/ipns/${PRODUCTION.name}`,
  "delegated-ipfs.dev": `https://delegated-ipfs.dev/routing/v1/ipns/${PRODUCTION.name}`,
  "ipfs.io": `https://ipfs.io/ipns/${PRODUCTION.name}?format=ipns-record`,
  "dweb.link": `https://dweb.link/ipns/${PRODUCTION.name}?format=ipns-record`,
  "trustless-gateway.link": `https://trustless-gateway.link/ipns/${PRODUCTION.name}?format=ipns-record`,
  "w3s.link": `https://w3s.link/ipns/${PRODUCTION.name}?format=ipns-record`,
  "4everland.io": `https://4everland.io/ipns/${PRODUCTION.name}?format=ipns-record`,
  "ipfs.enclave.host (Enclave origin)": `https://ipfs.enclave.host/ipns/${PRODUCTION.name}?format=ipns-record`,
};
out.records = {};
for (const [k, url] of Object.entries(sources)) {
  try {
    const r = await fetch(url, { headers: { accept: "application/vnd.ipfs.ipns-record" }, signal: AbortSignal.timeout(30_000) });
    const b = Buffer.from(await r.arrayBuffer());
    out.records[k] = r.status === 200 ? { http: 200, ...inspect(b) } : { http: r.status, body: b.toString().slice(0, 120) };
  } catch (e) { out.records[k] = { error: String(e.message ?? e).slice(0, 160) }; }
}
if (argv.includes("--dht")) {
  // a fresh, empty DHT client: one more independent vantage point (read-only GET_VALUE walk)
  execFileSync("ipfs", ["config", "Routing.Type", "dhtclient"], { env });
  execFileSync("ipfs", ["config", "--json", "Addresses.API", '"/ip4/127.0.0.1/tcp/0"'], { env });
  execFileSync("ipfs", ["config", "--json", "Addresses.Gateway", "[]"], { env });
  execFileSync("ipfs", ["config", "--json", "Swarm.ConnMgr", '{"LowWater":20,"HighWater":60}'], { env });
  execFileSync("ipfs", ["config", "--json", "Bootstrap", JSON.stringify(["/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa", "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt", "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ"])], { env });
  const daemon = spawn("ipfs", ["daemon"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res) => { daemon.stdout.on("data", (x) => { if (/Daemon is ready/.test(String(x))) res(); }); setTimeout(res, 30_000); });
    await new Promise((r) => setTimeout(r, 15_000)); // let the routing table fill
    const peers = execFileSync("ipfs", ["swarm", "peers"], { env }).toString().trim().split("\n").filter(Boolean).length;
    const b = execFileSync("ipfs", ["routing", "get", `/ipns/${PRODUCTION.name}`], { env, timeout: 120_000 });
    out.records["public-dht (fresh client)"] = { peers, ...inspect(b) };
  } catch (e) { out.records["public-dht (fresh client)"] = { error: String(e.message ?? e).slice(0, 200) }; }
  finally { daemon.kill("SIGINT"); await new Promise((r) => setTimeout(r, 2000)); daemon.kill("SIGKILL"); }
}
rmSync(repo, { recursive: true, force: true });

// ---- content availability: the COMPLETE DAG (verified CAR), for the current value and any --also CID -----------
const seen = Object.values(out.records).filter((r) => r.valid);
const maxSeq = seen.reduce((a, r) => Math.max(a, Number(r.sequence)), -1);
const current = seen.find((r) => Number(r.sequence) === maxSeq)?.value ?? null;
out.summary = {
  maxObservedSequence: maxSeq, valueAtMax: current,
  distinct: [...new Set(seen.map((r) => `${r.sequence} ${r.value}`))],
  note: "a floor: records signed by any key holder and not reachable from these vantage points are not seen",
};
const cids = [current?.replace(/^\/ipfs\//, "").split("/")[0], ...(argv.includes("--also") ? [argv[argv.indexOf("--also") + 1]] : [])].filter(Boolean);
out.availability = { check: "complete DAG: ?format=car verified by scripts/site-release/car.mjs readCar (tools/ipns-release-anchor completeAt)" };
const { completeAt } = await import(join(ANCHOR, "scripts/anchor-release.mjs"));
for (const cid of cids) {
  out.availability[cid] = {};
  for (const gw of ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link", "https://w3s.link", "https://4everland.io", "https://ipfs.enclave.host"]) {
    out.availability[cid][new URL(gw).host] = await completeAt(gw, cid, { maxBytes: 512 * 1024 * 1024, timeoutMs: 120_000 });
  }
}
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
