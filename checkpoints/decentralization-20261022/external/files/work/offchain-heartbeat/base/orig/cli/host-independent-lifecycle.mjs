#!/usr/bin/env node
// cli/host-independent-lifecycle.mjs -- set up, build, install, run and check a host that needs no Enclave service
// (docs/network/independent-host-onboarding.md). It is the independent counterpart of `enclave host init|build|install|
// run|check|referral` (cli/enclave.mjs cmdHost), which assume the Enclave fleet tunnel, relay naming and api.enclave.host.
//
// The host it produces is the documented independent one:
//   1. scripts/network/fetch-runtime.mjs  - the operator-pinned CPU release, verified against its pin;
//   2. guestd -cpu-release -release -direct-bootstrap - the per-app SEV-SNP guest manager (docs/network/cold-host.md);
//   3. supervisor.js with ISOLATION_DIRECT_ONLY=1 - owner-committed startup deployments only, chain authorities pinned,
//      every relay / secrets / domain / certificate / DNS service off (docs/network/direct-host-control.md);
//   4. optionally the host owner's wallet policy (ENCLAVE_HOST_OWNERSHIP), on the reviewed profile's hostOwnership.
// Every authority comes from inputs the operator names: a reviewed authority profile checked against the digest they
// supply (or a contract-pin document), 2-8 RPCs that must agree, the release pin, the replica origins. Nothing defaults
// to an Enclave origin. One plan file (host-plan.json) records those choices; every flag, environment variable and unit
// is derived from it, so a reviewer reads one document.
//
//   node cli/host-independent-lifecycle.mjs init --dir DIR ...      write the plan and mint this host's keys
//   node cli/host-independent-lifecycle.mjs build --dir DIR         release, guestd, pairing key (collateral: printed)
//   node cli/host-independent-lifecycle.mjs install --dir DIR       print (default) or --apply the env and user units
//   node cli/host-independent-lifecycle.mjs run --dir DIR --component guestd|supervisor
//   node cli/host-independent-lifecycle.mjs check --dir DIR         read-only readiness (exit 0 ready, 3 not, 4 unknown)
//   node cli/host-independent-lifecycle.mjs referral --dir DIR [CODE] | --verify FILE
// Status, gas, payout declaration: `enclave --independent host status|fund|declare-payout|clear-payout` (unchanged).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, getAddress, parseAbi, recoverMessageAddress } from "viem";
import { loadIndependentTrust, QuorumChain, assertReviewedCode, readHost, requireSchema4, validateRpcOrigins } from "./independent.mjs";
import { validateContractPins } from "../network/contract-pins.mjs";
import { contractPinsFromProfile } from "../network/authority-profile.mjs";
import { verifiedReleaseManifest } from "../sdk/storage/raw-artifacts.mjs";
import { publicHostPolicyLoader, hostPolicyOrigins } from "../network/host-admission-runtime.mjs";
import { readHostAdmissionPolicy } from "../network/host-admission-policy.mjs";

// The checkout holding supervisor.js and isolation/: this file's parent, or (bundled into cli/dist/enclave.mjs) its
// grandparent. Without one, the defaults name paths that `run` refuses; pass --supervisor and --isolation.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = [path.resolve(HERE, ".."), path.resolve(HERE, "../..")].find((d) => fs.existsSync(path.join(d, "supervisor.js"))) ?? path.resolve(HERE, "..");
export const PLAN_FORMAT = "enclave-independent-host/v1";
export const REFERRAL_FORMAT = "enclave-host-referral/v1";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REFERRAL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;   // relay/referrals.mjs REFERRAL_RE: the same codes
const HEX64 = /^[0-9a-f]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/, ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64);
// What is missing for referral attribution on chain, stated exactly rather than pretended (no deployed contract has it).
export const REFERRAL_ONCHAIN_MISSING = "no deployed Enclave contract records referral codes: the deployed EnclaveRegistry (schema 4, b17db9a3) has "
  + "no referral field, setter or event, and the relay's /v1/referrals/host store is an Enclave service. On-chain attribution would need, e.g., "
  + "EnclaveRegistry.setReferral(bytes32 id, string code) callable only by the entry's operator, emitting "
  + "ReferralSet(bytes32 indexed id, address indexed operator, string code), and a reader for it. Until such a contract is deployed and reviewed, "
  + "this host's referral is the operator-signed statement below, verifiable by anyone against the registry";

// ---- small helpers ---------------------------------------------------------------------------------------------------
class UsageError extends Error {}
const fail = (m) => { throw new UsageError(m); };
const isAbs = (p) => typeof p === "string" && path.isAbsolute(p);
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const loopback = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
const hostIdOf = (url) => keccak256(toHex(String(url).replace(/\/+$/, "")));     // EnclaveRegistry.idOf(endpoint)
function readJson(file, what) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { fail(`${what} ${file}: ${e.message}`); } }
/** A file this host keeps private: a regular file (no symlink), owned by this user, mode 0600 or 0400. -> problem or null */
function privateFileProblem(file) {
  let st; try { st = fs.lstatSync(file); } catch { return "absent"; }
  if (!st.isFile()) return "not a regular file";
  if ((st.mode & 0o077) !== 0) return `mode ${(st.mode & 0o777).toString(8)} (must be 0600 or 0400)`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "not owned by this user";
  return null;
}
/** Write a new file exclusively (never replaces anything). */
const writeNew = (file, text, mode = 0o600) => { fs.writeFileSync(file, text, { flag: "wx", mode }); fs.chmodSync(file, mode); };

/** An https origin-or-base URL (http only on loopback), no credentials, query or fragment, no trailing slash. */
function httpUrl(v, what, { https = false } = {}) {
  let u; try { u = new URL(String(v)); } catch { fail(`${what}: ${JSON.stringify(v)} is not a URL`); }
  const ok = u.protocol === "https:" || (!https && u.protocol === "http:");
  if (!ok || u.username || u.password || u.search || u.hash) fail(`${what}: ${u.origin} must be ${https ? "https" : "http(s)"}, with no credentials, query or fragment`);
  return u.href.replace(/\/+$/, "");
}
/** A replica ORIGIN (http(s); literal-IP or loopback http only, as the supervisor and guestd accept). */
function replicaOrigin(v) {
  const u = new URL(httpUrl(v, "replica"));
  if (u.pathname !== "/") fail(`replica ${u.href}: give the origin; /ipfs is added where a tool needs it`);
  if (u.protocol === "http:" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && !loopback(u.hostname))
    fail(`replica ${u.origin}: plain HTTP only for a literal IP (the supervisor refuses HTTP names)`);
  return u.origin;
}
const hostPort = (v, what) => { if (!/^127\.0\.0\.1:\d{1,5}$/.test(String(v)) || Number(String(v).split(":")[1]) > 65535) fail(`${what} must be 127.0.0.1:PORT`); return String(v); };
const intIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < lo || n > hi) fail(`${what} must be an integer ${lo}-${hi}`); return n; };

