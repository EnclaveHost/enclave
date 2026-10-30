#!/usr/bin/env node
// production-activation-prep-r1 PREPARER. UNREVIEWED, NOT RUN by its author. Root runs it offline after review:
//   node production-activation-prep-r1/prepare-activation.mjs --pins <PINS.json> --out <absolute new directory>
//
// Builds, from PUBLIC data only, the three production activation files the staged relay loader consumes:
//   owner-controls.json  enclave-funding-owner-controls-r1   (SESSIONS_FUNDING_OWNER_MANIFEST)
//   intake-manifest.json enclave-funding-activation-r1       (SESSIONS_FUNDING_MANIFEST)      only with an intake decision
//   fee-policy.json      enclave-gasfund-fee-policy-r1       (SESSIONS_FUNDING_FEE_POLICY)    only with an intake decision
// plus PREPARED.json (hashes and facts; status PREPARED_NOT_APPROVED). It is not an approval or authorization: it never
// writes pins, decisions or env, never signs or sends, has no clock override, makes no network request and reads no
// key, env value, journal or private file. Every input file is sha256-pinned (lib/context.mjs). Refuses on: a missing
// decision; a stale, single-provider, loopback or disagreeing observation; any binding that differs from the confirmed
// receipts, the reviewed proposal, the original relay config or the decided implementation; a predicted-only address;
// a development relayer; a non-quiescent relay nonce; a gas cap below the measured execute; a fee cap that cannot pay the
// observed base fee; an unlisted change from the reviewed fee observation; fee identity drift; and anything the tested
// parsers (parseOwnerControlsManifest, parseFundingManifest, parseFeePolicyConfig) or the actual loader
// (loadFundingActivation, run offline over the written files) refuse.
import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID, K, checksum, collectBindings, isAddr, lower, refuse } from "./lib/bindings.mjs";
import { loadContext, sha } from "./lib/context.mjs";

export const OBSERVATION_SCHEMA = "enclave-funding-production-observation-r1";
export const MAX_OBSERVATION_AGE_SEC = 900;       // the capture must be at most 15 minutes old when prepared
export const MAX_BLOCK_LAG_SEC = 300;             // the pinned block at most 5 minutes older than the capture
export const MIN_VALIDITY_SEC = 600;              // a notAfter must leave at least 10 minutes
export const MAX_VALIDITY_SEC = 30 * 86_400;      // ... and at most 30 days
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

/** Every provider: https, public host, chain 8453, the SAME block; >= 2 distinct hosts; fresh. Returns a reader. */
export function observationReader(o, now) {
  if (o?.schema !== OBSERVATION_SCHEMA || o.readOnly !== true) refuse("observation", `the observation must be a read-only ${OBSERVATION_SCHEMA}`);
  const at = Number(o.capturedAt);
  if (!Number.isSafeInteger(at)) refuse("observation", "observation.capturedAt must be a unix time");
  if (at > now + 60) refuse("observation_future", "the observation is from the future");
  if (now - at > MAX_OBSERVATION_AGE_SEC) refuse("observation_stale", `the observation is ${now - at}s old (max ${MAX_OBSERVATION_AGE_SEC}); capture it again`);
  const P = Array.isArray(o.providers) ? o.providers : [];
  const hosts = new Set();
  for (const p of P) {
    let u;
    try { u = new URL(p.url); } catch { refuse("provider", `provider URL ${p?.url} is not a URL`); }
    if (u.protocol !== "https:" || PRIVATE_HOST.test(u.hostname) || u.username || u.password) refuse("provider", `provider ${u.hostname} must be a public https RPC without credentials`);
    if (Number(p.chainId) !== CHAIN_ID) refuse("chain_mismatch", `provider ${u.hostname} serves chain ${p.chainId}`);
    hosts.add(u.hostname.toLowerCase());
  }
  if (P.length < 2 || hosts.size !== P.length) refuse("providers", "at least two providers on distinct hosts are required");
  const b0 = P[0].block ?? {};
  for (const p of P) {
    const b = p.block ?? {};
    for (const k of ["number", "hash", "timestamp", "baseFeePerGas"]) {
      if (String(b[k] ?? "") === "" || lower(b[k]) !== lower(b0[k])) refuse("provider_disagreement", `providers disagree on the pinned block ${k}`);
    }
  }
  if (!/^0x[0-9a-f]{64}$/.test(lower(b0.hash)) || !/^\d+$/.test(String(b0.number)) || !/^\d+$/.test(String(b0.baseFeePerGas))) refuse("observation", "malformed pinned block");
  const lag = at - Number(b0.timestamp);
  if (lag < 0 || lag > MAX_BLOCK_LAG_SEC) refuse("observation_stale", `the pinned block is ${lag}s older than the capture (max ${MAX_BLOCK_LAG_SEC})`);
  const get = (key) => {
    const vs = P.map((p) => p.reads?.[key]);
    if (vs.some((v) => typeof v !== "string")) refuse("read_missing", `${key} was not observed by every provider`);
    if (vs.some((v) => lower(v) !== lower(vs[0]))) refuse("provider_disagreement", `providers disagree on ${key}`);
    return vs[0];
  };
  return {
    block: Object.freeze({ number: String(b0.number), hash: lower(b0.hash), timestamp: String(b0.timestamp), baseFeePerGas: String(b0.baseFeePerGas) }),
    providers: [...hosts],
    reader: { code: async (a) => get(K.code(a)), call: async (a, fn, args) => get(K.call(a, fn, args)), storage: async (a, s) => get(K.storage(a, s)),
      nonce: async (a, tag) => get(K.nonce(a, tag)), balance: async (a) => get(K.balance(a)) },
  };
}

