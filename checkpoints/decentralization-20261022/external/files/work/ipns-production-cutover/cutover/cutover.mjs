#!/usr/bin/env node
// IPNS release-anchor production cutover: a plan of owner actions, and a status that says which are done and emits
// the NEXT exact UNSIGNED transaction. Nothing here signs, sends or writes anywhere but --out.
//
//   node cutover/cutover.mjs plan   --config cutover/production-cutover.json --out DIR [--delegate 0x…]
//   node cutover/cutover.mjs status --plan DIR/plan.json [--json]
//
// Safety shape:
// - every chain fact comes from one quorum-agreed block (lib/chain.mjs), judged fresh when the reads end;
// - the plan pins its preconditions (ledger/catalog/deployer code hashes, the record's owner, appRef and envelope
//   commitment, the observed IPNS sequence floor, the reviewed anchor build and publisher component);
// - the anchor is a CREATE2 deployment, so "already deployed" is a code read at the planned address, never a
//   remembered receipt; owner transactions are emitted one at a time bound to the owner's nonce at the agreed block,
//   so a lost receipt or a repeated run re-emits the SAME transaction (a replacement), never a second one;
// - activation is ONE ledger multicall (setAppRef + setConfig): the old code never sees an anchor-only config;
// - anything that moved since the plan (owner, envelope, appRef, anchor owner) blocks instead of guessing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Quorum, feeEstimate, publisherRpcIdentities, redactConfig, rpcCall, viem } from "../lib/chain.mjs";
import { ABI } from "../lib/production.mjs";
import { ANCHOR_ABI, anchorDeployment, nameHash } from "../lib/anchor-build.mjs";
import { ANCHOR, PUBLISHER_WASM, REPO, TOOL } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ws = (p) => resolve(p);                          // CLI paths: relative to the working directory
const rel = (base, p) => (isAbsolute(p) ? p : resolve(dirname(base), p)); // config paths: relative to the config file
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const GPO = "0x420000000000000000000000000000000000000F";
const GPO_ABI = viem.parseAbi(["function getL1FeeUpperBound(uint256) view returns (uint256)"]);
const LEDGER_EXTRA = viem.parseAbi(["function setAppRef(bytes32 id, string appRef)", "function multicall(bytes[] calls) returns (bytes[])"]);
const LEDGER_ABI = [...ABI.ledger, ...LEDGER_EXTRA];
// gas units measured on an anvil fork of Base (test/cutover-fork.test.mjs writes the measurement here)
const GAS_FILE = join(TOOL, "snapshots/fork-gas.json");
// fallbacks for the plan's cost estimate only; emitted transactions always carry a simulated gas limit
const DEFAULT_GAS = { deployAnchor: 1_200_000, setDelegate: 60_000, fund: 21_000, activate: 900_000, publishRelease: 80_000 };

function args() {
  const a = process.argv.slice(2), out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) { const k = a[i].slice(2); out[k] = a[i + 1] === undefined || a[i + 1].startsWith("--") ? true : a[++i]; }
    else out._.push(a[i]);
  }
  return out;
}

function assertNoInlineSecret(obj, what) {
  const s = JSON.stringify(redactConfig(obj));
  if (s.includes("INLINE VALUE PRESENT") || s.includes("long hex string")) throw new Error(`${what} carries an inline secret-like value: refusing to write it`);
}

async function artifactCid(bytes) {
  const { artifactIdentity } = await import(pathToFileURL(join(REPO, "sdk/storage/unixfs.mjs")).href);
  return artifactIdentity(new Uint8Array(bytes)).cid;
}

/** Read every IPNS record source and verify it against the name (kubo, offline). */
async function observedSequences(name, sources) {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const repo = mkdtempSync(join(tmpdir(), "cutover-kubo-"));
  const env = { ...process.env, IPFS_PATH: join(repo, "kubo") };
  execFileSync("ipfs", ["init", "--profile=test"], { env, stdio: "ignore" });
  const out = {};
  for (const base of sources) {
    const url = `${base.replace(/\/$/, "")}/routing/v1/ipns/${name}`;
    try {
      const r = await fetch(url, { headers: { accept: "application/vnd.ipfs.ipns-record" }, signal: AbortSignal.timeout(20_000) });
      if (r.status !== 200) { out[base] = { http: r.status }; continue; }
      const b = Buffer.from(await r.arrayBuffer());
      const j = JSON.parse(execFileSync("ipfs", ["name", "inspect", "--enc=json", "--dump=false", "--verify", name], { env, input: b }).toString());
      out[base] = { valid: j.Validation?.Valid === true, sequence: Number(j.Entry.Sequence), value: j.Entry.Value, validity: j.Entry.Validity };
    } catch (e) { out[base] = { error: String(e.message ?? e).slice(0, 120) }; }
  }
  rmSync(repo, { recursive: true, force: true });
  return out;
}