// ---- the plan ----------------------------------------------------------------------------------------------------------
/** Validate a plan strictly. -> the plan (frozen). Throws UsageError naming the first problem. */
export function validatePlan(p) {
  const keys = (o, allowed, what) => { if (!o || typeof o !== "object" || Array.isArray(o)) fail(`${what} must be an object`);
    const extra = Object.keys(o).filter((k) => !allowed.includes(k)); if (extra.length) fail(`${what} has unknown field(s): ${extra.join(", ")}`); };
  keys(p, ["format", "authorities", "identity", "runtime", "guestd", "supervisor", "selling", "walletPolicy", "referral"], "plan");
  if (p.format !== PLAN_FORMAT) fail(`plan format must be ${PLAN_FORMAT}`);
  const a = p.authorities; keys(a, ["profile", "contractPins", "rpcs", "quorum", "confirmations", "maxBlockAgeSec"], "authorities");
  if (!!a.profile === !!a.contractPins) fail("authorities: exactly one of profile {file, digest} or contractPins FILE");
  if (a.profile) { keys(a.profile, ["file", "digest"], "authorities.profile"); if (!isAbs(a.profile.file) || !/^sha256:[0-9a-f]{64}$/.test(a.profile.digest || "")) fail("authorities.profile needs an absolute file and its sha256: digest"); }
  if (a.contractPins && !isAbs(a.contractPins)) fail("authorities.contractPins must be an absolute path");
  validateRpcOrigins(a.rpcs);
  intIn(a.quorum, 2, a.rpcs.length, "authorities.quorum"); intIn(a.confirmations, 0, 64, "authorities.confirmations"); intIn(a.maxBlockAgeSec, 10, 86400, "authorities.maxBlockAgeSec");
  const i = p.identity; keys(i, ["name", "publicUrl", "repo"], "identity");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(i.name || "")) fail("identity.name: 1-32 of a-z 0-9 - (a local label; the chain identity is publicUrl)");
  if (httpUrl(i.publicUrl, "identity.publicUrl", { https: true }) !== i.publicUrl) fail("identity.publicUrl must be written exactly as registered (no trailing slash)");
  if (/^https:\/\/([a-z0-9-]+\.)*enclave\.host(\/|$)/i.test(i.publicUrl)) fail("identity.publicUrl is an Enclave relay name; an independent host is reached at its own endpoint");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(i.repo || "")) fail("identity.repo: the source repository the image is attested against (owner/name)");
  const r = p.runtime; keys(r, ["releaseId", "isolationDir", "gateways", "storagePlan"], "runtime");
  if (!HEX64.test(r.releaseId || "")) fail("runtime.releaseId: the 64-hex release pin you reviewed");
  if (!isAbs(r.isolationDir)) fail("runtime.isolationDir: your checkout's isolation/ directory (absolute)");
  if (!Array.isArray(r.gateways) || r.gateways.length < 1 || r.gateways.length > 8) fail("runtime.gateways: 1-8 replica origins (components and the release)");
  r.gateways.forEach((g) => { if (replicaOrigin(g) !== g) fail(`runtime.gateways: ${g} must be written as an origin`); });
  if (r.storagePlan !== null && !isAbs(r.storagePlan)) fail("runtime.storagePlan must be null or an absolute file");
  const g = p.guestd; keys(g, ["listen", "dataListen", "guestMemMiB", "guestCpus", "hostFloorMiB", "collateralDir", "product", "instancePrefix"], "guestd");
  hostPort(g.listen, "guestd.listen"); hostPort(g.dataListen, "guestd.dataListen"); if (g.listen === g.dataListen) fail("guestd.listen and dataListen must differ");
  intIn(g.guestMemMiB, 512, 1 << 22, "guestd.guestMemMiB"); intIn(g.guestCpus, 1, 1024, "guestd.guestCpus"); intIn(g.hostFloorMiB, 0, 1 << 22, "guestd.hostFloorMiB");
  if (!isAbs(g.collateralDir)) fail("guestd.collateralDir must be absolute (vcek.der, cert_chain.pem, min-tcb.json: isolation/m2/host-collateral.mjs prepare --out)");
  if (!["Milan", "Genoa", "Turin"].includes(g.product)) fail("guestd.product: Milan | Genoa | Turin");
  if (!/^[a-z]{2}$/.test(g.instancePrefix || "")) fail("guestd.instancePrefix: two lowercase letters");
  const s = p.supervisor; keys(s, ["port", "path", "node", "attestationUrl"], "supervisor");
  intIn(s.port, 1, 65535, "supervisor.port"); if (!isAbs(s.path) || !isAbs(s.node)) fail("supervisor.path and supervisor.node must be absolute");
  if (s.attestationUrl !== null) { const u = new URL(httpUrl(s.attestationUrl, "supervisor.attestationUrl")); if (!loopback(u.hostname)) fail("supervisor.attestationUrl: the measured control guest's loopback document only"); }
  const sel = p.selling; keys(sel, ["cpuUsdHr", "payout"], "selling");
  if (sel.cpuUsdHr !== null && !(Number.isFinite(sel.cpuUsdHr) && sel.cpuUsdHr > 0 && sel.cpuUsdHr <= 1000)) fail("selling.cpuUsdHr: USD per full-node hour, or null");
  if (sel.payout !== null && (!ADDR.test(sel.payout) || /^0x0{40}$/i.test(sel.payout))) fail("selling.payout: a nonzero address, or null");
  if (p.walletPolicy !== null) { keys(p.walletPolicy, ["policyDir", "origins"], "walletPolicy");
    if (!isAbs(p.walletPolicy.policyDir)) fail("walletPolicy.policyDir must be absolute");
    if (!Array.isArray(p.walletPolicy.origins) || p.walletPolicy.origins.length > 8) fail("walletPolicy.origins: 0-8 policy document origins");
    p.walletPolicy.origins.forEach((o) => httpUrl(o, "walletPolicy.origins", { https: true }));
    try { hostPolicyOrigins(p.walletPolicy.origins); } catch (e) { fail(`walletPolicy.origins: ${e.message}`); } }
  if (p.referral !== null && !REFERRAL_RE.test(p.referral || "")) fail("referral: 1-64 letters, digits, '.', '_' or '-' (or null)");
  return p;
}

/** The trust this plan names, verified now (profile digest, pin document). -> {trust, pinsDoc, ownership|null} */
export function planTrust(plan) {
  const a = plan.authorities;
  let contractPins = null, pinsDoc = null;
  if (a.contractPins) { pinsDoc = readJson(a.contractPins, "contract pins"); contractPins = validateContractPins(pinsDoc); }
  const trust = loadIndependentTrust({ profileFile: a.profile?.file, profileDigest: a.profile?.digest, contractPins, defaultUsdc: BASE_USDC,
    rpcs: a.rpcs, quorum: a.quorum, confirmations: a.confirmations, maxBlockAgeSec: a.maxBlockAgeSec });
  if (trust.profile) pinsDoc = contractPinsFromProfile(trust.profile);
  // the host-owner authority: only the reviewed profile's verified hostOwnership (its code hash is checked on chain)
  const ownership = trust.profile?.contracts?.hostOwnership ? { address: trust.profile.contracts.hostOwnership.address, codeHash: trust.profile.contracts.hostOwnership.codeHash } : null;
  if (plan.walletPolicy && !ownership) fail("walletPolicy needs a reviewed profile: its hostOwnership contract is the verified authority (contract pins do not name one)");
  return { trust, pinsDoc, ownership };
}
export const loadPlan = (dir) => validatePlan(readJson(path.join(dir, "host-plan.json"), "host plan"));

