// independent.mjs -- the phone hosts with no Enclave relay, API, Nan or minipc in any required role (the owner's choice:
// files/agent/independent.json; without it standalone.mjs runs exactly as before).
//
// What replaces each relay decision (docs: shielded/anchor/avf/INDEPENDENT.md):
//   identity      the registry entry the operator already has (or a new owner-chosen endpoint id): never dialled
//   admission     clients, directories and owners verify for themselves (network/pvm-independent-admission.mjs: the relay's
//                 own verifier code over THEIR nonce, the chain, the registry proof key, the platform host policy)
//   verifier pins one document bound by its exact sha256, fetched from >= 2 sources the owner names (loadVerifierInputs)
//   instance      learned from a LOCAL fresh-nonce attestation of the host VM, verified against those pins
//   liveness      the operator's signed capacity record (network/host-capacity*.mjs), posted to the owner's directories; no
//                 on-chain heartbeat
//   lease gas     claim/renew/release through the app-funded sender (network/lease-gas-runtime.mjs); no operator-paid fallback
//   network       enclaveNetwork.directories; no relay, no Nan mirror
//   certificates  none: clients pin the attested TLS key (network/native-client.mjs pvm profile)
//   secrets       relay-custodied pVM secrets are refused here (the measured build pins the relay's release key): reported
//
// Nothing here dials a name under enclave.host: a list may NAME an Enclave-operated mirror explicitly, but every list must
// also name at least one source that is not Enclave's, so none of them is required.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { keccak256, stringToBytes } from "viem";

export const INDEPENDENT_FORMAT = "enclave-pvm-independent/v1";
export const VERIFIER_INPUTS_FORMAT = "enclave-pvm-verifier-inputs/v1";
export const VERIFIER_INPUTS_MAX = 64 * 1024;
const ADDR = /^0x[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const lc = (s) => String(s || "").toLowerCase();

/** Is this host one of Enclave's (the relay, the API, its mirrors)? Such a name may be listed, never required. */
export const isEnclaveHost = (host) => /(^|\.)enclave\.host$/i.test(String(host || "").replace(/\.$/, ""));

/**
 * A list of origins or URLs the owner chose: 2..8, distinct hosts, https (or http on a literal loopback/IP for a lab), no
 * credentials or fragments, and at least one host that is not Enclave's. -> normalized strings.
 */
export function independentSources(values, what, { min = 2, origin = true, max = 8 } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) throw new Error(`${what}: ${min}..${max} sources required`);
  const out = [], hosts = new Set();
  for (const v of values) {
    let u; try { u = new URL(String(v)); } catch { throw new Error(`${what}: ${JSON.stringify(v)} is not a URL`); }
    const literal = /^\d{1,3}(\.\d{1,3}){3}$|^\[[0-9a-f:]+\]$/i.test(u.hostname);
    if (!(u.protocol === "https:" || (u.protocol === "http:" && literal))) throw new Error(`${what}: ${u.origin} must be https (plain http only for a literal IP)`);
    if (u.username || u.password || u.hash) throw new Error(`${what}: ${u.origin} carries credentials or a fragment`);
    if (origin && (u.pathname !== "/" || u.search)) throw new Error(`${what}: ${v} must be a bare origin`);
    if (hosts.has(u.host)) throw new Error(`${what}: ${u.host} is listed twice (independent sources are distinct hosts)`);
    hosts.add(u.host); out.push(origin ? u.origin : u.href);
  }
  if (out.every((x) => isEnclaveHost(new URL(x).hostname))) throw new Error(`${what}: at least one source must not be Enclave's (${out.join(", ")})`);
  return out;
}

/**
 * The owner's independent profile, strictly:
 * { format, registeredEndpoint, chain: { chainId, addressBook, rpcs[2..8], quorum }, directories[2..8], gateways[2..8],
 *   verifierInputs: { sha256, sources[2..8] }, platformPolicy: { mode: "production" | "explicit", config? }, leaseGas: { file,
 *   digest, rpcs[], relays[], quorum? }, capacity?: { lifetimeSec } }
 * registeredEndpoint: the registry identity (id = keccak256 of it). An existing phone keeps the one it registered (a relay
 * route string is an identifier here, never dialled); a new one may use any https URL that is not Enclave's.
 */
