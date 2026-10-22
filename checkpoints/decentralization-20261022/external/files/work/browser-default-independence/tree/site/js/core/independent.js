/* ============================================================
   Independent mode: the dashboard works from an explicit, operator-
   or user-chosen network profile instead of Enclave's API, upload
   token service and mutable address book.

   A profile names everything the browser trusts for chain and storage:
   the contracts (the same pin document the CLI takes with
   --contract-pins), two or more RPC origins that must agree at one
   block for decisions, the payment token, the storage adapters that
   must each hold a verified copy of an upload, and optional public
   network directories. docs/network/independent-dashboard.md
   documents the format.

   This module imports nothing that binds a contract: config.js reads it
   synchronously at load, before any other binding exists. Its imports are
   pure (URL rules, hashing, the packaged default and its checks).
   An unreadable or invalid saved profile is NEVER silently replaced by
   the central defaults: config.js then pins no contracts at all, so
   nothing can be signed until the profile is fixed or removed.
   ============================================================ */

import { rpcEndpoint } from "../../../network/rpc-identity.mjs";
import { sha256Hex } from "./sha256.js";
import { parseAuthority, pinsOfAuthority } from "./authority-profile.js";
import { DEFAULT_PROFILE } from "../gen/default-profile.js";

export const PROFILE_FORMAT = "enclave-browser-profile";
export const PROFILE_KEY = "enclave_independent_profile";
export const PROFILE_MAX_BYTES = 32768;
export const BASE_CHAIN_ID = 8453;
// Never used as a URL: fetch() refuses this scheme without any network access,
// so a stray legacy call fails at once instead of reaching a central service.
export const INDEPENDENT_API_BASE = "independent-mode:";

const REQUIRED_PINS = ["registry", "deployments", "appCatalog", "proofOfTime"];
const OPTIONAL_PINS = ["enclavePay", "verificationFees", "sessionVaultFactory", "secretVaultV2"];
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDR = /^0x0{40}$/i;
const HASH32 = /^0x[0-9a-f]{64}$/;
const AUDIENCE = /^0x[0-9a-f]{64}$/;

const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(v, allowed, what){
  if (!plainObject(v)) throw new Error(what + " must be an object");
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(what + " has unknown field " + JSON.stringify(extra[0]));
}

// Rejects a JSON text that repeats a key anywhere (JSON.parse keeps the last
// one silently): a profile shown to the user must mean exactly one thing.
export function parseUniqueJSON(text){
  const value = JSON.parse(text);
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { const start = i++; while (i < text.length){ if (text[i++] === '"') break; if (text[i - 1] === "\\") i++; } return JSON.parse(text.slice(start, i)); };
  const walk = (depth) => {
    if (depth > 32) throw new Error("profile nesting too deep");
    ws(); const c = text[i++];
    if (c === "{"){
      const seen = new Set(); ws();
      if (text[i] === "}"){ i++; return; }
      for (;;){ ws(); const k = str(); if (seen.has(k)) throw new Error("duplicate key " + JSON.stringify(k)); seen.add(k); ws(); i++; walk(depth + 1); ws(); if (text[i++] === "}") return; }
    } else if (c === "["){
      ws(); if (text[i] === "]"){ i++; return; }
      for (;;){ walk(depth + 1); ws(); if (text[i++] === "]") return; }
    } else if (c === '"'){ i--; str(); }
    else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; }
  };
  walk(0);
  return value;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// HTTPS, or plain HTTP on this machine only (a local node or test chain).
function origin(raw, what, { allowLoopbackHttp = true } = {}){
  if (typeof raw !== "string" || raw.length > 512) throw new Error(what + " must be a URL");
  let u; try { u = new URL(raw); } catch { throw new Error(what + " is not a URL: " + raw); }
  const http = u.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(u.hostname);
  if (!(u.protocol === "https:" || http)) throw new Error(what + " must use HTTPS (plain HTTP only on localhost): " + raw);
  if (u.username || u.password || u.search || u.hash) throw new Error(what + " must not carry credentials, a query or a fragment: " + raw);
  return u;
}

export function validateContractPins(doc){
  exactKeys(doc, ["version", "chainId", "contracts"], "contract pins");
  if (doc.version !== 1 || doc.chainId !== BASE_CHAIN_ID) throw new Error("contract pins must be version 1 for Base (chain 8453)");
  exactKeys(doc.contracts, [...REQUIRED_PINS, ...OPTIONAL_PINS], "contract pins");
  const out = {};
  for (const k of [...REQUIRED_PINS, ...OPTIONAL_PINS]){
    const a = doc.contracts[k];
    if (typeof a !== "string" || !ADDR.test(a)) throw new Error("contract pin " + k + " is missing or not an address");
    if (REQUIRED_PINS.includes(k) && ZERO_ADDR.test(a)) throw new Error("contract pin " + k + " cannot be zero");
    out[k] = a.toLowerCase();
  }
  return out;
}