// ---- derivations: one plan, every flag ---------------------------------------------------------------------------------
export function layout(dir, plan) {
  const c = plan.guestd.collateralDir;
  return { plan: path.join(dir, "host-plan.json"), pins: path.join(dir, "contract-pins.json"), operator: path.join(dir, "operator.key"),
    secret: path.join(dir, "supervisor.secret"), pair: path.join(dir, "pair.key"), env: path.join(dir, "supervisor.env"),
    release: path.join(dir, `release-${plan.runtime.releaseId}`), guests: path.join(dir, "guests"), guestd: path.join(dir, "bin", "guestd"),
    vcek: path.join(c, "vcek.der"), chain: path.join(c, "cert_chain.pem"), minTcb: path.join(c, "min-tcb.json"), referral: path.join(dir, "referral.json") };
}
/** guestd's argv and environment (docs/network/cold-host.md, step 2). */
export function guestdCommand(dir, plan) {
  const L = layout(dir, plan), g = plan.guestd;
  return { argv: [L.guestd, "-isolation", plan.runtime.isolationDir, "-root", L.guests, "-cpu-release", L.release, "-isolation-release", plan.runtime.releaseId,
    "-gateway", JSON.stringify(plan.runtime.gateways), "-release", "-direct-bootstrap", "-auth-key", L.pair,
    "-guest-mem-mib", String(g.guestMemMiB), "-guest-cpus", String(g.guestCpus), "-guest-host-floor-mib", String(g.hostFloorMiB),
    "-vcek", L.vcek, "-chain", L.chain, "-min-tcb", L.minTcb, "-product", g.product, "-listen", g.listen, "-data-listen", g.dataListen,
    "-instance-prefix", g.instancePrefix], env: { GUESTD_ENABLE: "1" } };
}
const SECRET_ENV = new Set(["SECRET"]);
/** The direct-only supervisor's environment (docs/network/direct-host-control.md). secrets: {operatorKey, secret} or null (redacted). */
export function supervisorEnv(dir, plan, ctx, secrets = null) {
  const L = layout(dir, plan), r = plan.runtime, sel = plan.selling;
  const env = {
    ISOLATION_DIRECT_ONLY: "1", ISOLATION_BACKEND: "snp-guest-per-app", PROVISION_BACKEND: "vm",
    VMMGR_URL: "http://" + plan.guestd.listen, GUESTD_KEY_FILE: L.pair, GUESTD_DATA_ADDR: plan.guestd.dataListen,
    ENCLAVE_CONTRACT_PINS_FILE: L.pins, ADDRESS_BOOK_ADDRESS: "", BASE_RPC: plan.authorities.rpcs[0], BASE_RPCS: plan.authorities.rpcs.join(","),
    ...(r.storagePlan ? { GUEST_BOOTSTRAP_STORAGE_PLAN_FILE: r.storagePlan } : { GUEST_BOOTSTRAP_GATEWAYS: r.gateways.map((g) => g + "/ipfs").join(",") }),
    IPFS_GATEWAY: JSON.stringify(r.gateways),
    SECRETS_API: "", DOMAINS_API: "", CERTS_API: "", DNS_API: "", APP_CERT_DOMAIN: "", ISOLATION_RELEASE: "",
    REGISTRY_ENABLED: "1", REGISTRY_PRIVATE_KEY_FILE: L.operator, ENCLAVE_REPO: plan.identity.repo,
    PUBLIC_URL: plan.identity.publicUrl, CLAIM_ENABLED: "1", SECRET: secrets ? secrets.secret : "<redacted: supervisor.secret>",
    PORT: String(plan.supervisor.port), NODE_VCPUS: String(plan.guestd.guestCpus),
    ...(plan.supervisor.attestationUrl ? { ATTESTATION_URL: plan.supervisor.attestationUrl } : {}),
    ...(sel.cpuUsdHr !== null ? { SELL_CPU_PRICE6: String(Math.max(1, Math.round(sel.cpuUsdHr * 1e6 / 3600))) } : {}),
    ...(sel.payout ? { PAYOUT_ADDRESS: getAddress(sel.payout) } : {}),
  };
  if (plan.walletPolicy) Object.assign(env, { ENCLAVE_HOST_OWNERSHIP: ctx.ownership.address.toLowerCase(), ENCLAVE_HOST_REGISTRY_PIN: ctx.pinsDoc.contracts.registry.toLowerCase(),
    ENCLAVE_HOST_CATALOG_PIN: ctx.pinsDoc.contracts.appCatalog.toLowerCase(), ENCLAVE_HOST_POLICY_DIR: plan.walletPolicy.policyDir,
    ENCLAVE_HOST_ID: hostIdOf(plan.identity.publicUrl), ...(plan.walletPolicy.origins.length ? { ENCLAVE_HOST_POLICY_ORIGINS: JSON.stringify(plan.walletPolicy.origins) } : {}) });
  return env;
}
/** The rules supervisor.js directOnlyProblems applies at startup, against an environment this tool produced. [] = startable. */
export function directOnlyEnvProblems(env) {
  const out = [], v = (k) => String(env[k] ?? "").trim();
  if (v("ISOLATION_BACKEND") !== "snp-guest-per-app") out.push("ISOLATION_BACKEND must be snp-guest-per-app");
  if (v("PROVISION_BACKEND") !== "vm") out.push("PROVISION_BACKEND must be vm");
  if (!v("ENCLAVE_CONTRACT_PINS_FILE")) out.push("ENCLAVE_CONTRACT_PINS_FILE must pin the contracts");
  if (v("ADDRESS_BOOK_ADDRESS")) out.push("ADDRESS_BOOK_ADDRESS must be empty");
  if (!v("GUEST_BOOTSTRAP_STORAGE_PLAN_FILE") && !v("GUEST_BOOTSTRAP_GATEWAYS")) out.push("package replicas must be named");
  if (!v("GUEST_BOOTSTRAP_STORAGE_PLAN_FILE") && !v("IPFS_GATEWAY")) out.push("IPFS_GATEWAY must name the component replicas");
  // an UNSET variable means the Enclave default in supervisor.js: each must be present and empty
  for (const k of ["SECRETS_API", "DOMAINS_API", "CERTS_API", "DNS_API", "APP_CERT_DOMAIN"]) if (!(k in env) || v(k)) out.push(`${k} must be set and empty`);
  if (/^(1|true|on)$/i.test(v("ISOLATION_RELEASE"))) out.push("ISOLATION_RELEASE must be off");
  for (const [k, val] of Object.entries(env)) if (/enclave\.host/i.test(String(val))) out.push(`${k} names an Enclave origin`);
  return out;
}