export function checkIndependentProfile(p) {
  const bad = (m) => { throw new Error(`independent profile: ${m}`); };
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("not an object");
  const KEYS = ["format", "registeredEndpoint", "keepRegistration", "chain", "directories", "gateways", "verifierInputs", "platformPolicy", "leaseGas", "capacity"];
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) bad(`unknown key ${JSON.stringify(k)}`);
  if (p.format !== INDEPENDENT_FORMAT) bad(`format must be ${INDEPENDENT_FORMAT}`);
  let ep; try { ep = new URL(String(p.registeredEndpoint)); } catch { bad("registeredEndpoint must be an https URL"); }
  if (ep.protocol !== "https:" || ep.username || ep.password || ep.search || ep.hash || String(p.registeredEndpoint).length > 256) bad("registeredEndpoint must be an https URL (no credentials, query or fragment)");
  if (isEnclaveHost(ep.hostname) && p.keepRegistration !== true)
    bad("registeredEndpoint names an Enclave host: allowed only as the existing registration this phone keeps (keepRegistration: true); it is never dialled");
  if (p.keepRegistration !== undefined && typeof p.keepRegistration !== "boolean") bad("keepRegistration must be true or false");
  const c = p.chain;
  if (!c || typeof c !== "object" || Object.keys(c).sort().join() !== "addressBook,chainId,quorum,rpcs") bad("chain must be exactly { chainId, addressBook, rpcs, quorum }");
  if (!/^[1-9][0-9]{0,15}$/.test(c.chainId)) bad("chain.chainId must be a canonical decimal");
  if (!ADDR.test(c.addressBook)) bad("chain.addressBook must be the address book (0x + 40 lowercase hex): the platform's admin-governed bindings, read on chain");
  const rpcs = independentSources(c.rpcs, "chain.rpcs", { origin: false });
  if (!Number.isInteger(c.quorum) || c.quorum < 2 || c.quorum > rpcs.length) bad("chain.quorum must be 2..the number of rpcs (answers that agree)");
  const directories = independentSources(p.directories, "directories");
  const gateways = independentSources(p.gateways, "gateways");
  const vi = p.verifierInputs;
  if (!vi || typeof vi !== "object" || Object.keys(vi).sort().join() !== "sha256,sources" || !HEX64.test(vi.sha256)) bad("verifierInputs must be exactly { sha256 (64 lowercase hex), sources }");
  const viSources = independentSources(vi.sources, "verifierInputs.sources", { origin: false });
  const pp = p.platformPolicy;
  if (!pp || typeof pp !== "object" || !["production", "explicit"].includes(pp.mode) || Object.keys(pp).some((k) => !["mode", "config"].includes(k)))
    bad("platformPolicy must be { mode: \"production\" } or { mode: \"explicit\", config } (the admin's anchored host policy; never off)");
  if (pp.mode === "production" && pp.config !== undefined) bad("platformPolicy production takes no config");
  if (pp.mode === "explicit" && (!pp.config || typeof pp.config !== "object")) bad("platformPolicy explicit needs its { book, hostOwnership, mirrors[] } config");
  if (pp.mode === "explicit" && Number(c.chainId) === 8453 && lc(pp.config.book) !== lc(c.addressBook)) bad("platformPolicy: on Base the policy's book is the profile's address book");
  const g = p.leaseGas;
  if (!g || typeof g !== "object" || Object.keys(g).some((k) => !["file", "digest", "rpcs", "relays", "quorum"].includes(k)) || typeof g.file !== "string" || !path.isAbsolute(g.file)
      || !/^(sha256:)?[0-9a-f]{64}$/.test(g.digest || "") || !Array.isArray(g.rpcs) || !Array.isArray(g.relays))
    bad("leaseGas must be { file (absolute), digest, rpcs[], relays[], quorum? } (the app-funded lease record the owner reviewed)");
  independentSources(g.relays, "leaseGas.relays", { min: 1 });
  independentSources(g.rpcs, "leaseGas.rpcs", { origin: false });
  if (g.quorum !== undefined && (!Number.isInteger(g.quorum) || g.quorum < 1)) bad("leaseGas.quorum must be a positive integer");
  const cap = p.capacity || {};
  if (p.capacity !== undefined && (typeof cap !== "object" || Object.keys(cap).some((k) => k !== "lifetimeSec"))) bad("capacity must be { lifetimeSec }");
  const lifetimeSec = cap.lifetimeSec ?? 300;
  if (!Number.isInteger(lifetimeSec) || lifetimeSec < 60 || lifetimeSec > 900) bad("capacity.lifetimeSec must be 60..900 (a record lives at most 15 minutes)");
  const endpoint = String(p.registeredEndpoint);
  return { ...p, endpoint, enclaveId: keccak256(stringToBytes(endpoint)), chain: { ...c, rpcs }, directories, gateways,
           verifierInputs: { sha256: vi.sha256, sources: viSources }, capacity: { lifetimeSec } };
}