// The CLI/host storage plan, unchanged: 2–8 adapters, each with its own
// deployment audience and hostname, and a minimum number of verified copies.
export function validateStoragePlan(plan){
  exactKeys(plan, ["version", "minimumCopies", "replicas"], "storage plan");
  if (plan.version !== 1 || !Array.isArray(plan.replicas) || plan.replicas.length < 2 || plan.replicas.length > 8
    || !Number.isInteger(plan.minimumCopies) || plan.minimumCopies < 2 || plan.minimumCopies > plan.replicas.length)
    throw new Error("storage plan needs 2–8 adapters and a minimum of 2 verified copies");
  const hosts = new Set(), audiences = new Set();
  const replicas = plan.replicas.map((r) => {
    exactKeys(r, ["upload", "audience", "gateway"], "storage adapter");
    if (typeof r.audience !== "string" || !AUDIENCE.test(r.audience) || /^0x0{64}$/.test(r.audience))
      throw new Error("storage adapter audience must be its deployment id (lower-case 0x + 64 hex)");
    const u = origin(r.upload, "storage upload", { allowLoopbackHttp: false });
    const g = origin(r.gateway, "storage gateway", { allowLoopbackHttp: false });
    if (u.pathname !== "/add-json" || g.pathname.replace(/\/$/, "") !== "/ipfs" || u.origin !== g.origin)
      throw new Error("storage upload (/add-json) and readback (/ipfs) must address the same adapter origin");
    // Distinct names are necessary, not proof of distinct operators.
    if (hosts.has(u.hostname) || audiences.has(r.audience)) throw new Error("storage adapters need distinct hostnames and deployment audiences");
    hosts.add(u.hostname); audiences.add(r.audience);
    return { upload: u.href, audience: r.audience, gateway: g.href.replace(/\/$/, "") };
  });
  return { version: 1, minimumCopies: plan.minimumCopies, replicas };
}