const window = (v, now, name) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < now + MIN_VALIDITY_SEC || n > now + MAX_VALIDITY_SEC) refuse("validity_window", `${name} must be ${MIN_VALIDITY_SEC}s..${MAX_VALIDITY_SEC}s from now`);
  return n;
};
const FEE_FIELDS = ["maxBlockAgeSec", "quoteTtlSec", "tx.gasLimit", "tx.maxFeePerGas", "tx.maxPriorityFeePerGas", "tx.maxSignedBytes", "tx.maxAttempts",
  "tx.replacementBumpBps", "pricing.marginBps", "pricing.maxFee6", "feed.address", "feed.decimals", "feed.description", "feed.maxAgeSec", "feed.minAnswer",
  "feed.maxAnswer", "oracle", "sequencer"];
const at = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const norm = (v) => (v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : lower(String(v)));

/** The fee decision against the reviewed fee observation: every differing field must be listed, every listed one must differ. */
export function feeSubstitutions(F, reviewed) {
  const view = { ...F, oracle: F.oracle, sequencer: F.sequencer === null ? null : F.sequencer.address };
  const base = { ...reviewed, oracle: reviewed.oracle.address, sequencer: reviewed.sequencer === null ? null : reviewed.sequencer.address };
  const differ = FEE_FIELDS.filter((f) => norm(at(view, f)) !== norm(at(base, f)));
  const listed = [...new Set(F.changesFromReviewedObservation)];
  const unlisted = differ.filter((f) => !listed.includes(f)), stale = listed.filter((f) => !differ.includes(f));
  if (unlisted.length) refuse("unapproved_substitution", `fee decision differs from the reviewed observation in unlisted field(s) ${unlisted.join(", ")}`);
  if (stale.length) refuse("decisions", `changesFromReviewedObservation lists field(s) that do not differ: ${stale.join(", ")}`);
  return differ;
}

