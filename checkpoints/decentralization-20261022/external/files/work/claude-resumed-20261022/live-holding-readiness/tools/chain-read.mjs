// chain-read.mjs: READ-ONLY Base reads (2-of-3 public RPC agreement at head-2, the pattern of the reviewed
// work/ens-outage-20261022/reserve-after-deposit.mjs) for the s3-ipfs-adapter deployment 0x7ae476a3 and the ipns-publisher
// deployment 0xd9798e4c: ledger record (owner, active, appRef, lease, runner), the catalog version their appRef names
// (wasm CID, label, memMb, approval), the app-funded lease-gas reserve vs a renew quote, and their deployment config
// SHAPE ONLY: key names, whether secret-bearing fields are $NAME references (booleans), and the non-secret routing fields
// needed for a hold (adapter prefix/maxKeys/refreshSecs/endpoint host; publisher value and ipni URLs). No secret value is
// printed or written. No transaction, signature or write of any kind.
// Run from the repository work root's parent: node work/claude-resumed-20261022/live-holding-readiness/tools/chain-read.mjs OUT.json
import fs from "node:fs";
const W = "/home/steven/Documents/Codex/2026-10-18/wo/work";
const { createPublicClient, http, keccak256 } = await import(`${W}/enclave/node_modules/viem/_esm/index.js`);
const { base } = await import(`${W}/enclave/node_modules/viem/_esm/chains/index.js`);
const { OWNER_ABI, LEDGER_ABI } = await import(`${W}/enclave/network/lease-gas-owner.mjs`);
const { quote } = await import(`${W}/enclave/client/lease-executor-client.mjs`);
const CATALOG_ABI = JSON.parse(fs.readFileSync(`${W}/enclave/contracts/EnclaveAppCatalog.abi.json`, "utf8"));
const dep = JSON.parse(fs.readFileSync(`${W}/../outputs/app-lease-gas-review/lease-gas-deployment.json`, "utf8"));
const CATALOG = "0x18419CA2b502D423A8de6269AEeE171a378626e3";   // operations-plan.json contracts.catalog (address book appCatalog at its probe)
const IDS = { adapter: "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", publisher: "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a" };
const KNOWN_WASM = {   // upload CIDs recorded in reviewed packages (kubo-identical importFile)
  "bafybeia5dmbhfmpgjhu45fgwu4me2k5ucfr23ssuz24ugrlzm46jywlevq": "adapter 132ba32f (50f93d74, 0.5.6 wallet uploads; adapter-contract-wallet-cas/entry.json)",
  "bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii": "publisher catalog v5 (deployed 1.0.5, 59a1cec5; composed-release review)",
  "bafybeia2ymbg45dgh3sr3nqkxeumv3ayanfwtw6y5adj7tlg3ho33553fu": "publisher 1.0.6 eaa49323 (composed-release, unpublished at review)" };
const OUT = process.argv[2];
const REF = /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const isRef = (v) => typeof v === "string" && REF.test(v);
const host = (u) => { try { return new URL(u).host; } catch { return null; } };

function shape(kind, cfg) {
  if (!cfg || typeof cfg !== "object") return { config: "absent" };
  const s = { keys: Object.keys(cfg).sort() };
  if (kind === "adapter") {
    s.endpointHost = host(cfg.endpoint); s.prefix = typeof cfg.prefix === "string" ? cfg.prefix : null;
    s.maxKeys = cfg.maxKeys ?? "default 50000"; s.refreshSecs = cfg.refreshSecs ?? "default 300";
    s.apiKeyPresent = Object.hasOwn(cfg, "api_key"); s.apiKeyIsRef = isRef(cfg.api_key);
    s.credentialsAreRefs = cfg.credentials && typeof cfg.credentials === "object" ? Object.fromEntries(Object.entries(cfg.credentials).map(([k, v]) => [k, isRef(v)])) : null;
    if (cfg.upload && typeof cfg.upload === "object") s.upload = { keys: Object.keys(cfg.upload).sort(), uploadKeyIsRef: cfg.upload.uploadKey === undefined ? null : isRef(cfg.upload.uploadKey),
      walletAudienceIsSelf: typeof cfg.upload.walletAudience === "string" ? cfg.upload.walletAudience.toLowerCase() === IDS.adapter : null, allowUnsigned: cfg.upload.allowUnsigned ?? false };
  } else {
    s.value = typeof cfg.value === "string" ? cfg.value : null;
    s.ipnsKeyIsRef = isRef(cfg.ipnsKey); s.apiKeyPresent = Object.hasOwn(cfg, "api_key"); s.apiKeyIsRef = isRef(cfg.api_key);
    if (cfg.ipni && typeof cfg.ipni === "object") s.ipni = { gatewayUrl: cfg.ipni.gatewayUrl ?? null, publisherUrl: cfg.ipni.publisherUrl ?? null, indexers: cfg.ipni.indexers ?? null, announceAllBlocks: cfg.ipni.announceAllBlocks ?? null };
  }
  return s;
}