export function validateProfile(value){
  exactKeys(value, ["format", "version", "name", "chainId", "rpcs", "quorum", "confirmations", "maxBlockAgeSeconds",
    "contractPins", "usdc", "ethUsdFeed", "storage", "directories", "source", "serviceIndex", "hostPolicyOrigins"], "profile");
  if (value.format !== PROFILE_FORMAT || value.version !== 1) throw new Error("not an " + PROFILE_FORMAT + " version 1 document");
  if (value.chainId !== BASE_CHAIN_ID) throw new Error("profile chainId must be 8453 (Base)");
  const name = value.name == null ? "" : value.name;
  if (typeof name !== "string" || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error("profile name must be a short single line");
  if (!Array.isArray(value.rpcs) || value.rpcs.length < 2 || value.rpcs.length > 8) throw new Error("profile needs 2–8 RPC origins");
  const rpcs = [], seen = new Set(), votes = new Set();
  let loopbackAliases = false;
  for (const raw of value.rpcs){
    const u = origin(raw, "RPC");
    // Distinct origins are required, not proof of distinct operators.
    if (seen.has(u.origin)) throw new Error("RPC origins must be distinct: " + raw);
    // One public host is ONE vote whatever its port, path or spelling (network/rpc-identity.mjs): three URLs on one
    // endpoint are not a quorum. Loopback (a local test chain) is one machine anyway; aliases of one loopback port
    // are accepted for local tests only and marked, so the panel can say they are not independent votes.
    let id; try { id = rpcEndpoint(raw).identity; } catch (e){ throw new Error("RPC " + raw + ": " + e.message); }
    if (votes.has(id)){
      if (!id.startsWith("loopback")) throw new Error("RPC " + raw + " is the same endpoint as another RPC in this profile: one host is one vote");
      loopbackAliases = true;
    }
    votes.add(id); seen.add(u.origin); rpcs.push(u.pathname === "/" ? u.origin : u.href);
  }
  const quorum = value.quorum == null ? 2 : value.quorum;
  if (!Number.isInteger(quorum) || quorum < 2 || quorum > rpcs.length) throw new Error("quorum must be 2 to the number of RPCs");
  const confirmations = value.confirmations == null ? 2 : value.confirmations;
  if (!Number.isInteger(confirmations) || confirmations < 0 || confirmations > 64) throw new Error("confirmations must be 0–64");
  const maxBlockAgeSeconds = value.maxBlockAgeSeconds == null ? 600 : value.maxBlockAgeSeconds;
  if (!Number.isInteger(maxBlockAgeSeconds) || maxBlockAgeSeconds < 30 || maxBlockAgeSeconds > 86400) throw new Error("maxBlockAgeSeconds must be 30–86400");
  const contracts = validateContractPins(value.contractPins);
  if (typeof value.usdc !== "string" || !ADDR.test(value.usdc) || ZERO_ADDR.test(value.usdc)) throw new Error("profile usdc must be the payment token address");
  // optional: the ETH/USD feed a reviewer recorded for the ledger. When present, ETH funding refuses any other feed
  // the ledger reports; when absent, the ledger's own on-chain feed (read at an agreed block) is used.
  const ethUsdFeed = value.ethUsdFeed == null ? null : value.ethUsdFeed;
  if (ethUsdFeed !== null && (typeof ethUsdFeed !== "string" || !ADDR.test(ethUsdFeed) || ZERO_ADDR.test(ethUsdFeed))) throw new Error("ethUsdFeed must be a nonzero address");
  // optional provenance written by scripts/network/browser-profile.mjs: the reviewed authority profile's digest
  let source = null;
  if (value.source != null){
    exactKeys(value.source, ["authorityProfileDigest", "reviewBlock"], "profile source");
    if (typeof value.source.authorityProfileDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.source.authorityProfileDigest)) throw new Error("source.authorityProfileDigest must be sha256:<64 hex>");
    if (value.source.reviewBlock != null && !/^[0-9]{1,12}$/.test(String(value.source.reviewBlock))) throw new Error("source.reviewBlock must be a block number");
    source = Object.freeze({ authorityProfileDigest: value.source.authorityProfileDigest, reviewBlock: value.source.reviewBlock == null ? null : String(value.source.reviewBlock) });
  }
  const storage = value.storage == null ? null : validateStoragePlan(value.storage);
  // optional: the EnclaveServiceIndex the page discovers untrusted service candidates from (js/core/service-discovery.js)
  let serviceIndex = null;
  if (value.serviceIndex != null){
    exactKeys(value.serviceIndex, ["address", "codeHash"], "service index pin");
    if (typeof value.serviceIndex.address !== "string" || !ADDR.test(value.serviceIndex.address) || ZERO_ADDR.test(value.serviceIndex.address)) throw new Error("serviceIndex.address must be the index contract");
    if (typeof value.serviceIndex.codeHash !== "string" || !HASH32.test(value.serviceIndex.codeHash.toLowerCase())) throw new Error("serviceIndex.codeHash must be keccak256 of its runtime code");
    serviceIndex = Object.freeze({ address: value.serviceIndex.address.toLowerCase(), codeHash: value.serviceIndex.codeHash.toLowerCase() });
  }
  // optional: origins that mirror host admission policies by their on-chain hash (bytes, never authority)
  const mirrors = value.hostPolicyOrigins == null ? [] : value.hostPolicyOrigins;
  if (!Array.isArray(mirrors) || mirrors.length > 8) throw new Error("hostPolicyOrigins must be a list of at most 8 origins");
  const hostPolicyOrigins = [...new Set(mirrors.map((raw) => {
    const u = origin(raw, "host policy mirror", { allowLoopbackHttp: false });
    if (u.pathname !== "/") throw new Error("host policy mirror must be a bare https origin: " + raw);
    return u.origin;
  }))];
  const dirs = value.directories == null ? [] : value.directories;
  if (!Array.isArray(dirs) || dirs.length > 8) throw new Error("directories must be a list of at most 8 origins");
  const directories = [...new Set(dirs.map((raw) => {
    if (typeof raw !== "string") throw new Error("directory must be a URL");
    let u; try { u = new URL(raw); } catch { throw new Error("directory is not a URL: " + raw); }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/")
      throw new Error("directory must be a bare http(s) origin: " + raw);
    return u.origin;
  }))];
  return Object.freeze({ format: PROFILE_FORMAT, version: 1, name, chainId: BASE_CHAIN_ID, rpcs: Object.freeze(rpcs), quorum,
    confirmations, maxBlockAgeSeconds, contracts: Object.freeze(contracts), usdc: value.usdc.toLowerCase(),
    ethUsdFeed: ethUsdFeed && ethUsdFeed.toLowerCase(), source,
    storage: storage && Object.freeze(storage), directories: Object.freeze(directories),
    serviceIndex, hostPolicyOrigins: Object.freeze(hostPolicyOrigins), loopbackAliases });
}