export async function prepare({ pinsPath, out, now = Math.floor(Date.now() / 1000) }) {
  if (typeof out !== "string" || !path.isAbsolute(out) || path.normalize(out) !== out || out.endsWith("/")) refuse("out_path", "--out must be an absolute, normalized directory path");
  if (fs.existsSync(out)) refuse("out_exists", `${out} already exists; nothing is overwritten`);
  const parent = path.dirname(out);
  if (fs.realpathSync(parent) !== parent) refuse("out_path", "--out must not pass through a symlink (the loader refuses symlinked config paths)");
  const ctx = await loadContext(pinsPath);
  const { route, fee, activation } = ctx.modules;
  const D = ctx.decisions;
  const obs = observationReader(ctx.observation, now);
  const facts = await collectBindings(obs.reader, ctx);

  // ---- relay queue + fee envelope (only with an intake decision) ----------------------------------------------------
  const Q = D.queue;
  if (BigInt(facts.relayer.balanceWei) < BigInt(Q.minRelayerBalanceWei)) refuse("relayer_balance", `relayer balance ${facts.relayer.balanceWei} wei is below the decided minimum ${Q.minRelayerBalanceWei}`);
  let feeDiffs = [];
  if (D.intake !== null) {
    const F = D.feePolicy;
    const gasLimit = BigInt(F.tx.gasLimit), maxFee = BigInt(F.tx.maxFeePerGas), tipCap = BigInt(F.tx.maxPriorityFeePerGas);
    const queueGas = fee.queueGasFor(BigInt(Q.measuredExecuteGasUsed));
    if (queueGas > gasLimit) refuse("gas_cap_below_measured", `the host queue would need ${queueGas} gas for the measured execute, above tx.gasLimit ${gasLimit}`);
    if (Number(F.tx.maxAttempts) > Q.maxAttempts) refuse("attempts", `tx.maxAttempts ${F.tx.maxAttempts} exceeds the host queue's ${Q.maxAttempts}`);
    const tip = tipCap < BigInt(Q.maxTipWei) ? tipCap : BigInt(Q.maxTipWei);
    if (BigInt(obs.block.baseFeePerGas) + tip > maxFee) refuse("fee_cap_below_base", `observed base fee ${obs.block.baseFeePerGas} + tip ${tip} exceeds tx.maxFeePerGas ${maxFee}: every send would be refused`);
    if (BigInt(facts.relayer.balanceWei) < gasLimit * maxFee) refuse("relayer_balance", "the relayer cannot pay one envelope's L2 cost ceiling (gasLimit x maxFeePerGas)");
    feeDiffs = feeSubstitutions(F, ctx.reviewedFee);
    const R = ctx.reviewedFee;
    const drift = [];
    if (lower(R.oracle.address) === facts.fee.oracle) {
      if (lower(R.oracle.proxyCodehash) !== facts.codes[facts.fee.oracle].codehash) drift.push("oracle.proxyCodehash");
      if (lower(R.oracle.implementation) !== facts.fee.oracleImplementation) drift.push("oracle.implementation");
      if (lower(R.oracle.implementationCodehash) !== facts.codes[facts.fee.oracleImplementation].codehash) drift.push("oracle.implementationCodehash");
    }
    if (lower(R.feed.address) === facts.fee.feed) {
      if (lower(R.feed.proxyCodehash) !== facts.codes[facts.fee.feed].codehash) drift.push("feed.proxyCodehash");
      if (lower(R.feed.aggregator) !== facts.fee.aggregator) drift.push("feed.aggregator");
      if (lower(R.feed.aggregatorCodehash) !== facts.codes[facts.fee.aggregator].codehash) drift.push("feed.aggregatorCodehash");
    }
    if (drift.length) refuse("fee_identity_drift", `the oracle / feed code changed since the reviewed observation (${drift.join(", ")}); re-review it`);
  }

  // ---- the files, built only from observed facts + decisions, validated by the tested parsers -----------------------
  const S = facts.successor, C = facts.codes, cs = checksum, ch = (a) => C[lower(a)].codehash;
  const owner = { schema: route.OWNER_MANIFEST_SCHEMA, chainId: CHAIN_ID, maxBlockAgeSec: Number(D.ownerControls.maxBlockAgeSec),
    addresses: { factory: cs(S.FundingSessionVaultFactory), implementation: cs(facts.implementation), fundingGasLib: cs(S.FundingGasLib), fundingSessionVaultLib: cs(S.FundingSessionVaultLib) },
    codehashes: { factory: ch(S.FundingSessionVaultFactory), implementation: ch(facts.implementation), fundingGasLib: ch(S.FundingGasLib), fundingSessionVaultLib: ch(S.FundingSessionVaultLib) } };
  const o = route.parseOwnerControlsManifest(owner);
  if (o.why) refuse("owner_manifest", o.why);
  const files = { "owner-controls.json": owner };
  if (D.intake !== null) {
    const I = D.intake, F = D.feePolicy, P = facts.intake.pins;
    const intake = { schema: route.MANIFEST_SCHEMA, chainId: CHAIN_ID, notAfter: window(I.notAfter, now, "intake.notAfter"), maxBlockAgeSec: Number(I.maxBlockAgeSec),
      addresses: Object.fromEntries(route.PIN_KEYS.map((k) => [k, cs(P[k])])), codehashes: Object.fromEntries(route.PIN_KEYS.map((k) => [k, ch(P[k])])),
      pools: Object.fromEntries(I.feeTiers.map((t) => [String(t), { address: cs(facts.intake.pools[t]), codehash: ch(facts.intake.pools[t]) }])),
      feeTiers: I.feeTiers.map(Number), maxSlippageBps: Number(I.maxSlippageBps), deadlineSec: Number(I.deadlineSec) };
    if (route.PIN_KEYS.some((k) => !isAddr(P[k]))) refuse("intake_manifest", "an intake pin has no observed address");
    const m = route.parseFundingManifest(intake);
    if (m.why) refuse("intake_manifest", m.why);
    const feeCfg = { schema: fee.CONFIG_SCHEMA, chainId: CHAIN_ID, notAfter: window(F.notAfter, now, "feePolicy.notAfter"),
      maxBlockAgeSec: F.maxBlockAgeSec, quoteTtlSec: F.quoteTtlSec,
      oracle: { address: facts.fee.oracle, proxyCodehash: ch(facts.fee.oracle), implementation: facts.fee.oracleImplementation, implementationCodehash: ch(facts.fee.oracleImplementation) },
      feed: { address: facts.fee.feed, proxyCodehash: ch(facts.fee.feed), aggregator: facts.fee.aggregator, aggregatorCodehash: ch(facts.fee.aggregator),
        decimals: Number(F.feed.decimals), description: F.feed.description, maxAgeSec: F.feed.maxAgeSec, minAnswer: String(F.feed.minAnswer), maxAnswer: String(F.feed.maxAnswer) },
      sequencer: F.sequencer === null ? null : { address: facts.fee.sequencer.address, proxyCodehash: ch(facts.fee.sequencer.address),
        aggregator: facts.fee.sequencer.aggregator, aggregatorCodehash: ch(facts.fee.sequencer.aggregator), graceSec: F.sequencer.graceSec },
      tx: { ...F.tx }, pricing: { marginBps: F.pricing.marginBps, maxFee6: String(F.pricing.maxFee6) } };
    let parsed;
    try { parsed = fee.parseFeePolicyConfig(feeCfg); } catch (e) { refuse("fee_policy", e.message); }
    files["intake-manifest.json"] = intake;
    files["fee-policy.json"] = feeCfg;
    facts.feeConfigHash = parsed.configHash;
  }
  for (const [n, v] of Object.entries(files)) if (Buffer.byteLength(JSON.stringify(v, null, 2)) > activation.MAX_CONFIG_BYTES) refuse("config_oversize", `${n} exceeds the loader's limit`);

  // ---- write (exclusive), then load through the ACTUAL loader, offline ----------------------------------------------
  fs.mkdirSync(out, { mode: 0o750 });
  const paths = {};
  for (const [n, v] of Object.entries(files)) {
    paths[n] = path.join(out, n);
    fs.writeFileSync(paths[n], `${JSON.stringify(v, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  }
  const E = activation.ENV;
  const env = { [E.ownerControls]: "1", [E.ownerManifest]: paths["owner-controls.json"], [E.relayer]: cs(D.relayer),
    ...(D.intake !== null ? { [E.intake]: "1", [E.manifest]: paths["intake-manifest.json"], [E.feePolicy]: paths["fee-policy.json"] } : {}) };
  const offline = async () => { throw new Error("offline preparer: no network"); };
  const loaded = activation.loadFundingActivation(env, { netName: "base", chainId: CHAIN_ID, relayer: cs(D.relayer), request: offline, now: () => now });
  if (!loaded.status.ownerControls.on || (D.intake !== null && !loaded.status.intake.on)) {
    refuse("loader_refused", `the actual loader refused the prepared files: owner ${loaded.status.ownerControls.why ?? "on"}; intake ${loaded.status.intake.why ?? "on"}`);
  }
  const prepared = {
    schema: "production-activation-prep-r1-prepared/v1", status: "PREPARED_NOT_APPROVED",
    note: "Prepared from pinned public inputs and the decisions file named below. This is NOT an approval or an authorization; root reviews it, installs the files root-owned, and sets the env names below itself.",
    preparedAt: now, reviewedBy: D.reviewedBy, reviewRef: D.reviewRef,
    inputs: Object.fromEntries(Object.entries(ctx.pins.inputs).map(([k, v]) => [k, v])), modules: ctx.pins.modules,
    observation: { capturedAt: ctx.observation.capturedAt, block: obs.block, providers: obs.providers },
    outputs: Object.fromEntries(Object.entries(paths).map(([n, p]) => [n, sha(fs.readFileSync(p))])),
    facts, feeChangesFromReviewedObservation: feeDiffs,
    env: { owner: { [E.ownerControls]: "1", [E.ownerManifest]: "<root path of owner-controls.json>", [E.relayer]: cs(D.relayer) },
      intake: D.intake !== null ? { [E.intake]: "1", [E.manifest]: "<root path of intake-manifest.json>", [E.feePolicy]: "<root path of fee-policy.json>" } : null },
  };
  fs.writeFileSync(path.join(out, "PREPARED.json"), `${JSON.stringify(prepared, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  return prepared;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.slice(2).some((a) => a.startsWith("--") && !["--pins", "--out"].includes(a))) {
    console.error("usage: prepare-activation.mjs --pins <PINS.json> --out <absolute new directory>"); process.exit(2);
  }
  prepare({ pinsPath: arg("--pins"), out: arg("--out") }).then((p) => {
    console.log(JSON.stringify({ status: p.status, outputs: p.outputs, feeConfigHash: p.facts.feeConfigHash ?? null }, null, 2));
  }, (e) => { console.error(`REFUSED ${e.code ?? ""} ${e.message}`); process.exit(1); });
}