// systemd: an EnvironmentFile line, and a quoted ExecStart argument (C-style quotes; % and $ escaped)
const envLine = (k, val) => {
  if (/['\\\n\r]/.test(String(val))) fail(`${k}: a value with a quote, backslash or newline cannot be written to an EnvironmentFile unambiguously`);
  return `${k}=${val === "" ? "" : `'${val}'`}`;
};
const shArg = (a) => /^[A-Za-z0-9_./:=,+@-]+$/.test(String(a)) ? String(a) : `'${String(a).replace(/'/g, `'\\''`)}'`;
const unitArg = (a) => { const s = String(a).replace(/%/g, "%%").replace(/\$/g, "$$$$"); return /^[A-Za-z0-9_./:=,+@-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; };
const unitNames = (plan) => ({ guestd: `enclave-independent-${plan.identity.name}-guestd.service`, supervisor: `enclave-independent-${plan.identity.name}-supervisor.service` });
export function units(dir, plan) {
  const g = guestdCommand(dir, plan), L = layout(dir, plan), n = unitNames(plan);
  return {
    [n.guestd]: `[Unit]\nDescription=Enclave independent host "${plan.identity.name}": per-app SEV-SNP guest manager (guestd)\nAfter=network-online.target\n\n`
      + `[Service]\nType=simple\nEnvironment=GUESTD_ENABLE=1\nExecStart=${g.argv.map(unitArg).join(" ")}\nRestart=always\nRestartSec=3\nLimitMEMLOCK=infinity\n\n[Install]\nWantedBy=default.target\n`,
    [n.supervisor]: `[Unit]\nDescription=Enclave independent host "${plan.identity.name}": direct-only supervisor\nAfter=${n.guestd}\nRequires=${n.guestd}\n\n`
      + `[Service]\nType=simple\nEnvironmentFile=${unitArg(L.env)}\nWorkingDirectory=${unitArg(path.dirname(plan.supervisor.path))}\n`
      + `ExecStart=${[plan.supervisor.node, plan.supervisor.path].map(unitArg).join(" ")}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
  };
}
const envFileText = (env) => "# written by cli/host-independent-lifecycle.mjs install; mode 0600; holds the supervisor SECRET (the operator key stays in operator.key)\n"
  + Object.entries(env).map(([k, v]) => envLine(k, v)).join("\n") + "\n";
function readSecrets(L) {
  for (const f of [L.operator, L.secret]) { const p = privateFileProblem(f); if (p) fail(`${f}: ${p}`); }
  const key = fs.readFileSync(L.operator, "utf8").trim(), secret = fs.readFileSync(L.secret, "utf8").trim();
  if (!/^0x[0-9a-f]{64}$/i.test(key)) fail(`${L.operator} is not a private key`);
  if (!HEX64.test(secret)) fail(`${L.secret} is not a 64-hex secret`);
  return { operatorKey: key, secret };
}

// ---- argv ----------------------------------------------------------------------------------------------------------------
const BOOL = new Set(["dry-run", "apply", "enable", "json", "replace-plan", "probe-public", "deep", "verify-only"]);
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; continue; }
    const v = argv[++i]; if (v === undefined || v.startsWith("--")) fail(`--${k} needs a value`);
    o[k] = v;
  }
  return o;
}

// ---- commands --------------------------------------------------------------------------------------------------------
function planFromFlags(o, dir) {
  const need = (k, why) => { if (o[k] === undefined) fail(`--${k} is required: ${why}`); return o[k]; };
  if (!o.profile && !o["contract-pins"]) fail("name the authorities: --profile FILE --profile-digest sha256:… (reviewed) or --contract-pins FILE");
  const abs = (v) => path.resolve(v);
  const plan = {
    format: PLAN_FORMAT,
    authorities: { profile: o.profile ? { file: abs(o.profile), digest: need("profile-digest", "the digest you reviewed; a profile never vouches for itself") } : null,
      contractPins: o["contract-pins"] ? abs(o["contract-pins"]) : null, rpcs: list(need("rpc", "2-8 RPCs you chose (comma-separated); there is no default set")),
      quorum: Number(o.quorum ?? 2), confirmations: Number(o.confirmations ?? 2), maxBlockAgeSec: Number(o["max-block-age"] ?? 120) },
    identity: { name: o.name ?? "host", publicUrl: need("public-url", "this host's own https endpoint (its registry identity)"), repo: need("repo", "the source repository the image is attested against") },
    runtime: { releaseId: need("release-id", "the 64-hex CPU release pin you reviewed"), isolationDir: abs(o.isolation ?? path.join(REPO, "isolation")),
      gateways: list(need("gateways", "1-8 replica origins for the release, components and packages")).map(replicaOrigin), storagePlan: o["storage-plan"] ? abs(o["storage-plan"]) : null },
    guestd: { listen: o["guestd-listen"] ?? "127.0.0.1:8095", dataListen: o["guestd-data-listen"] ?? "127.0.0.1:8096",
      guestMemMiB: Number(need("guest-mem-mib", "host RAM set aside for guests")), guestCpus: Number(need("guest-cpus", "host cores set aside for guests")),
      hostFloorMiB: Number(o["host-floor-mib"] ?? 16384), collateralDir: abs(o.collateral ?? path.join(dir, "collateral")), product: o.product ?? "Turin", instancePrefix: o["instance-prefix"] ?? "gi" },
    supervisor: { port: Number(o["supervisor-port"] ?? 8080), path: abs(o.supervisor ?? path.join(REPO, "supervisor.js")), node: abs(o.node ?? process.execPath),
      attestationUrl: o["attestation-url"] ?? null },
    selling: { cpuUsdHr: o["price-cpu"] !== undefined ? Number(o["price-cpu"]) : null, payout: o.payout ?? null },
    walletPolicy: o["policy-dir"] ? { policyDir: abs(o["policy-dir"]), origins: list(o["policy-origins"]) } : null,
    referral: o.referral ?? null,
  };
  return validatePlan(plan);
}
const describe = (plan, ctx, operator) => [
  ["authorities", plan.authorities.profile ? `reviewed profile ${plan.authorities.profile.digest}` : `contract pins ${plan.authorities.contractPins}`],
  ["rpc quorum", `${plan.authorities.quorum} of ${plan.authorities.rpcs.length} must agree`],
  ["endpoint", `${plan.identity.publicUrl}  (registry id ${hostIdOf(plan.identity.publicUrl)})`],
  ["release", plan.runtime.releaseId], ["replicas", plan.runtime.gateways.join(", ") + (plan.runtime.storagePlan ? `; packages from ${plan.runtime.storagePlan}` : "")],
  ["wallet policy", plan.walletPolicy ? `on (${ctx.ownership.address}, policies in ${plan.walletPolicy.policyDir})` : "off (optional; --policy-dir lets the host owner's wallet deny deployments)"],
  ["referral", plan.referral ?? "(none)"], ...(operator ? [["operator", `${operator}  (needs a little Base ETH for gas)`]] : [])];