const urls = ["https://mainnet.base.org", "https://base-rpc.polkachu.com", "https://base-rpc.publicnode.com"];
const clients = urls.map((u) => createPublicClient({ chain: base, transport: http(u, { retryCount: 0, timeout: 10000 }) }));
const heads = await Promise.allSettled(clients.map(async (c) => { if ((await c.getChainId()) !== 8453) throw Error("chain mismatch"); return c.getBlockNumber(); }));
const live = heads.flatMap((h, i) => (h.status === "fulfilled" ? [{ i, head: h.value }] : []));
if (live.length < 2) throw Error("need two RPCs");
const blockNumber = live.reduce((n, x) => (x.head < n ? x.head : n), live[0].head) - 2n;
const xs = await Promise.allSettled(live.map(async ({ i }) => {
  const c = clients[i], b = await c.getBlock({ blockNumber }), at = { blockNumber };
  if (keccak256(await c.getCode({ address: dep.reserve, blockNumber })) !== dep.reserveCodeHash) throw Error("reserve code changed");
  const fixed = { readContract: (x) => c.readContract({ ...x, blockNumber }) };
  const renewQuote = await quote({ client: fixed, reserve: dep.reserve, kind: "renew", gasPrice: (b.baseFeePerGas ?? 0n) + 1000000n });
  const rows = {};
  for (const [kind, id] of Object.entries(IDS)) {
    const d = await c.readContract({ ...at, address: dep.ledger, abi: LEDGER_ABI, functionName: "get", args: [id] });
    let opts = null; try { opts = JSON.parse(d.configCid); } catch {}
    const r = await c.readContract({ ...at, address: dep.reserve, abi: OWNER_ABI, functionName: "reserveOf", args: [id, d.owner] });
    const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(d.appRef), row = { owner: d.owner, active: d.active, appRef: d.appRef, leaseUntil: d.leaseUntil,
      leaseRemainingSec: Number(d.leaseUntil) - Number(b.timestamp), runner: d.runner, runnerOperator: d.runnerOperator, rate: d.rate,
      configSource: opts ? "inline envelope" : (d.configCid ? "cid or other" : "none"), config: shape(kind, opts?.config),
      reserve: { enabled: r.enabled, balanceWei: r.balanceWei, renewQuoteWei: renewQuote, renewsAffordable: r.balanceWei / renewQuote } };
    if (m) {
      const [appId, idx] = [m[1], BigInt(m[2])];
      const v = await c.readContract({ ...at, address: CATALOG, abi: CATALOG_ABI, functionName: "getVersion", args: [appId, idx] });
      const n = await c.readContract({ ...at, address: CATALOG, abi: CATALOG_ABI, functionName: "numVersions", args: [appId] });
      const pick = (o, k) => (o && typeof o === "object" ? o[k] : undefined);
      row.catalogVersion = { numVersions: n, version: pick(v, "version"), cid: pick(v, "cid"), memMb: pick(v, "memMb"), approval: pick(v, "approval"), yanked: pick(v, "yanked"),
        known: KNOWN_WASM[pick(v, "cid")] ?? "not a CID recorded in the reviewed packages" };
    }
    rows[kind] = row;
  }
  return { url: urls[i], blockHash: b.hash, timestamp: b.timestamp, rows };
}));
const str = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? String(v) : v), 1);
const out = { at: new Date().toISOString(), block: String(blockNumber), catalog: CATALOG, ledger: dep.ledger, reserve: dep.reserve,
  results: xs.map((x, i) => (x.status === "fulfilled" ? x.value : { url: urls[live[i].i], error: String(x.reason?.message).slice(0, 250) })) };
const groups = new Map();
for (const x of out.results) { if (x.error) continue; const { url, ...v } = x; const k = str(v); groups.set(k, [...(groups.get(k) || []), url]); }
out.agreeing = Math.max(0, ...[...groups.values()].map((v) => v.length));
fs.writeFileSync(OUT, str(out) + "\n");
console.log(str({ block: out.block, agreeing: out.agreeing, snapshot: out.results.find((r) => !r.error)?.rows, errors: out.results.filter((r) => r.error) }));
if (out.agreeing < 2) process.exitCode = 2;
