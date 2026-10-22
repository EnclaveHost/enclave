// cli/wallet-handoff/release-adapter.mjs -- the reviewed adapter release as two sequential wallet-handoff steps:
//   publish: EnclaveAppCatalog.publishVersion(1.0.18) from the app's publisher (who is also the catalog owner, so the
//            version is Approved by that same transaction);
//   upgrade: EnclaveDeployments.multicall([setAppRef(id, …/18), setConfig(id, newConfig)]) from the deployment owner.
// The prepared publication.json / upgrade.json are EXPECTATIONS, never authority: every check re-reads the pinned
// contracts at ONE agreed block (QuorumChain.snapshot), re-derives the calldata from that state, and offers a step only
// when the derived bytes equal the reviewed bytes exactly. A request is never accepted because its JSON exists.
// The ledger does not parse catalog refs, so the upgrade is offered only after the catalog itself shows the exact
// version, CID, resources, ports, config and fee at index 18, Approved and not yanked, in an active app.
import crypto from "node:crypto";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256 } from "viem";
import { artifactIdentity } from "../../sdk/storage/unixfs.mjs";

export class PlanError extends Error { constructor(m) { super(m); this.name = "PlanError"; } }
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const canon = (v) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x);
const APPROVED = 1;
const need = (ok, why) => { if (!ok) throw new PlanError(`the prepared release does not hold together: ${why}`); };

/** Paths (a.b.c) whose values differ between two JSON values; arrays and scalars compare whole. */
export function jsonDiff(a, b, at = "") {
  const obj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (!obj(a) || !obj(b)) return canon(a) === canon(b) ? [] : [at];
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...jsonDiff(a[k], b[k], at ? `${at}.${k}` : k));
  return out;
}
const pathGet = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

/**
 * -> { id, from, chainId, steps: [publish, upgrade], summary }. Throws PlanError when the inputs disagree with each
 * other or with the artifact bytes. Each step: { id, title, effects(facts), links, check(chain) -> verdict } where
 * verdict = { state: "done" | "ready" | "blocked", reason?, block, facts, tx?: { to, data, value } }.
 */