async function cmdInit(dir, o, out) {
  const plan = planFromFlags(o, dir), ctx = planTrust(plan), L = layout(dir, plan);
  const existing = fs.existsSync(L.plan) ? readJson(L.plan, "host plan") : null;
  if (existing && !o["replace-plan"]) fail(`${L.plan} exists: this host is already set up. To change its choices, re-run with --replace-plan (keys are never replaced)`);
  const changed = existing ? Object.keys(plan).filter((k) => JSON.stringify(plan[k]) !== JSON.stringify(existing[k])) : null;
  if (existing && existing.identity?.publicUrl !== plan.identity.publicUrl) out(`WARNING: the endpoint changes: ${plan.identity.publicUrl} is a NEW host on chain (new registry id)`);
  let operator = null;
  if (fs.existsSync(L.operator)) {
    const p = privateFileProblem(L.operator); if (p) fail(`${L.operator}: ${p}`);
    try { operator = privateKeyToAccount(fs.readFileSync(L.operator, "utf8").trim()).address; } catch { fail(`${L.operator} is not a private key`); }
  }
  if (o["dry-run"]) {
    out(`dry run: nothing written. ${existing ? `--replace-plan would change: ${changed.join(", ") || "(nothing)"}` : `would create ${dir} (0700) with host-plan.json, contract-pins.json, operator.key, supervisor.secret`}`);
    for (const [k, v] of describe(plan, ctx, operator)) out(`  ${k.padEnd(14)} ${v}`);
    return 0;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const pinsText = JSON.stringify(ctx.pinsDoc, null, 2) + "\n";
  if (fs.existsSync(L.pins)) { if (fs.readFileSync(L.pins, "utf8") !== pinsText) fail(`${L.pins} exists with different pins; move it aside deliberately before changing authorities`); }
  else writeNew(L.pins, pinsText, 0o644);
  let minted = false;
  if (!fs.existsSync(L.operator)) { writeNew(L.operator, generatePrivateKey() + "\n"); minted = true; }
  if (!fs.existsSync(L.secret)) writeNew(L.secret, randomBytes(32).toString("hex") + "\n");
  readSecrets(L);
  const text = JSON.stringify(plan, null, 2) + "\n";
  if (existing) { fs.writeFileSync(L.plan + ".tmp", text, { mode: 0o600 }); fs.renameSync(L.plan + ".tmp", L.plan); } else writeNew(L.plan, text);
  const op = privateKeyToAccount(fs.readFileSync(L.operator, "utf8").trim()).address;
  out(`${existing ? `updated ${L.plan} (changed: ${changed.join(", ") || "nothing"})` : `created ${dir}`}${minted ? "; operator key minted on this machine (operator.key, 0600; never printed)" : ""}`);
  for (const [k, v] of describe(plan, ctx, op)) out(`  ${k.padEnd(14)} ${v}`);
  out(`next: node cli/host-independent-lifecycle.mjs build --dir ${dir}`);
  return 0;
}

async function cmdBuild(dir, o, out) {
  const plan = loadPlan(dir), L = layout(dir, plan), only = o.only ? list(o.only) : ["release", "guestd", "pair-key", "collateral"];
  for (const s of only) if (!["release", "guestd", "pair-key", "collateral"].includes(s)) fail(`--only: release | guestd | pair-key | collateral (got ${s})`);
  const dry = !!o["dry-run"];
  if (only.includes("release")) {
    if (fs.existsSync(L.release)) {
      verifiedReleaseManifest(fs.readFileSync(path.join(L.release, "release.json")), plan.runtime.releaseId);
      out(`release   present: ${L.release} (manifest matches the pin; check --deep re-verifies every file)`);
    } else if (dry) out(`release   would fetch ${plan.runtime.releaseId} from ${plan.runtime.gateways.join(", ")} into ${L.release}`);
    else {
      const { fetchRuntime } = await import("../scripts/network/fetch-runtime.mjs");
      const r = await fetchRuntime({ releaseId: plan.runtime.releaseId, destination: L.release, gateways: plan.runtime.gateways.map((g) => g + "/ipfs"), isolation: plan.runtime.isolationDir });
      out(`release   fetched and verified: ${r.files} files in ${L.release}`);
    }
  }
  if (only.includes("guestd")) {
    const src = path.join(plan.runtime.isolationDir, "m4", "guestd");
    if (fs.existsSync(L.guestd)) out(`guestd    present: ${L.guestd}`);
    else if (dry) out(`guestd    would build: (cd ${src} && go build -trimpath -o ${L.guestd} .)`);
    else {
      if (!fs.existsSync(path.join(src, "main.go"))) fail(`no guestd source at ${src} (runtime.isolationDir must be your checkout's isolation/)`);
      fs.mkdirSync(path.dirname(L.guestd), { recursive: true, mode: 0o700 });
      const r = spawnSync("go", ["build", "-trimpath", "-o", L.guestd, "."], { cwd: src, stdio: ["ignore", "inherit", "inherit"] });
      if (r.status !== 0) fail(`go build exited ${r.status ?? r.signal ?? r.error?.message}`);
      out(`guestd    built: ${L.guestd}`);
    }
  }
  if (only.includes("pair-key")) {
    const p = privateFileProblem(L.pair);
    if (!p) out(`pair key  present: ${L.pair}`);
    else if (p !== "absent") fail(`${L.pair}: ${p}`);
    else if (dry) out(`pair key  would run: ${L.guestd} -gen-key ${L.pair}`);
    else {
      if (!fs.existsSync(L.guestd)) fail("the pairing key is made by guestd itself: build guestd first (build --only guestd)");
      const r = spawnSync(L.guestd, ["-gen-key", L.pair], { stdio: ["ignore", "pipe", "inherit"] });
      if (r.status !== 0) fail(`guestd -gen-key exited ${r.status ?? r.signal}`);
      out(`pair key  made by guestd: ${L.pair} (0600; the supervisor reads the same file)`);
    }
  }
  if (only.includes("collateral")) {
    const missing = [L.vcek, L.chain, L.minTcb].filter((f) => !fs.existsSync(f));
    if (!missing.length) out(`collateral present: ${plan.guestd.collateralDir}`);
    else {
      const hc = path.join(plan.runtime.isolationDir, "m2", "host-collateral.mjs");
      out(`collateral NEEDS THIS SEV HOST, run by you (missing: ${missing.map((f) => path.basename(f)).join(", ")}; docs/network/cold-host-collateral.md):`);
      out(`  cc -std=c11 -O2 -Wall -Wextra -Werror -static -o sev-inventory ${path.join(plan.runtime.isolationDir, "m2", "sev-inventory.c")}`);
      out(`  sudo ./sev-inventory > fw.json`);
      out(`  node ${hc} inventory --firmware --helper-output fw.json --statement-out statement.json`);
      out(`  node ${hc} prepare --statement statement.json --min-tcb <YOUR minimum-TCB policy.json> --fetch-vcek --fetch-crl --out ${plan.guestd.collateralDir}`);
    }
  }
  out(`next: node cli/host-independent-lifecycle.mjs install --dir ${dir}`);
  return 0;
}

function unitDir(o, env) { return path.resolve(o["unit-dir"] ?? path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "systemd", "user")); }
async function cmdInstall(dir, o, out, env) {
  const plan = loadPlan(dir), ctx = planTrust(plan), L = layout(dir, plan), ud = unitDir(o, env);
  const problems = directOnlyEnvProblems(supervisorEnv(dir, plan, ctx));
  if (problems.length) fail(`the derived supervisor environment would be refused: ${problems.join("; ")}`);
  const files = { ...Object.fromEntries(Object.entries(units(dir, plan)).map(([n, t]) => [path.join(ud, n), t])) };
  if (!o.apply) {
    out(`dry run (pass --apply to write; --enable to start): ${Object.keys(files).join(", ")}, ${L.env}`);
    for (const [f, t] of Object.entries(files)) out(`--- ${f}\n${t}`);
    out(`--- ${L.env} (0600)\n${envFileText(supervisorEnv(dir, plan, ctx))}`);
    return 0;
  }
  const secrets = readSecrets(L), envText = envFileText(supervisorEnv(dir, plan, ctx, secrets));
  const all = { ...files, [L.env]: envText }, differ = [];
  for (const [f, t] of Object.entries(all)) if (fs.existsSync(f) && fs.readFileSync(f, "utf8") !== t) differ.push(f);
  if (differ.length) fail(`refusing to replace existing file(s) with different content: ${differ.join(", ")} (review and move them aside deliberately)`);
  fs.mkdirSync(ud, { recursive: true });
  for (const [f, t] of Object.entries(all)) if (!fs.existsSync(f)) writeNew(f, t, f === L.env ? 0o600 : 0o644);
  out(`installed: ${Object.keys(all).join(", ")}`);
  if (o.enable) {
    const n = unitNames(plan);
    for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", n.guestd, n.supervisor]]) {
      const r = spawnSync("systemctl", args, { stdio: "inherit" });
      if (r.status !== 0) fail(`systemctl ${args.join(" ")} failed (${r.status ?? r.signal})`);
    }
    out("enabled and started; logs: journalctl --user -u " + unitNames(plan).supervisor + " -f");
  } else out(`start with: systemctl --user daemon-reload && systemctl --user enable --now ${Object.values(unitNames(plan)).join(" ")}`);
  out(`then: node cli/host-independent-lifecycle.mjs check --dir ${dir}`);
  return 0;
}