/** The verifier inputs document, strictly. */
export function checkVerifierInputs(d) {
  const bad = (m) => { throw new Error(`verifier inputs: ${m}`); };
  if (!d || typeof d !== "object" || Array.isArray(d)) bad("not an object");
  if (Object.keys(d).sort().join() !== "authorityHashes,codeHashes,format,rootPins,runtimeIds,tier") bad("keys must be exactly format, tier, codeHashes, authorityHashes, runtimeIds, rootPins");
  if (d.format !== VERIFIER_INPUTS_FORMAT) bad(`format must be ${VERIFIER_INPUTS_FORMAT}`);
  if (d.tier !== "pvm-cpu") bad("tier must be pvm-cpu (the only pVM tier; no GPU or TEE claim is made for a phone)");
  const list = (k, re) => { if (!Array.isArray(d[k]) || !d[k].length || d[k].length > 32 || !d[k].every((x) => re.test(x)) || new Set(d[k]).size !== d[k].length) bad(`${k}: 1..32 distinct lowercase hex values`); };
  list("codeHashes", HEX64); list("authorityHashes", HEX128); list("runtimeIds", HEX64); list("rootPins", HEX64);
  return d;
}
/** The document's exact bytes as published (compact JSON, keys sorted): what its sha256 pins. */
export function verifierInputsBytes(d) {
  checkVerifierInputs(d);
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(d).sort().map((k) => [k, d[k]]))));
}

/**
 * The pins, from the first source that serves bytes hashing to `sha256` (each source tried in order; a source serving other
 * bytes is reported, never used). A copy verified earlier is kept in `cacheFile` and used, re-verified, when no source
 * answers (a cold start with the sources down). -> { doc, source, report[] }
 */
export async function loadVerifierInputs({ sha256: want, sources, fetch = globalThis.fetch, cacheFile = null, timeoutMs = 10000 }) {
  const report = [];
  for (const url of sources) {
    try {
      const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (r.status !== 200) { report.push({ source: url, ok: false, why: `HTTP ${r.status}` }); continue; }
      const chunks = []; let n = 0;
      for await (const ch of r.body) { n += ch.length; if (n > VERIFIER_INPUTS_MAX) throw new Error("too large"); chunks.push(Buffer.from(ch)); }
      const bytes = Buffer.concat(chunks), got = sha256(bytes);
      if (got !== want) { report.push({ source: url, ok: false, why: `served other bytes (sha256 ${got.slice(0, 16)}…)` }); continue; }
      const doc = checkVerifierInputs(JSON.parse(bytes.toString("utf8")));
      if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 }); const t = `${cacheFile}.tmp-${process.pid}`; fs.writeFileSync(t, bytes, { mode: 0o600 }); fs.renameSync(t, cacheFile); }
      report.push({ source: url, ok: true });
      return { doc, source: url, report };
    } catch (e) { report.push({ source: url, ok: false, why: e.message }); }
  }
  if (cacheFile && fs.existsSync(cacheFile)) {
    const bytes = fs.readFileSync(cacheFile);
    if (sha256(bytes) === want) return { doc: checkVerifierInputs(JSON.parse(bytes.toString("utf8"))), source: "cache (verified copy)", report };
    report.push({ source: "cache", ok: false, why: "the cached copy no longer matches the pinned sha256" });
  }
  throw Object.assign(new Error(`no source served the verifier inputs ${want.slice(0, 16)}…: ${report.map((r) => `${r.source}: ${r.why}`).join("; ")}`), { report });
}

/** The lease-gas settings as the shared runtime reads them (an env object: the process environment is never changed). */
export const leaseGasEnv = (p) => ({ ENCLAVE_LEASE_GAS_FILE: p.leaseGas.file, ENCLAVE_LEASE_GAS_DIGEST: p.leaseGas.digest.replace(/^sha256:/, ""),
  ENCLAVE_LEASE_GAS_RPCS: p.leaseGas.rpcs.join(","), ENCLAVE_LEASE_GAS_RELAYS: p.leaseGas.relays.join(","),
  ...(p.leaseGas.quorum ? { ENCLAVE_LEASE_GAS_QUORUM: String(p.leaseGas.quorum) } : {}) });

/** The platform host policy settings for resolveHostPolicyConfig (never "off": the admin's bans stay enforced). */
export const platformPolicyEnv = (p) => (p.platformPolicy.mode === "production" ? { ENCLAVE_PLATFORM_HOST_POLICY: "production" }
  : { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify(p.platformPolicy.config) });

/**
 * The host agent's config in independent mode: the owner's identity, chain and replicas; the evidence pins from the verified
 * document, with exactly the build this APK is (it must be one the document approves). No relayOrigin.
 */