/**
 * Is the COMPLETE content of `cid` at each gateway? The release tool's own check (anchor-release.mjs completeAt): the
 * gateway's CAR export verified by site-release's readCar (every block hashes to its CID, all reachable from the root,
 * every file reassembles), bounded in bytes. A root block alone is never counted.
 */
async function completeAtEach(gateways, cid, maxBytes) {
  const { completeAt } = await import(pathToFileURL(join(ANCHOR, "scripts/anchor-release.mjs")).href);
  const out = {};
  for (const g of gateways) out[g] = await completeAt(g, cid, { maxBytes });
  return out;
}

// ---- plan -------------------------------------------------------------------------------------------------------

export async function plan(a) {
  const cfgFile = ws(a.config);
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
  const profile = { chainId: cfg.pins.chainId, contracts: { deployments: cfg.pins.deployments, appCatalog: cfg.pins.appCatalog } };
  const delegate = a.delegate ?? cfg.delegate.address ?? null;
  if (delegate && !/^0x[0-9a-fA-F]{40}$/.test(delegate)) throw new Error("--delegate must be an address");
  const q = new Quorum({ rpcs: cfg.rpcs, chainId: profile.chainId, quorum: cfg.quorum, confirmations: cfg.confirmations, maxBlockAgeSecs: cfg.maxBlockAgeSecs });
  await q.block();
  const C = profile.contracts;
  const pins = {};
  for (const [k, addr, want] of [["deployments", C.deployments.address, C.deployments.codeHash], ["appCatalog", C.appCatalog.address, C.appCatalog.codeHash],
    ["create2Deployer", cfg.create2Deployer, cfg.create2DeployerCodeHash]]) {
    const h = viem.keccak256(await q.code(addr));
    pins[k] = { address: addr, codeHash: want, observed: h };
    if (h !== want) throw new Error(`precondition: ${k} code hash ${h} is not the pinned ${want}`);
  }
  const d = await q.read(C.deployments.address, LEDGER_ABI, "get", [cfg.deployment]);
  const envelopeRaw = String(d.configCid ?? "");
  const envSha = sha256(Buffer.from(envelopeRaw, "utf8"));
  const pre = [];
  const must = (ok, what) => { pre.push({ check: what, ok }); if (!ok) throw new Error(`precondition failed: ${what}`); };
  must(d.owner.toLowerCase() === cfg.owner.toLowerCase(), `deployment owner is ${cfg.owner}`);
  must(d.appRef === cfg.expect.appRef, `deployment runs ${cfg.expect.appRef}`);
  must(envSha === cfg.expect.envelopeSha256, `deployment envelope commitment is ${cfg.expect.envelopeSha256}`);
  must(d.active === true, "deployment is active");
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(d.appRef);
  const appId = m[1], curIdx = Number(m[2]);
  const n = Number(await q.read(C.appCatalog.address, ABI.catalog, "numVersions", [appId]));
  const versions = await q.read(C.appCatalog.address, ABI.catalogV3, "getVersionsPage", [appId, 0n, BigInt(n)]);
  const cur = versions[curIdx];
  must(cur.cid === cfg.expect.versionCid, `the running version's component is ${cfg.expect.versionCid}`);
  const ownerNonce = await q.nonce(cfg.owner);
  const ownerBalance = await q.balance(cfg.owner);
  const delegateCode = delegate ? await q.code(delegate) : null;
  const chain = q.close();

  // the reviewed publisher component and the anchor build
  const wasmFile = a.wasm ? ws(a.wasm) : [rel(cfgFile, cfg.release.wasm), PUBLISHER_WASM].find((f) => existsSync(f)) ?? rel(cfgFile, cfg.release.wasm);
  const wasm = readFileSync(wasmFile);
  must(sha256(wasm) === cfg.release.wasmSha256, `the publisher component is the reviewed ${cfg.release.wasmSha256}`);
  const releaseCid = await artifactCid(wasm);
  const nh = nameHash(cfg.name);
  const salt = viem.keccak256(viem.toHex(`enclave.ipns-release-anchor/${cfg.deployment}/${cfg.anchor.generation}`));
  const anchor = anchorDeployment({ deployer: cfg.create2Deployer, salt, owner: cfg.owner, nameHash: nh, cid: cfg.anchor.initialCid });

  // the IPNS sequence floor and the initial CID's availability (dependencies, not authorities)
  const records = await observedSequences(cfg.name, cfg.recordSources);
  const valid = Object.values(records).filter((r) => r.valid);
  must(valid.length >= 1, "at least one IPNS record source answered a valid record");
  const maxSeq = Math.max(...valid.map((r) => r.sequence));
  const atMax = valid.filter((r) => r.sequence === maxSeq).map((r) => r.value);
  const P = cfg.publisher;
  let publisherIds = null;
  try { publisherIds = publisherRpcIdentities(P.rpcs, P.quorum); } catch (e) { must(false, `the publisher's rpcs pass its endpoint policy (${e.message})`); }
  must(true, `the publisher's rpcs are ${publisherIds.length} distinct providers (${publisherIds.join(", ")}), quorum ${P.quorum}`);
  must(P.sequenceOffset >= maxSeq + P.minSequenceMargin, `sequenceOffset ${P.sequenceOffset} >= observed max ${maxSeq} + margin ${P.minSequenceMargin}`);
  must(P.sequenceOffset + 1 <= Number.MAX_SAFE_INTEGER, "sequenceOffset is a safe integer");
  must(atMax.every((v) => v === `/ipfs/${cfg.anchor.initialCid}`), `the anchor's initial CID is what the name points at now (${atMax[0]})`);
  const maxCarBytes = cfg.maxCarBytes ?? 512 * 1024 * 1024;
  const avail = await completeAtEach(cfg.gateways, cfg.anchor.initialCid, maxCarBytes);
  const okGw = Object.values(avail).filter((x) => x === "ok").length;
  pre.push({ check: `initial CID's complete DAG (verified CAR) at >= ${cfg.minGateways} gateways (${okGw} now)`, ok: okGw >= cfg.minGateways, blocking: "activation" });

  // the publisher's new configuration: the current one, value removed, releaseAnchor added
  let curEnv;
  try { curEnv = JSON.parse(envelopeRaw); } catch { throw new Error("the deployment envelope is not JSON"); }
  if (!curEnv.config || curEnv.configCid || curEnv.guestBootstrap) throw new Error("this plan handles an inline config envelope only");
  const { value: oldValue, ...rest } = curEnv.config;
  const newConfig = {
    ...rest,
    releaseAnchor: {
      chainId: profile.chainId, contract: anchor.address.toLowerCase(), codeHash: anchor.codeHash,
      rpcs: P.rpcs, quorum: P.quorum, confirmations: P.confirmations, maxBlockAgeSecs: P.maxBlockAgeSecs,
      authorityTtlSecs: P.authorityTtlSecs, pollSecs: P.pollSecs, sequenceOffset: P.sequenceOffset, rpcTimeoutSecs: P.rpcTimeoutSecs,
    },
  };
  must(P.authorityTtlSecs <= (newConfig.lifetimeSecs ?? 172800) && P.authorityTtlSecs >= Math.max(4 * P.pollSecs, 2 * P.maxBlockAgeSecs), "authorityTtlSecs within the publisher's bounds");
  // exactly what `enclave config set` would write: the other namespaces kept in order, config replaced in place
  const next = { ...curEnv, config: newConfig };
  delete next.configCid;
  const newEnvelope = JSON.stringify(next);
  must(Buffer.byteLength(newEnvelope) <= 4096, "the new envelope fits the ledger's 4096 bytes");
  assertNoInlineSecret(curEnv, "the current envelope");
  assertNoInlineSecret(next, "the new envelope");

  // fees: live median gas price and the L1 fee oracle (an estimate, not authority)
  let gas = DEFAULT_GAS, gasSource = "defaults (no fork measurement yet)";
  try { const g = JSON.parse(readFileSync(GAS_FILE, "utf8")); gas = g.gas; gasSource = `fork-measured at Base block ${g.measuredAt.forkBlock} (snapshots/fork-gas.json)`; } catch {}
  const fee = await feeEstimate(cfg.rpcs);
  const l1 = BigInt(await (async () => {
    const r = await rpcCall(cfg.rpcs[0], "eth_call", [{ to: GPO, data: viem.encodeFunctionData({ abi: GPO_ABI, functionName: "getL1FeeUpperBound", args: [200n] }) }, "latest"]);
    return r.ok ? r.result : "0x0";
  })());
  const priority = 1_000_000n; // 0.001 gwei
  const maxFee = (fee.baseFeeWei ?? fee.gasPriceWei) * 2n + priority;
  const perRelease = BigInt(gas.publishRelease) * maxFee + l1;
  const cost = (units, bytes = 200) => BigInt(units) * maxFee + l1 * BigInt(Math.ceil(bytes / 200));

  const D = cfg.delegate;
  const out = {
    kind: "ipns-release-anchor-cutover-plan", version: 1, createdAt: new Date().toISOString(),
    config: { file: a.config, sha256: sha256(readFileSync(cfgFile)), pinsFrom: cfg.pins.source },
    chain: { chainId: profile.chainId, rpcs: cfg.rpcs, quorum: cfg.quorum, confirmations: cfg.confirmations, readAt: chain },
    pins, preconditions: pre,
    production: { deployment: cfg.deployment, publisherUrl: cfg.publisherUrl, owner: cfg.owner, ownerNonceAtPlan: ownerNonce, ownerBalanceWei: String(ownerBalance),
      appRef: d.appRef, appId, runningIndex: curIdx, runningVersion: cur.version, runningCid: cur.cid,
      envelopeSha256: envSha, envelopeBytes: Buffer.byteLength(envelopeRaw), configRedacted: redactConfig(curEnv.config), oldValue },
    ipns: { name: cfg.name, nameHash: nh, recordSources: cfg.recordSources, records, maxObservedSequence: maxSeq, valueAtMax: atMax[0],
      note: "the observed maximum is a floor: a key holder may have signed records these sources do not hold" },
    availability: { cid: cfg.anchor.initialCid, check: "complete DAG: ?format=car verified by scripts/site-release/car.mjs readCar", maxCarBytes, gateways: avail, required: cfg.minGateways },
    release: { wasm: cfg.release.wasm, wasmSha256: cfg.release.wasmSha256, cid: releaseCid, version: cfg.release.version,
      template: { memMb: Number(cur.memMb), ports: cur.ports, cpuGflops: Number(cur.cpuGflops), gpuGflops: Number(cur.gpuGflops), vramMb: Number(cur.vramMb), config: cur.config } },
    anchor: { ...anchor, owner: cfg.owner, initialCid: cfg.anchor.initialCid, generation: cfg.anchor.generation, initcode: undefined, deployCalldata: undefined, runtimeHex: undefined,
      deployCalldataSha256: sha256(Buffer.from(anchor.deployCalldata.slice(2), "hex")) },
    delegate: { address: delegate, days: D.days, fundReleases: D.fundReleases, minReleases: D.minReleases, codeAtPlan: delegateCode },
    publisher: { newConfig, newEnvelope, newEnvelopeSha256: sha256(Buffer.from(newEnvelope, "utf8")), oldEnvelope: envelopeRaw,
      mappedFirstSequence: P.sequenceOffset + 1 },
    fees: { source: gasSource, gas, gasPriceWei: String(fee.gasPriceWei), baseFeeWei: String(fee.baseFeeWei), maxFeePerGasWei: String(maxFee),
      l1FeeUpperBoundPer200BytesWei: String(l1),
      estimatesWei: {
        deployAnchor: String(cost(gas.deployAnchor, 6000)), setDelegate: String(cost(gas.setDelegate)), fund: String(cost(gas.fund)),
        activate: String(cost(gas.activate, Buffer.byteLength(newEnvelope) + 400)), perRelease: String(perRelease),
        delegateFunding: String(perRelease * BigInt(D.fundReleases)),
      } },
  };
  out.fees.estimatesWei.ownerTotal = String(["deployAnchor", "setDelegate", "fund", "activate"].reduce((s, k) => s + BigInt(out.fees.estimatesWei[k]), 0n)
    + BigInt(out.fees.estimatesWei.delegateFunding));
  // the full calldata of the deploy goes in its own file (large); the plan pins its hash
  const dir = ws(a.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "anchor-deploy-calldata.hex"), anchor.deployCalldata + "\n");
  writeFileSync(join(dir, "publisher-config.json"), JSON.stringify(newConfig, null, 2) + "\n");
  // the catalog template for the new version: the running version's, unchanged (deploy consoles pre-fill from it)
  const template = JSON.parse(cur.config || "{}");
  assertNoInlineSecret(template, "the version template");
  writeFileSync(join(dir, "version-template.json"), JSON.stringify(template, null, 2) + "\n");
  writeFileSync(join(dir, "plan.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

// ---- status: what is done, and the one next unsigned transaction ------------------------------------------------

export async function status(planFile, opts = {}) {
  const p = JSON.parse(readFileSync(planFile, "utf8"));
  const dir = dirname(planFile);
  const deployCalldata = readFileSync(join(dir, "anchor-deploy-calldata.hex"), "utf8").trim();
  if (sha256(Buffer.from(deployCalldata.slice(2), "hex")) !== p.anchor.deployCalldataSha256) throw new Error("anchor-deploy-calldata.hex does not match the plan");
  const rpcs = opts.rpcs ?? p.chain.rpcs;
  const q = new Quorum({ rpcs, chainId: p.chain.chainId, quorum: p.chain.quorum, confirmations: p.chain.confirmations, maxBlockAgeSecs: opts.maxBlockAgeSecs ?? 120 });
  await q.block();
  const L = p.pins.deployments.address, CAT = p.pins.appCatalog.address;
  const d = await q.read(L, LEDGER_ABI, "get", [p.production.deployment]);
  const envSha = sha256(Buffer.from(String(d.configCid ?? ""), "utf8"));
  const n = Number(await q.read(CAT, ABI.catalog, "numVersions", [p.production.appId]));
  const versions = await q.read(CAT, ABI.catalogV3, "getVersionsPage", [p.production.appId, 0n, BigInt(n)]);
  const anchorCode = await q.code(p.anchor.address);
  const st = anchorCode !== "0x" ? await q.read(p.anchor.address, ANCHOR_ABI, "state") : null;
  const ownerNonce = await q.nonce(p.production.owner);
  const ownerBalance = await q.balance(p.production.owner);
  const D = p.delegate.address;
  const delegateBalance = D ? await q.balance(D) : null;
  const read = q.close();
  const now = read.timestamp;
  const steps = [];
  const push = (s) => { steps.push(s); return s; };

  // 1. the reviewed component as a catalog version (CLI: upload + publishVersion by the app's publisher)
  const vi = versions.findIndex((v) => v.cid === p.release.cid);
  const v = versions[vi];
  push(vi < 0 ? { id: "publish-version", state: "pending", who: "owner (catalog publisher)", via: "enclave CLI",
      command: `enclave --independent --profile <owner profile> --profile-digest <sha256> --rpc ${rpcs.join(",")} publish <ipns-publisher.wasm sha256 ${p.release.wasmSha256}> --slug ipns-publisher --version ${p.release.version} --mem ${p.release.template.memMb} --cpu-gflops ${p.release.template.cpuGflops} --ports ${p.release.template.ports} --config-file version-template.json --storage-plan <owner storage plan> --wallet`,
      expect: `catalog app ${p.production.appId} lists a version with cid ${p.release.cid}, approval 1 (owner-published versions start Approved)` }
    : v.yanked ? { id: "publish-version", state: "blocked", detail: `version index ${vi} (cid ${v.cid}) is yanked` }
    : Number(v.approval) !== 1 ? { id: "publish-version", state: "waiting", detail: `version index ${vi} is not approved (approval ${v.approval})` }
    : { id: "publish-version", state: "done", detail: `catalog index ${vi} = ${v.version} (${v.cid})`, index: vi });

  // 2. the anchor, at its CREATE2 address
  let anchorState = "pending";
  if (anchorCode !== "0x") {
    if (viem.keccak256(anchorCode) !== p.anchor.codeHash) anchorState = "blocked";
    else if (st[1] !== p.ipns.nameHash || st[4].toLowerCase() !== p.production.owner.toLowerCase()) anchorState = "blocked";
    else anchorState = "done";
  }
  push(anchorState === "pending"
    ? { id: "deploy-anchor", state: "pending", who: "any funded account (the owner by default); the constructor fixes owner, nameHash and the initial CID",
        tx: { to: p.pins.create2Deployer.address, data: deployCalldata, value: "0x0", gas: p.fees.gas.deployAnchor },
        expect: `code at ${p.anchor.address} hashes to ${p.anchor.codeHash}; state() = (seq 1, cid ${p.anchor.initialCid}, owner ${p.production.owner})` }
    : anchorState === "blocked"
      ? { id: "deploy-anchor", state: "blocked", detail: "the code or state at the planned address is not the planned anchor (owner transferred? another build?): stop and re-plan" }
      : { id: "deploy-anchor", state: "done", detail: `seq ${st[2]}, cid ${st[3]}${st[7] ? ", RETIRED" : ""}`, anchorSeq: Number(st[2]), anchorCid: st[3], retired: st[7] });

  // 3. the delegate (bounded appointment)
  const minRemaining = 7 * 86400;
  if (anchorState !== "done") push({ id: "set-delegate", state: "waiting", detail: "needs the anchor" });
  else if (!D) push({ id: "set-delegate", state: "blocked", detail: "the owner has not chosen the CI delegate address (plan --delegate 0x…)" });
  else if (st[7]) push({ id: "set-delegate", state: "blocked", detail: "the anchor is retired" });
  else if (st[5].toLowerCase() === D.toLowerCase() && Number(st[6]) >= now + minRemaining) push({ id: "set-delegate", state: "done", detail: `until ${new Date(Number(st[6]) * 1000).toISOString()}` });
  else {
    const until = now + p.delegate.days * 86400 - 3600; // an hour of slack under the contract's 180-day cap for inclusion delay
    push({ id: "set-delegate", state: "pending", who: "owner",
      detail: st[5] === viem.zeroAddress ? "no delegate (never set, revoked, or cleared by a pin)" : `current delegate ${st[5]} until ${st[6]}`,
      tx: { to: p.anchor.address, data: viem.encodeFunctionData({ abi: ANCHOR_ABI, functionName: "setDelegate", args: [D, BigInt(until)] }), value: "0x0", gas: p.fees.gas.setDelegate },
      expect: `delegate ${D} until ${until}` });
  }

  // 4. delegate gas funds
  const per = BigInt(p.fees.estimatesWei.perRelease);
  if (!D) push({ id: "fund-delegate", state: "blocked", detail: "no delegate chosen" });
  else if (delegateBalance >= per * BigInt(p.delegate.minReleases)) push({ id: "fund-delegate", state: "done", detail: `${delegateBalance} wei (>= ${p.delegate.minReleases} releases)` });
  else {
    const want = per * BigInt(p.delegate.fundReleases) - delegateBalance;
    push({ id: "fund-delegate", state: "pending", who: "owner (or anyone)", tx: { to: D, data: "0x", value: viem.toHex(want), gas: p.fees.gas.fund },
      expect: `delegate balance >= ${per * BigInt(p.delegate.fundReleases)} wei (~${p.delegate.fundReleases} releases)` });
  }

  // 5. activation: one multicall, so old code never sees an anchor-only config
  const pv = steps[0];
  const newRef = pv.state === "done" ? `catalog://${p.production.appId}/${pv.index}` : null;
  const newEnvSha = p.publisher.newEnvelopeSha256;
  const availOk = opts.skipAvailability ? true : Object.values(await completeAtEach(opts.gateways ?? Object.keys(p.availability.gateways), p.anchor.initialCid, p.availability.maxCarBytes)).filter((x) => x === "ok").length >= p.availability.required;
  if (d.owner.toLowerCase() !== p.production.owner.toLowerCase()) push({ id: "activate", state: "blocked", detail: `the deployment's owner is now ${d.owner}` });
  else if (newRef && d.appRef === newRef && envSha === newEnvSha) push({ id: "activate", state: "done", detail: `${newRef}, envelope ${newEnvSha.slice(0, 16)}…` });
  else if (!(d.appRef === p.production.appRef && envSha === p.production.envelopeSha256))
    push({ id: "activate", state: "blocked", detail: `the record changed since the plan (appRef ${d.appRef}, envelope ${envSha.slice(0, 16)}…): re-plan from the new state` });
  else if (pv.state !== "done" || anchorState !== "done") push({ id: "activate", state: "waiting", detail: "needs the published version and the anchor" });
  else if (!availOk) push({ id: "activate", state: "blocked", detail: `the initial CID's complete DAG does not verify at ${p.availability.required} gateways (incomplete mirroring)` });
  else {
    const calls = [
      viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "setAppRef", args: [p.production.deployment, newRef] }),
      viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "setConfig", args: [p.production.deployment, p.publisher.newEnvelope] }),
    ];
    push({ id: "activate", state: "pending", who: "owner",
      tx: { to: L, data: viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "multicall", args: [calls] }), value: "0x0", gas: p.fees.gas.activate },
      equivalentCli: [`enclave upgrade ${p.production.deployment} ${p.release.version} --wallet`, `enclave config set ${p.production.deployment} --file publisher-config.json --wallet`],
      expect: `ledger.get: appRef ${newRef}, sha256(envelope) ${newEnvSha}; the host restarts the app on the new ENCLAVE_CONFIG` });
  }

  // 6. the publisher follows the anchor (off-chain reads; the publisher's word is checked against the routing copies)
  const act = steps[steps.length - 1];
  if (act.state !== "done") push({ id: "verify-publisher", state: "waiting", detail: "needs activation" });
  else {
    const mapped = p.publisher.mappedFirstSequence - 1 + Number(st[2]);
    const want = `/ipfs/${st[3]}`;
    let s = null;
    const pubUrl = opts.publisherUrl ?? p.production.publisherUrl;
    try { s = await (await fetch(`${pubUrl}/api/status`, { signal: AbortSignal.timeout(20_000) })).json(); } catch {}
    const recs = await observedSequences(p.ipns.name, opts.recordSources ?? p.ipns.recordSources);
    const valid = Object.entries(recs).filter(([, r]) => r.valid);
    const above = valid.filter(([, r]) => r.sequence > mapped);
    if (above.length) push({ id: "verify-publisher", state: "blocked", detail: `a record above the anchor's mapped sequence ${mapped} exists (${above.map(([k, r]) => `${k}: ${r.sequence} ${r.value}`).join("; ")}): ANOTHER HOLDER OF THE IPNS KEY is signing. Stop it, then raise sequenceOffset above it (re-plan) or publish anchor releases past it`, records: recs });
    else if (s?.authorityMode === "release-anchor" && s.sequence === mapped && s.value === want && valid.some(([k, r]) => k !== pubUrl && r.sequence === mapped && r.value === want))
      push({ id: "verify-publisher", state: "done", detail: `publisher and routing at sequence ${mapped} = ${want}`, records: recs });
    else push({ id: "verify-publisher", state: "waiting", detail: `publisher reports ${s?.authorityMode ?? "?"} seq ${s?.sequence ?? "?"} ${s?.value ?? ""}${s?.anchor?.lastError ? `; anchor: ${s.anchor.lastError}` : ""}; want ${mapped} ${want} (allow pollSecs + a republish)`, records: recs });
  }

  // the one next transaction, bound to the owner's nonce at the agreed block
  const nextStep = steps.find((s) => s.state === "pending" && s.tx);
  let next = nextStep ? await unsignedTx(p, rpcs, nextStep.id, nextStep.tx, ownerNonce) : null;
  if (next?.simulation?.reverts) {
    // never emit a transaction that every provider says would revert. If the LATEST state (not yet at the agreed
    // depth) already shows the step done, a signed copy was just mined: wait for confirmations instead.
    const done = await latestDone(p, rpcs, nextStep.id);
    Object.assign(nextStep, done
      ? { state: "confirming", detail: `the latest block already shows ${nextStep.id} done; re-run status after ${p.chain.confirmations} confirmations (do not re-sign)` }
      : { state: "blocked", detail: `simulation reverts at every provider: ${next.simulation.errors.join(" | ")}` });
    next = null;
  }
  const complete = steps.every((s) => s.state === "done");
  return { kind: "cutover-status", read, ownerNonce, ownerBalanceWei: String(ownerBalance), delegateBalanceWei: delegateBalance == null ? null : String(delegateBalance),
    steps, next, cliPending: steps.filter((s) => s.state === "pending" && !s.tx).map((s) => ({ step: s.id, command: s.command })),
    complete, blocked: steps.filter((s) => s.state === "blocked").map((s) => s.id) };
}