async function cmdRun(dir, o, out) {
  const plan = loadPlan(dir), ctx = planTrust(plan), L = layout(dir, plan), which = o.component;
  if (!["guestd", "supervisor"].includes(which)) fail("--component guestd | supervisor");
  const cmd = which === "guestd" ? guestdCommand(dir, plan) : { argv: [plan.supervisor.node, plan.supervisor.path], env: supervisorEnv(dir, plan, ctx) };
  if (which === "supervisor") { const p = directOnlyEnvProblems(cmd.env); if (p.length) fail(`the derived environment would be refused: ${p.join("; ")}`); }
  if (o["dry-run"]) { out(`${Object.entries(cmd.env).map(([k, v]) => `${k}=${SECRET_ENV.has(k) ? "'<redacted>'" : shArg(v)}`).join(" \\\n  ")} \\\n  ${cmd.argv.map(shArg).join(" ")}`); return 0; }
  if (which === "supervisor") cmd.env = supervisorEnv(dir, plan, ctx, readSecrets(L));
  if (!fs.existsSync(cmd.argv[0])) fail(`${cmd.argv[0]} does not exist (build first)`);
  out(`running ${which} in the foreground (ctrl-c stops it)`);
  const child = spawn(cmd.argv[0], cmd.argv.slice(1), { stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...cmd.env },
    cwd: which === "supervisor" ? path.dirname(plan.supervisor.path) : dir });
  const forward = new Map(["SIGINT", "SIGTERM"].map((s) => [s, () => child.kill(s)]));
  for (const [signal, handler] of forward) process.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, sig) => resolve(code ?? (sig ? 1 : 0)));
    });
  } finally {
    for (const [signal, handler] of forward) process.off(signal, handler);
  }
}

// ---- check -------------------------------------------------------------------------------------------------------------
const OWNERSHIP_ABI = parseAbi(["function authority(bytes32) view returns (address owner,address pendingOwner,uint64 revision,bytes32 policyHash)",
  "function registry() view returns (address)"]);