export function independentHostConfig({ build, setup, operator, codeHash, instanceIds, files, apk, controlPort, bundleDir, profile, inputs, poolMemMb, ports }) {
  if (!inputs.codeHashes.includes(codeHash)) throw new Error(`this APK's code hash ${codeHash} is not one the verifier inputs approve: not serving`);
  const a = path.join(files, "agent");
  return {
    format: "enclave-pvm-host-agent/v1", name: setup.name || `phone-${operator.slice(2, 14).toLowerCase()}`, independent: { endpoint: profile.endpoint },
    chainId: profile.chain.chainId, addressBook: profile.chain.addressBook, operator: lc(operator), maxFeePerGasWei: build.maxFeePerGasWei,
    register: { repo: build.repo, cpuPricePerSec6: setup.priceCpuPerSec6 || build.defaultPriceCpuPerSec6 },
    ...(setup.payoutTo ? { payout: { to: setup.payoutTo, minWithdraw6: build.minWithdraw6 } } : {}),
    evidence: { allowedCodeHashes: [codeHash], allowedAuthorityHashes: [...inputs.authorityHashes], allowedRuntimeIds: [...inputs.runtimeIds],
                rootPins: [...inputs.rootPins], instanceIds },
    device: { local: { files, apk, controlPort }, vmName: setup.vmName || "pvmhost", agentPort: ports.agent, attachPort: ports.attach },
    idleApp: path.join(bundleDir, "idle-app.wasm"),
    claim: { enabled: true, maxMemMb: 512, sweepGraceSec: 300 },
    ipfs: { gateways: [...profile.gateways], cacheDir: path.join(a, "components") },
    egress: { port: ports.egress, routesFile: path.join(a, "net", "egress-routes.json") },
    slots: { count: 32, poolMemMb, routerPort: ports.router },
  };
}

/** The Enclave network's config in independent mode: the owner's directories, RPCs and the verified tier pins; no relay, no mirror. */
export function independentNetworkConfig({ build, host, apps, files, lib, bundleDir, codeHash, nodeBinary, profile, inputs, routerPort }) {
  const a = path.join(files, "agent");
  return {
    version: 2, directory: path.join(a, "net"), operatorKeyFile: path.join(a, "operator.key"), runner: host.enclaveId, endpoint: host.endpoint,
    apps, chain: { addressBook: profile.chain.addressBook, rpc: [...profile.chain.rpcs] }, dns: build.dns,
    pvm: { appPort: routerPort, codeHashes: [codeHash], authorityHashes: [...inputs.authorityHashes], runtimeIds: [...inputs.runtimeIds] },
    enclaveNetwork: { directories: [...profile.directories], checkers: build.checkers, apps: "all", control: true, wgBinary: path.join(lib, "libenclavewg.so"),
                      nodeBinary, workerModule: path.join(bundleDir, "windows-circuit-worker.mjs") },
  };
}

/**
 * The host VM's instance, learned with no relay: its v4 evidence over a nonce made HERE, verified against the pins (the
 * pinned build, authority and runtime, Google's roots, this idle app). -> the instance id (64 hex). Throws the reason.
 * verify: relay/pvm-app-attest.mjs verifyPvmAppEvidence (passed in so the bundle carries one copy).
 */
export async function learnHostInstance({ exchange, verify, pins, idleSha, nonce = randomBytes(32).toString("hex") }) {
  let doc;
  try { doc = JSON.parse(String(await exchange(`EVIDENCE3 ${nonce}`)).split("\n")[0]); } catch (e) { throw new Error(`the host VM gave no evidence: ${e.message}`); }
  if (!doc || doc.error) throw new Error(`the host VM gave no evidence${doc && doc.error ? `: ${doc.error}` : ""}`);
  const v = verify(doc, { nonce, appId: idleSha, requireTls: false, allowedRuntimeIds: pins.allowedRuntimeIds, allowedCodeHashes: pins.allowedCodeHashes,
    allowedAuthorityHashes: pins.allowedAuthorityHashes, rootPins: pins.rootPins });
  if (!v.ok) throw new Error(`the host VM's evidence is refused: ${v.reasons.at(-1)}`);
  if (!HEX64.test(String(v.instanceId || ""))) throw new Error("the host VM's evidence binds no instance (a v3+ build is required)");
  return v.instanceId;
}

/** What independent mode cannot carry today, as a reason, or null (secrets the relay holds for this deployment). */
export function relaySecretsRefusal(configText) {
  const t = String(configText || "");
  return /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(t.replace(/\$\$/g, ""))
    ? "the app's config takes secrets ($NAME), which only the relay can release to a pVM today (the measured build pins the relay's release key): not served in independent mode"
    : null;
}