export function adapterReleasePlan({ publication, upgrade, profile, artifact, catalogAbi, ledgerAbi, sourceRepo = "https://github.com/EnclaveHost/enclave-apps", artifactOrigins = [] }) {
  need(publication?.status === "prepared-not-signed" && upgrade?.status === "prepared-not-signed", "both requests must be prepared-not-signed");
  const chainId = Number(publication.chainId);
  need(chainId === Number(upgrade.chainId), "chain ids differ");
  const from = getAddress(publication.transaction.from);
  need(same(upgrade.transaction.from, from), "the two requests are for different accounts");
  const catalog = getAddress(profile.contracts.appCatalog.address), ledger = getAddress(profile.contracts.deployments.address);
  const catalogCodeHash = profile.contracts.appCatalog.codeHash, ledgerCodeHash = profile.contracts.deployments.codeHash;
  need(same(publication.transaction.to, catalog) && same(publication.catalogCodeHash, catalogCodeHash), "publication is not for the pinned catalog code");
  need(same(upgrade.transaction.to, ledger) && same(upgrade.ledgerCodeHash, ledgerCodeHash), "upgrade is not for the pinned ledger code");
  need(BigInt(publication.transaction.value) === 0n && BigInt(upgrade.transaction.value) === 0n, "a value transfer is not part of this release");

  const pub = decodeFunctionData({ abi: catalogAbi, data: publication.transaction.data });
  need(pub.functionName === "publishVersion", "publication calldata is not publishVersion");
  const [slug, , , version, cid, res, ports, config, fee] = pub.args;
  need(version === publication.version && version === upgrade.version, "version labels differ");
  need(cid === publication.artifact.cid && cid === upgrade.artifact.cid, "artifact CIDs differ");
  const id = artifactIdentity(artifact);
  need(id.cid === cid && id.sha256 === publication.artifact.sha256 && id.bytes === publication.artifact.bytes, "the artifact bytes given here are not the reviewed artifact");
  const appId = publication.appId, index = Number(publication.index);
  need(Number.isSafeInteger(index) && index > 0, "bad index");

  const mc = decodeFunctionData({ abi: ledgerAbi, data: upgrade.transaction.data });
  need(mc.functionName === "multicall" && mc.args[0].length === 2, "upgrade calldata is not a two-call multicall");
  const [c0, c1] = mc.args[0].map((d) => decodeFunctionData({ abi: ledgerAbi, data: d }));
  const deployment = upgrade.deployment;
  const oldRef = `catalog://${appId}/${index - 1}`, newRef = `catalog://${appId}/${index}`;
  need(c0.functionName === "setAppRef" && c0.args[0] === deployment && c0.args[1] === newRef && upgrade.newAppRef === newRef && upgrade.oldAppRef === oldRef, "setAppRef is not the reviewed version switch");
  need(c1.functionName === "setConfig" && c1.args[0] === deployment, "setConfig is not for the deployment");
  const newConfig = c1.args[1];
  need(sha256(newConfig) === upgrade.newConfigSha256 && Buffer.byteLength(newConfig) === upgrade.newConfigBytes, "the new config is not the reviewed one");
  const changed = Object.keys(upgrade.changedConfigFields || {}).sort();
  need(changed.length > 0, "no changed config fields were reviewed");

  const label = `${deployment.slice(2, 10)}.app.enclave.host`;
  const links = [
    ...artifactOrigins.map((o) => ({ text: `artifact bytes (${new URL(o).host})`, href: `${o.replace(/\/$/, "")}/ipfs/${cid}` })),
    { text: `adapter source at commit ${String(publication.sourceCommit).slice(0, 12)}`, href: `${sourceRepo}/tree/${publication.sourceCommit}/${slug}` },
  ];
  const artifactFacts = { cid, sha256: id.sha256, bytes: id.bytes, sourceCommit: publication.sourceCommit };

  /** Everything both steps look at, read by every quorum peer at ONE agreed block. */
  async function read(chain) {
    if (Number(chain.chainId) !== chainId) throw new PlanError(`the quorum is chain ${chain.chainId}, the release is for chain ${chainId}`);
    const s = await chain.snapshot(async (c, blockNumber) => {
      const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args, blockNumber });
      const [cc, lc] = await Promise.all([c.getCode({ address: catalog, blockNumber }), c.getCode({ address: ledger, blockNumber })]);
      const owner = await rd(catalog, catalogAbi, "owner");
      const app = await rd(catalog, catalogAbi, "getApp", [appId]);
      const n = Number(app.versionCount);
      const at = async (i) => (n > i ? { v: await rd(catalog, catalogAbi, "getVersion", [appId, BigInt(i)]), fee: await rd(catalog, catalogAbi, "versionFee", [appId, BigInt(i)]) } : null);
      const [prev, target] = [await at(index - 1), await at(index)];
      const record = await rd(ledger, ledgerAbi, "get", [deployment]);
      return { catalogCode: cc ? keccak256(cc) : null, ledgerCode: lc ? keccak256(lc) : null, owner, app, n, prev, target, record };
    });
    return { ...s.value, block: { number: s.blockNumber, hash: s.blockHash, agreeing: s.agreeing, peers: s.peers } };
  }
  const blocked = (r, reason, facts = {}) => ({ state: "blocked", reason, block: r.block, facts });
  const pinsOk = (r) => r.catalogCode === catalogCodeHash ? (r.ledgerCode === ledgerCodeHash ? null : `the ledger at ${ledger} does not carry the pinned code (${r.ledgerCode || "no code"})`)
    : `the catalog at ${catalog} does not carry the pinned code (${r.catalogCode || "no code"})`;
  /** The published index matches the reviewed publishVersion arguments in every field. */
  const targetDiffs = (t) => {
    const d = [];
    if (t.v.version !== version) d.push(`version ${t.v.version}`);
    if (t.v.cid !== cid) d.push(`cid ${t.v.cid}`);
    if (canon([t.v.vramMb, t.v.gpuGflops, t.v.memMb, t.v.cpuGflops]) !== canon(res)) d.push("resources");
    if (t.v.ports !== ports) d.push("ports");
    if (t.v.config !== config) d.push("catalog config");
    if (BigInt(t.fee) !== BigInt(fee)) d.push(`fee ${t.fee}`);
    return d;
  };

  const publish = {
    id: "publish",
    title: `Publish adapter ${version} to the app catalog`,
    links,
    effects: () => [
      `Publishes ${slug} version ${version} as index ${index} of the Enclave app catalog (${catalog}), after ${publication.previousVersion}.`,
      `The published program is exactly ${id.bytes.toLocaleString("en-US")} bytes with sha256 ${id.sha256} (CID ${cid}), built from source commit ${publication.sourceCommit}.`,
      "Your account owns the catalog, so this same transaction also approves the version.",
      "Resources, ports, the catalog's default config and the per-second fee are copied unchanged from the current version; the default config keeps generic file uploads off.",
      `It does not change any running deployment; ${label} keeps running ${publication.previousVersion} until the separate upgrade step.`,
      "It sends no ETH; you pay only the network fee.",
    ],
    async check(chain) {
      const r = await read(chain);
      const facts = { versionCount: r.n, catalogOwner: r.owner, artifact: artifactFacts };
      const pin = pinsOk(r); if (pin) return blocked(r, pin, facts);
      if (!same(r.owner, from)) return blocked(r, `the catalog owner is ${r.owner}, not ${from}: the version would land Pending, not Approved`, facts);
      if (!same(r.app.publisher, from)) return blocked(r, `app ${appId} is published by ${r.app.publisher}, not ${from}`, facts);
      if (r.target) {
        const d = targetDiffs(r.target);
        if (d.length) return blocked(r, `catalog index ${index} already holds a different release (${d.join(", ")})`, facts);
        if (r.target.v.approval !== APPROVED || r.target.v.yanked) return blocked(r, `index ${index} is published but ${r.target.v.yanked ? "yanked" : `not approved (approval ${r.target.v.approval})`}`, facts);
        return { state: "done", block: r.block, facts };
      }
      if (r.n !== index) return blocked(r, `the catalog lists ${r.n} versions of this app; the reviewed request publishes index ${index}`, facts);
      if (r.prev.v.version !== publication.previousVersion) return blocked(r, `the latest version is ${r.prev.v.version}, not ${publication.previousVersion}`, facts);
      const args = [r.app.slug, r.app.name, r.app.description, version, cid,
        [r.prev.v.vramMb, r.prev.v.gpuGflops, r.prev.v.memMb, r.prev.v.cpuGflops], r.prev.v.ports, r.prev.v.config, r.prev.fee];
      const data = encodeFunctionData({ abi: catalogAbi, functionName: "publishVersion", args });
      if (data !== publication.transaction.data) {
        const names = ["slug", "name", "description", "version", "cid", "resources", "ports", "config", "fee"];
        const d = names.filter((_n, i) => canon(args[i]) !== canon(pub.args[i]));
        return blocked(r, `the catalog changed since review (${d.join(", ") || "encoding"}); regenerate and review publication.json`, facts);
      }
      return { state: "ready", block: r.block, facts, tx: { to: catalog, data, value: 0n } };
    },
  };

  const upgradeStep = {
    id: "upgrade",
    title: `Switch ${label} to ${version} with the reviewed configuration`,
    links,
    effects: (facts) => [
      `Moves deployment ${deployment} (${label}) from catalog version ${index - 1} (${publication.previousVersion}) to version ${index} (${version}) and replaces its configuration, both in one transaction.`,
      ...(facts?.configChanges || []).map((c) => `Config ${c.path}: ${c.before === undefined ? "not set" : JSON.stringify(c.before)} → ${JSON.stringify(c.after)}.`),
      "Every other configuration field stays exactly as it is now (checked field by field against the agreed chain state). Upload budgets, storage, CORS origins and routing are unchanged.",
      "It does not change the deployment's balance, shares, owner or active flag, and it sends no ETH; you pay only the network fee.",
    ],
    async check(chain) {
      const r = await read(chain);
      const rec = r.record;
      const facts = { versionCount: r.n, appRef: rec.appRef, active: rec.active, owner: rec.owner, configSha256: sha256(rec.configCid), artifact: artifactFacts };
      const pin = pinsOk(r); if (pin) return blocked(r, pin, facts);
      if (!r.target) return blocked(r, `catalog index ${index} (${version}) is not published at agreed block ${r.block.number}: the upgrade waits for the confirmed publication`, facts);
      const d = targetDiffs(r.target);
      if (d.length) return blocked(r, `catalog index ${index} is not the reviewed release (${d.join(", ")})`, facts);
      if (r.target.v.approval !== APPROVED || r.target.v.yanked || !r.app.active) return blocked(r, `catalog index ${index} is not deployable (approval ${r.target.v.approval}, yanked ${r.target.v.yanked}, app active ${r.app.active})`, facts);
      if (!same(rec.owner, from)) return blocked(r, `deployment ${deployment} is owned by ${rec.owner}, not ${from}`, facts);
      if (!rec.active) return blocked(r, "the deployment is not active", facts);
      if (rec.appRef === newRef && rec.configCid === newConfig) return { state: "done", block: r.block, facts };
      if (rec.appRef !== oldRef) return blocked(r, `the deployment runs ${rec.appRef}, not the reviewed ${oldRef}`, facts);
      if (sha256(rec.configCid) !== upgrade.oldConfigSha256) return blocked(r, "the deployment's configuration changed since review; regenerate and review upgrade.json", facts);
      let before, after;
      try { before = JSON.parse(rec.configCid); after = JSON.parse(newConfig); } catch { return blocked(r, "a configuration is not JSON", facts); }
      const diff = jsonDiff(before, after).sort();
      if (canon(diff) !== canon(changed)) return blocked(r, `the new configuration changes ${diff.join(", ") || "nothing"}, not exactly the reviewed ${changed.join(", ")}`, facts);
      for (const p of changed) {
        const want = upgrade.changedConfigFields[p];
        const wantAfter = want && typeof want === "object" && "after" in want && Object.keys(want).every((k) => k === "before" || k === "after") ? want.after : want;
        if (canon(pathGet(after, p)) !== canon(wantAfter)) return blocked(r, `${p} is not the reviewed value`, facts);
      }
      if (!same(before.config?.upload?.walletAudience, deployment) || !before.config?.upload?.allowOrigins?.includes("https://enclave.host"))
        return blocked(r, "the deployment lacks the reviewed upload audience or dashboard origin", facts);
      const data = encodeFunctionData({ abi: ledgerAbi, functionName: "multicall", args: [[
        encodeFunctionData({ abi: ledgerAbi, functionName: "setAppRef", args: [deployment, newRef] }),
        encodeFunctionData({ abi: ledgerAbi, functionName: "setConfig", args: [deployment, newConfig] })]] });
      if (data !== upgrade.transaction.data) return blocked(r, "the re-derived upgrade calldata differs from the reviewed bytes", facts);
      facts.configChanges = changed.map((p) => ({ path: p, before: pathGet(before, p), after: pathGet(after, p) }));
      return { state: "ready", block: r.block, facts, tx: { to: ledger, data, value: 0n } };
    },
  };

  return { id: `adapter-${version}`, from, chainId, steps: [publish, upgradeStep],
    summary: { app: slug, appId, version, previousVersion: publication.previousVersion, deployment, label, catalog, ledger, artifact: artifactFacts } };
}