const MIN_GAS_WEI = 20_000_000_000_000n;   // 0.00002 ETH: a few register/heartbeat/claim transactions on Base
export async function readinessRows(dir, o, { fetchImpl = globalThis.fetch, now = Date.now, chainFactory, env = process.env } = {}) {
  const rows = [], add = (item, status, detail, required = true) => rows.push({ item, status, detail, required });
  let plan, ctx, L;
  try { plan = loadPlan(dir); L = layout(dir, plan); add("plan", "ready", `${L.plan} (${PLAN_FORMAT})`); }
  catch (e) { add("plan", "missing", e.message); return rows; }
  try { ctx = planTrust(plan); add("authorities", "ready", plan.authorities.profile ? `reviewed profile ${plan.authorities.profile.digest} matches its file` : "contract pins valid"); }
  catch (e) { add("authorities", "failed", e.message); return rows; }
  try { const on = readJson(L.pins, "pins"); add("contract pins file", JSON.stringify(on) === JSON.stringify(ctx.pinsDoc) ? "ready" : "failed", JSON.stringify(on) === JSON.stringify(ctx.pinsDoc) ? L.pins : `${L.pins} differs from the authorities`); }
  catch (e) { add("contract pins file", "missing", e.message); }
  let operator = null, localSecrets = null;
  try { const s = readSecrets(L); localSecrets = s; operator = privateKeyToAccount(s.operatorKey).address; add("operator key", "ready", `${operator} (0600)`); add("supervisor secret", "ready", "0600"); }
  catch (e) { add("operator key / secret", "missing", e.message); }
  // the release: the manifest's pin always, every file's digest with --deep (the verifier guestd runs)
  if (!fs.existsSync(L.release)) add("release", "missing", `${L.release}: build --dir ${dir}`);
  else try {
    verifiedReleaseManifest(fs.readFileSync(path.join(L.release, "release.json")), plan.runtime.releaseId);
    if (o.deep) { const r = spawnSync("python3", [path.join(plan.runtime.isolationDir, "m4", "release-manifest.py"), "verify", L.release, "--expect", plan.runtime.releaseId], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) throw new Error(`release-manifest verify: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`); }
    add("release", "ready", `${plan.runtime.releaseId}${o.deep ? " (every file verified)" : " (manifest pin; --deep verifies every file)"}`);
  } catch (e) { add("release", "failed", e.message); }
  const missingColl = [L.vcek, L.chain, L.minTcb].filter((f) => !fs.existsSync(f));
  add("collateral", missingColl.length ? "missing" : "ready", missingColl.length ? `${missingColl.map((f) => path.basename(f)).join(", ")} in ${plan.guestd.collateralDir} (needs this SEV host: build --only collateral)` : plan.guestd.collateralDir);
  add("guestd binary", fs.existsSync(L.guestd) ? "ready" : "missing", fs.existsSync(L.guestd) ? L.guestd : "build --only guestd");
  const pp = privateFileProblem(L.pair);
  add("pairing key", pp ? (pp === "absent" ? "missing" : "failed") : "ready", pp ? `${L.pair}: ${pp}` : L.pair);
  const envProblems = directOnlyEnvProblems(supervisorEnv(dir, plan, ctx));
  add("direct-only environment", envProblems.length ? "failed" : "ready", envProblems.length ? envProblems.join("; ") : "relay, secrets, domain, certificate and DNS services off; pins and replicas named");
  const ud = unitDir(o, env), want = units(dir, plan);
  const unitState = Object.entries(want).map(([n, t]) => { const f = path.join(ud, n); return !fs.existsSync(f) ? "absent" : fs.readFileSync(f, "utf8") === t ? "match" : "DIFFERS"; });
  // A private file can still hold an old plan, another operator's key or an enabled relay.
  // Compare the complete expected environment without ever printing either secret-bearing value.
  const envState = !fs.existsSync(L.env) ? "absent" : privateFileProblem(L.env) ? "UNSAFE MODE"
    : !localSecrets ? "UNVERIFIED"
    : fs.readFileSync(L.env, "utf8") === envFileText(supervisorEnv(dir, plan, ctx, localSecrets)) ? "match" : "DIFFERS";
  add("installed units", unitState.every((s) => s === "match") && envState === "match" ? "ready"
    : unitState.includes("DIFFERS") || ["UNSAFE MODE", "DIFFERS"].includes(envState) ? "failed" : "missing",
    `units ${unitState.join(", ")}; supervisor.env ${envState}`);
  add("control attestation", plan.supervisor.attestationUrl ? "unknown" : "missing", plan.supervisor.attestationUrl
    ? `configured ${plan.supervisor.attestationUrl}; this check has not verified that the running supervisor and its proof key belong to that measured control guest`
    : "no ATTESTATION_URL: a measured control guest and verification of its running supervisor are still required");
  // chain: every read through the agreeing quorum; a read that fails is UNKNOWN, never ready
  const chain = chainFactory ? chainFactory(ctx.trust) : new QuorumChain({ rpcs: ctx.trust.rpcs, quorum: ctx.trust.quorum, confirmations: ctx.trust.confirmations, maxBlockAgeMs: ctx.trust.maxBlockAgeMs, now });
  const hid = hostIdOf(plan.identity.publicUrl), registry = ctx.pinsDoc.contracts.registry;
  try {
    if (ctx.trust.profile) { await assertReviewedCode(chain, ctx.trust.profile, ["registry", "deployments", "appCatalog", ...(plan.walletPolicy ? ["hostOwnership"] : [])]); add("reviewed code", "ready", "registry, deployments, appCatalog" + (plan.walletPolicy ? ", hostOwnership" : "") + " carry the reviewed code"); }
    else add("reviewed code", "ready", "contract pins only (no profile to compare code hashes against)", false);
  } catch (e) { add("reviewed code", /does not carry/.test(e.message) ? "failed" : "unknown", e.message); }
  try {
    const snap = await chain.snapshot((c, b) => readHost(c, registry, hid, b)); requireSchema4(snap.value.schema);
    const h = snap.value.host;
    if (!h) add("registration", "missing", `${plan.identity.publicUrl} is not in the pinned registry yet: fund the operator; the supervisor registers it`);
    else if (operator && h.operator !== operator.toLowerCase()) add("registration", "failed", `registered to ${h.operator}, not this host's operator ${operator}`);
    else if (!h.active) add("registration", "failed", "registered but INACTIVE");
    else {
      add("registration", "ready", `active, heartbeat ${Math.max(0, Math.round(snap.timestamp / 1000) - h.lastSeen)} s before the agreed block`);
      add("proof key", /^0x0{40}$/.test(h.proofKey) ? "missing" : "ready", /^0x0{40}$/.test(h.proofKey) ? "none on the entry: claims fail once proofs are required" : h.proofKey);
      add("payout wallet", /^0x0{40}$/.test(h.payoutWallet) ? "missing" : "ready", /^0x0{40}$/.test(h.payoutWallet) ? "undeclared: enclave --independent host declare-payout (from your wallet)" : h.payoutWallet, false);
    }
  } catch (e) { add("registration", "unknown", e.message); }
  if (operator) try {
    const wei = await chain.balance(operator);
    add("operator gas", wei >= MIN_GAS_WEI ? "ready" : "missing", `${Number(wei) / 1e18} ETH${wei >= MIN_GAS_WEI ? "" : " (fund it: enclave --independent host fund --address " + operator + ")"}`);
  } catch (e) { add("operator gas", "unknown", e.message); }
  if (plan.walletPolicy) try {
    const own = ctx.ownership.address;
    const s = await chain.snapshot(async (c, blockNumber) => {
      const [reg, a] = await Promise.all([c.readContract({ address: own, abi: OWNERSHIP_ABI, functionName: "registry", blockNumber }),
        c.readContract({ address: own, abi: OWNERSHIP_ABI, functionName: "authority", args: [hid], blockNumber })]);
      return { registry: reg.toLowerCase(), owner: a[0].toLowerCase(), pending: a[1].toLowerCase(), policyHash: a[3].toLowerCase() };
    });
    const v = s.value, origins = plan.walletPolicy.origins;
    if (v.registry !== registry.toLowerCase()) add("wallet policy", "failed", `the ownership contract's registry ${v.registry} is not the pinned one`);
    else if (v.owner === ZERO) add("wallet policy", "missing", (v.pending === ZERO ? "no owner: the operator proposes one (scripts/network/prepare-host-policy.mjs prepares it unsigned)"
      : `nominated ${v.pending}; that wallet must acceptOwner`) + ". Until then the host refuses every deployment");
    else try {
      // the host's own resolution: the committed document from the policy directory or a mirror, checked against its hash
      const r = await readHostAdmissionPolicy({ hostId: hid, ownershipContract: own.toLowerCase(), readAuthority: async () => v,
        loadPolicy: publicHostPolicyLoader({ directory: plan.walletPolicy.policyDir, origins, fetch: fetchImpl }) });
      add("wallet policy", "ready", `owner ${v.owner}${v.policyHash === ZERO32 ? " (no committed policy: nothing denied)" : `, policy ${v.policyHash} resolves and matches`}`
        + (r.policy.requireCatalogApproval ? "; catalog approval required" : ""));
    } catch (e) { add("wallet policy", origins.length ? "unknown" : "failed", `owner ${v.owner} committed ${v.policyHash}: ${e.message}. The host refuses deployments until it resolves`); }
  } catch (e) { add("wallet policy", "unknown", e.message); }
  else add("wallet policy", "missing", "not configured: no host-owner wallet can deny deployments here (init --policy-dir enables the host owner's wallet policy)", false);
  // live services on this machine: a definite refusal is NOT running; nothing is assumed
  try {
    const { openGuestdTransport } = await import("../isolation/m4/guestd/supervisor-transport.mjs");
    if (pp) throw new Error("no usable pairing key");
    const t = openGuestdTransport({ url: "http://" + plan.guestd.listen, keyFile: L.pair });
    const r = await t.request("GET", "/health", null, 4000);
    add("guestd running", r.status === 200 ? "ready" : "failed", r.status === 200 ? `${plan.guestd.listen} answered over guestd-control/1` : `HTTP ${r.status}`);
  } catch (e) { add("guestd running", "failed", `${plan.guestd.listen}: ${String(e.message).slice(0, 160)}`); }
  try {
    const r = await fetchImpl(`http://127.0.0.1:${plan.supervisor.port}/v1/health`, { signal: AbortSignal.timeout(4000) });
    const body = r.ok ? await r.json().catch(() => null) : null;   // {status:"ok", deployments:N, ...}: no identity in it
    const isSup = body?.status === "ok" && Number.isSafeInteger(body.deployments);
    add("supervisor running", isSup ? "ready" : "failed", isSup ? `127.0.0.1:${plan.supervisor.port} answers as a supervisor (${body.deployments} deployments)`
      : `127.0.0.1:${plan.supervisor.port}: HTTP ${r.status}${r.ok ? ", not a supervisor health document (another service on this port?)" : ""}`);
  } catch (e) { add("supervisor running", "failed", `127.0.0.1:${plan.supervisor.port}: ${String(e.cause?.code || e.message).slice(0, 120)}`); }
  if (o["probe-public"]) try {
    const r = await fetchImpl(plan.identity.publicUrl + "/v1/health", { signal: AbortSignal.timeout(8000), redirect: "error" });
    add("public endpoint", r.ok ? "ready" : "failed", `${plan.identity.publicUrl}: HTTP ${r.status}`);
  } catch (e) { add("public endpoint", "unknown", `${plan.identity.publicUrl}: ${String(e.cause?.code || e.message).slice(0, 120)}`); }
  return rows;
}
export function verdict(rows) {
  const req = rows.filter((r) => r.required);
  if (req.some((r) => r.status === "missing" || r.status === "failed")) return { code: 3, word: "NOT READY" };
  if (req.some((r) => r.status === "unknown")) return { code: 4, word: "UNKNOWN (a read failed; not ready)" };
  return { code: 0, word: "READY" };
}
async function cmdCheck(dir, o, out, deps) {
  const rows = await readinessRows(dir, o, deps), v = verdict(rows);
  if (o.json) { out(JSON.stringify({ verdict: v.word, rows })); return v.code; }
  for (const r of rows) out(`${r.status.toUpperCase().padEnd(8)} ${r.item.padEnd(24)} ${r.detail}${r.required ? "" : "  (optional)"}`);
  out(`verdict: ${v.word}`);
  return v.code;
}