/** A non-authoritative look at the latest block (any one provider): only used to tell "just mined" from "reverts". */
async function latestDone(p, rpcs, step) {
  for (const u of rpcs) {
    const call = async (to, abi, fn, args = []) => {
      const r = await rpcCall(u, "eth_call", [{ to, data: viem.encodeFunctionData({ abi, functionName: fn, args }) }, "latest"]);
      if (!r.ok) throw new Error(r.error);
      return viem.decodeFunctionResult({ abi, functionName: fn, data: r.result });
    };
    try {
      if (step === "deploy-anchor") {
        const c = await rpcCall(u, "eth_getCode", [p.anchor.address, "latest"]);
        if (c.ok) return c.result !== "0x" && viem.keccak256(c.result) === p.anchor.codeHash;
      } else if (step === "set-delegate") {
        const st = await call(p.anchor.address, ANCHOR_ABI, "state");
        return st[5].toLowerCase() === String(p.delegate.address).toLowerCase();
      } else if (step === "activate") {
        const d = await call(p.pins.deployments.address, LEDGER_ABI, "get", [p.production.deployment]);
        return sha256(Buffer.from(String(d.configCid ?? ""), "utf8")) === p.publisher.newEnvelopeSha256;
      } else return false;
    } catch {}
  }
  return false;
}