export function parseProfile(text){
  if (typeof text !== "string") throw new Error("profile must be JSON text");
  if (new TextEncoder().encode(text).length > PROFILE_MAX_BYTES) throw new Error("profile is larger than 32 KiB");
  return validateProfile(parseUniqueJSON(text));
}

// SHA-256 of the exact saved text: what a user compares with the publisher's
// announced profile before trusting it.
export async function profileFingerprint(text){
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* A site operator can ship a mirror that starts in independent mode by
   building it with this set to a profile's exact JSON text. Enclave's own
   build leaves it null; a saved browser profile always takes precedence. */
export const BUILT_IN_PROFILE_TEXT = null;

function storage(){ try { return globalThis.localStorage || null; } catch { return null; } }
function tabStorage(){ try { return globalThis.sessionStorage || null; } catch { return null; } }
const ACK_KEY = "enclave_independent_ack";
// The explicit choice of Enclave's hosted service over a packaged independent default: remembered per browser, but
// honoured only in a tab that confirmed it (a planted value never moves anyone to the hosted service on its own).
export const HOSTED_OPTIN_KEY = "enclave_hosted_optin";
const HOSTED_ACK_KEY = "enclave_hosted_ack";
export const DEFAULT_PROFILE_FORMAT = "enclave-default-profile/v1";

export function pageIsLoopback(){
  try { const h = String(globalThis.location && globalThis.location.hostname || "").toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "[::1]"; }
  catch { return false; }
}

/* The default profile packaged with this build (js/gen/default-profile.js), checked before anything binds:
     - the browser profile text and the reviewed authority profile hash to the digests compiled beside them (a
       substituted or damaged text is refused, never used);
     - the authority profile is canonical and has the reviewed v1 layout (js/core/authority-profile.js);
     - the profile names that authority (source.authorityProfileDigest), its eight contract pins, payment token and
       reviewed ETH/USD feed are exactly the authority's;
     - a PROVISIONAL (test) build only runs on a loopback origin, and only a provisional one may use loopback RPCs.
   The on-chain half (code hashes and bindings at an agreed block) is js/core/default-authority.js. */
export function checkPackagedDefault(pkg, { loopback = pageIsLoopback() } = {}){
  if (!pkg || typeof pkg !== "object" || pkg.format !== DEFAULT_PROFILE_FORMAT) throw new Error("the packaged default profile is not an " + DEFAULT_PROFILE_FORMAT + " module");
  const provisional = pkg.provisional === true;
  if (provisional && !loopback) throw new Error("this build carries a PROVISIONAL test profile, which only runs on a loopback origin");
  if (typeof pkg.profileText !== "string" || typeof pkg.profileDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(pkg.profileDigest))
    throw new Error("the packaged default profile has no digest");
  const profileDigest = "sha256:" + sha256Hex(pkg.profileText);
  if (profileDigest !== pkg.profileDigest) throw new Error("the packaged default profile does not match its digest " + pkg.profileDigest + " (got " + profileDigest + "): substituted or damaged");
  const profile = parseProfile(pkg.profileText);
  const { profile: authority } = parseAuthority(pkg.authorityText, { expectedDigest: pkg.authorityDigest });
  if (!profile.source || profile.source.authorityProfileDigest !== pkg.authorityDigest)
    throw new Error("the packaged default profile does not name the packaged authority profile");
  const pins = pinsOfAuthority(authority);
  for (const [k, a] of Object.entries(pins)) if (profile.contracts[k] !== a)
    throw new Error("the packaged default pins " + k + " " + profile.contracts[k] + ", not the reviewed " + a);
  if (profile.usdc !== authority.contracts.usdc.address) throw new Error("the packaged default's payment token is not the reviewed one");
  const feed = authority.contracts.deployments.reviewedState.ethUsdFeed;
  if (profile.ethUsdFeed && profile.ethUsdFeed !== feed) throw new Error("the packaged default's ETH/USD feed is not the reviewed one");
  if (!provisional && profile.rpcs.some((u) => LOOPBACK.has(new URL(u).hostname))) throw new Error("a published default profile cannot name loopback RPCs");
  return { profile, authority, profileDigest, authorityDigest: pkg.authorityDigest, gateDigest: pkg.gateDigest || null, provisional };
}

/* { state, profile, text, source, error, authority, packaged, hosted }:
     "off"         no profile: the hosted defaults apply (no packaged default, or a hosted choice confirmed in this tab);
     "on"          the profile rules every chain/storage binding;
     "unconfirmed" a SAVED profile this tab has not confirmed yet - nothing is pinned or signed until the user
                   reviews it (name, fingerprint, contracts) and confirms. localStorage outlives whatever wrote it,
                   and this text decides which contracts a wallet signs against, so a value planted by a past XSS
                   or a shared browser never becomes active on its own. A built-in profile ships with the code
                   itself and needs no confirmation;
     "invalid"     a profile exists but cannot be used: nothing is pinned or signed, and nothing falls back.
   source: "saved" (the owner's own choice; takes precedence), "built-in" (a mirror's BUILT_IN_PROFILE_TEXT), or
   "default" (the reviewed profile packaged with this build; its authority is checked on chain before anything is
   signed). `packaged` describes the packaged default even when a saved profile is in use, so the panel can offer it. */
export function loadProfileState(store = storage(), builtIn = BUILT_IN_PROFILE_TEXT, tab = tabStorage(), packagedModule = DEFAULT_PROFILE,
  { loopback = pageIsLoopback() } = {}){
  const read = (s, k) => { try { return s ? s.getItem(k) : null; } catch { return null; } };
  let packaged = null, packagedError = null;
  if (packagedModule != null){
    try { packaged = checkPackagedDefault(packagedModule, { loopback }); }
    catch (e){ packagedError = String((e && e.message) || e); }
  }
  const hostedChosen = packagedModule != null && read(store, HOSTED_OPTIN_KEY) === "1";
  const hosted = { chosen: hostedChosen, confirmed: hostedChosen && read(tab, HOSTED_ACK_KEY) === "1" };
  const base = { packaged: packaged && { profileDigest: packaged.profileDigest, authorityDigest: packaged.authorityDigest, gateDigest: packaged.gateDigest,
    provisional: packaged.provisional, name: packaged.profile.name }, packagedError, hosted, authority: null };
  let text = read(store, PROFILE_KEY), source = null;
  if (text != null) source = "saved";
  else if (builtIn != null){ text = builtIn; source = "built-in"; }
  if (text != null){
    let profile;
    try { profile = parseProfile(text); }
    catch (e){ return { ...base, state: "invalid", profile: null, text, source, error: String((e && e.message) || e) }; }
    const ack = read(tab, ACK_KEY);
    const state = source === "built-in" || ack === text ? "on" : "unconfirmed";
    return { ...base, state, profile, text, source, error: null };
  }
  if (packagedModule == null) return { ...base, state: "off", profile: null, text: null, source: null, error: null };
  // the packaged default: an explicit hosted choice confirmed in THIS tab is the only way off it
  if (hosted.confirmed) return { ...base, state: "off", profile: null, text: null, source: null, error: null };
  if (!packaged) return { ...base, state: "invalid", profile: null, text: packagedModule && packagedModule.profileText || null, source: "default", error: packagedError };
  return { ...base, state: "on", profile: packaged.profile, text: packagedModule.profileText, source: "default", error: null, authority: packaged.authority };
}

/* The explicit hosted choice (never automatic): remembered, and honoured in this tab now. */
export function chooseHostedService(store = storage(), tab = tabStorage()){
  if (!store || !tab) throw new Error("this browser has no storage for the choice");
  store.setItem(HOSTED_OPTIN_KEY, "1"); tab.setItem(HOSTED_ACK_KEY, "1");
}
export function confirmHostedService(tab = tabStorage()){ if (!tab) throw new Error("this browser has no session storage"); tab.setItem(HOSTED_ACK_KEY, "1"); }
export function returnToDefault(store = storage(), tab = tabStorage()){
  if (store){ store.removeItem(HOSTED_OPTIN_KEY); store.removeItem(PROFILE_KEY); }
  if (tab){ tab.removeItem(HOSTED_ACK_KEY); tab.removeItem(ACK_KEY); }
}

// Saving is an explicit user action in this tab, so it also confirms the profile here.
export function saveProfile(text, store = storage(), tab = tabStorage()){
  const profile = parseProfile(text);          // never persist something that would not load
  if (!store) throw new Error("this browser has no local storage for the profile");
  store.setItem(PROFILE_KEY, text);
  if (tab) tab.setItem(ACK_KEY, text);
  return profile;
}
export function confirmSavedProfile(store = storage(), tab = tabStorage()){
  const text = store && store.getItem(PROFILE_KEY);
  if (text == null) throw new Error("no saved profile to confirm");
  parseProfile(text);
  if (!tab) throw new Error("this browser has no session storage");
  tab.setItem(ACK_KEY, text);
}
export function clearProfile(store = storage(), tab = tabStorage()){
  if (store) store.removeItem(PROFILE_KEY);
  if (tab) tab.removeItem(ACK_KEY);
}