// ---- referral -----------------------------------------------------------------------------------------------------------
export function referralStatement({ chainId, registry, hostId, endpoint, code }) {
  return [REFERRAL_FORMAT, `chain: ${chainId}`, `registry: ${registry.toLowerCase()}`, `host: ${hostId}`, `endpoint: ${endpoint}`, `code: ${code}`].join("\n");
}
async function cmdReferral(dir, o, out, deps) {
  if (o.verify) {
    const doc = readJson(path.resolve(o.verify), "referral");
    if (doc?.format !== REFERRAL_FORMAT || !REFERRAL_RE.test(doc.code || "") || !/^0x[0-9a-f]{130}$/i.test(doc.signature || "")) fail("not a host referral statement");
    // the verifier names its own authorities and quorum, as any independent reader does
    let plan; try { plan = loadPlan(dir); } catch { fail("verify needs --dir with a plan naming the authorities and RPCs to check against"); }
    const ctx = planTrust(plan), registry = ctx.pinsDoc.contracts.registry;
    if (doc.registry !== registry.toLowerCase() || doc.chain !== 8453) fail(`the statement names registry ${doc.registry} on chain ${doc.chain}; your pinned registry is ${registry.toLowerCase()} on 8453`);
    if (hostIdOf(doc.endpoint) !== doc.host) fail("the statement's host id is not keccak256 of its endpoint");
    const signer = (await recoverMessageAddress({ message: referralStatement({ chainId: doc.chain, registry: doc.registry, hostId: doc.host, endpoint: doc.endpoint, code: doc.code }), signature: doc.signature })).toLowerCase();
    const chain = deps.chainFactory ? deps.chainFactory(ctx.trust) : new QuorumChain({ rpcs: ctx.trust.rpcs, quorum: ctx.trust.quorum, confirmations: ctx.trust.confirmations, maxBlockAgeMs: ctx.trust.maxBlockAgeMs });
    const snap = await chain.snapshot((c, b) => readHost(c, registry, doc.host, b)); requireSchema4(snap.value.schema);
    const h = snap.value.host;
    if (!h) { out(`NOT VERIFIED: ${doc.endpoint} is not registered in the pinned registry`); return 3; }
    if (h.operator !== signer) { out(`NOT VERIFIED: signed by ${signer}, but the registered operator is ${h.operator}`); return 3; }
    out(`verified: the registered operator ${signer} of ${doc.endpoint} states referral code ${doc.code} (registry ${registry}, block ${snap.blockNumber}, ${snap.agreeing} RPCs agreed)`);
    return 0;
  }
  const plan = loadPlan(dir), ctx = planTrust(plan), L = layout(dir, plan);
  const code = String(o._[0] ?? plan.referral ?? "").trim();
  if (!code) { out("no referral code: attribution is optional (pass one: referral --dir DIR CODE, or init --referral CODE)"); return 0; }
  if (!REFERRAL_RE.test(code)) fail("a referral code is 1-64 letters, digits, '.', '_' or '-'");
  const { operatorKey } = readSecrets(L), acct = privateKeyToAccount(operatorKey), hid = hostIdOf(plan.identity.publicUrl);
  const registry = ctx.pinsDoc.contracts.registry.toLowerCase();
  const signature = await acct.signMessage({ message: referralStatement({ chainId: 8453, registry, hostId: hid, endpoint: plan.identity.publicUrl, code }) });
  const doc = { format: REFERRAL_FORMAT, chain: 8453, registry, host: hid, endpoint: plan.identity.publicUrl, code, operator: acct.address.toLowerCase(), signature };
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (fs.existsSync(L.referral) && fs.readFileSync(L.referral, "utf8") !== text) {
    const old = readJson(L.referral, "referral"); if (old.code !== code) fail(`${L.referral} already states code ${old.code}; move it aside to state another`);
  }
  if (!fs.existsSync(L.referral)) writeNew(L.referral, text, 0o644);
  out(`wrote ${L.referral}: the operator key's signed statement of referral code ${code} for ${plan.identity.publicUrl}`);
  out(`anyone verifies it with their own authorities: node cli/host-independent-lifecycle.mjs referral --dir <their plan dir> --verify referral.json`);
  out(`on-chain: ${REFERRAL_ONCHAIN_MISSING}`);
  return 0;
}

// ---- entry ---------------------------------------------------------------------------------------------------------------
const USAGE = `usage: node cli/host-independent-lifecycle.mjs <init|build|install|run|check|referral> --dir HOST_DIR [flags]
  init      --profile FILE --profile-digest sha256:… | --contract-pins FILE   --rpc A,B[,C]   --public-url https://…
            --repo OWNER/NAME --release-id HEX64 --gateways ORIGIN[,…] --guest-mem-mib N --guest-cpus N
            [--name L] [--quorum N] [--storage-plan FILE] [--isolation DIR] [--collateral DIR] [--product Turin]
            [--price-cpu USD_PER_HOUR] [--payout 0x…] [--policy-dir DIR [--policy-origins https://…]] [--referral CODE]
            [--attestation-url http://127.0.0.1:…] [--dry-run] [--replace-plan]
  build     [--only release,guestd,pair-key,collateral] [--dry-run]
  install   [--apply [--enable]] [--unit-dir DIR]
  run       --component guestd|supervisor [--dry-run]
  check     [--deep] [--probe-public] [--json] [--unit-dir DIR]        exit 0 ready · 3 not ready · 4 unknown
  referral  [CODE] | --verify FILE`;
export async function hostLifecycle(argv, { out = (s) => process.stdout.write(s + "\n"), err = (s) => process.stderr.write(s + "\n"), env = process.env, ...rest } = {}) {
  const deps = { ...rest, env };
  const [cmd, ...args] = argv;
  try {
    const o = parse(args);
    if (!cmd || cmd === "help" || cmd === "--help") { out(USAGE); return cmd ? 0 : 1; }
    if (!o.dir) fail("--dir HOST_DIR is required (this host's plan and keys live there)");
    const dir = path.resolve(o.dir);
    switch (cmd) {
      case "init": return await cmdInit(dir, o, out);
      case "build": return await cmdBuild(dir, o, out);
      case "install": return await cmdInstall(dir, o, out, env);
      case "run": return await cmdRun(dir, o, out);
      case "check": return await cmdCheck(dir, o, out, deps);
      case "referral": return await cmdReferral(dir, o, out, deps);
      default: fail(`unknown command ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    // no message here carries a secret: key files are only ever named, never quoted
    err(`host: ${e?.message ?? e}`);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  hostLifecycle(process.argv.slice(2)).then((c) => { process.exitCode = c; });