async function unsignedTx(p, rpcs, step, tx, nonce) {
  const fee = await feeEstimate(rpcs);
  const base = fee.baseFeeWei ?? fee.gasPriceWei;
  // simulate at every provider (read-only eth_estimateGas from the owner): the gas limit is the highest estimate
  // x 1.3; a transaction no provider can simulate is not emitted
  const estimates = [], errors = [];
  for (const u of rpcs) {
    const r = await rpcCall(u, "eth_estimateGas", [{ from: p.production.owner, to: tx.to, data: tx.data, value: tx.value }]);
    if (r.ok) estimates.push(Number(BigInt(r.result))); else errors.push(`${new URL(u).host}: ${r.error}`);
  }
  if (!estimates.length) return { step, simulation: { reverts: true, errors } };
  const gas = Math.ceil(Math.max(...estimates) * 1.3);
  return { step, simulation: { estimates, errors },
    unsigned: { type: "0x2", chainId: viem.toHex(p.chain.chainId), from: p.production.owner, to: tx.to, value: tx.value,
      data: tx.data, nonce: viem.toHex(nonce), gas: viem.toHex(gas),
      maxFeePerGas: viem.toHex(base * 2n + 1_000_000n), maxPriorityFeePerGas: viem.toHex(1_000_000n) },
    note: "nonce = the owner's at the agreed block: if a signed copy may be pending, re-signing this nonce replaces it, never adds a second transaction" };
}

/**
 * Rollback: restore the planned-from appRef and envelope in one multicall. Only from the plan's activated state (or a
 * half state that still carries the plan's new envelope); anything else blocks. The old code then recovers the
 * anchor-era sequence from its delegates and signs max+1 when its `value` differs, so the name follows it again.
 */
export async function rollback(planFile, opts = {}) {
  const p = JSON.parse(readFileSync(planFile, "utf8"));
  const rpcs = opts.rpcs ?? p.chain.rpcs;
  const q = new Quorum({ rpcs, chainId: p.chain.chainId, quorum: p.chain.quorum, confirmations: p.chain.confirmations, maxBlockAgeSecs: opts.maxBlockAgeSecs ?? 120 });
  await q.block();
  const L = p.pins.deployments.address;
  const d = await q.read(L, LEDGER_ABI, "get", [p.production.deployment]);
  const envSha = sha256(Buffer.from(String(d.configCid ?? ""), "utf8"));
  const nonce = await q.nonce(p.production.owner);
  const read = q.close();
  if (d.appRef === p.production.appRef && envSha === p.production.envelopeSha256) return { state: "done", detail: "the record already holds the pre-cutover appRef and envelope", read };
  if (envSha !== p.publisher.newEnvelopeSha256) return { state: "blocked", detail: `the envelope (${envSha.slice(0, 16)}…) is neither the plan's old nor its new one: decide by hand`, read };
  const calls = [
    viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "setAppRef", args: [p.production.deployment, p.production.appRef] }),
    viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "setConfig", args: [p.production.deployment, p.publisher.oldEnvelope] }),
  ];
  const tx = { to: L, data: viem.encodeFunctionData({ abi: LEDGER_ABI, functionName: "multicall", args: [calls] }), value: "0x0", gas: p.fees.gas.activate };
  return { state: "pending", read, next: await unsignedTx(p, rpcs, "rollback", tx, nonce),
    expect: `ledger.get: appRef ${p.production.appRef}, sha256(envelope) ${p.production.envelopeSha256}`,
    also: "to stop delegate releases as well: setDelegate(0, 0) on the anchor (owner, reversible); the anchor stays, owned and unused. Never retire it: that is irreversible and no rollback needs it" };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args();
  const cmd = a._[0];
  try {
    if (cmd === "plan") {
      const r = await plan(a);
      console.log(JSON.stringify({ plan: join(a.out, "plan.json"), anchor: r.anchor.address, codeHash: r.anchor.codeHash, releaseCid: r.release.cid,
        maxObservedSequence: r.ipns.maxObservedSequence, mappedFirstSequence: r.publisher.mappedFirstSequence, preconditions: r.preconditions, fees: r.fees.estimatesWei }, null, 2));
    } else if (cmd === "status") {
      const r = await status(ws(a.plan));
      if (a.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const s of r.steps) console.log(`${s.state.padEnd(8)} ${s.id.padEnd(17)} ${s.detail ?? s.expect ?? ""}`);
        for (const c of r.cliPending) console.log(`CLI (owner): ${c.step}: ${c.command}`);
        console.log(r.complete ? "COMPLETE" : r.next ? `NEXT: ${r.next.step} (unsigned, nonce ${Number(r.next.unsigned.nonce)}):\n${JSON.stringify(r.next.unsigned, null, 2)}` : "no transaction to sign now");
      }
      process.exit(r.complete ? 0 : r.blocked.length ? 20 : 10);
    } else if (cmd === "rollback") {
      const r = await rollback(ws(a.plan));
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.state === "done" ? 0 : r.state === "blocked" ? 20 : 10);
    } else throw new Error("usage: cutover.mjs plan --config FILE --out DIR [--delegate 0x…] | status --plan FILE [--json] | rollback --plan FILE");
  } catch (e) {
    console.error(`cutover: ${e.message}`);
    process.exit(1);
  }
}
