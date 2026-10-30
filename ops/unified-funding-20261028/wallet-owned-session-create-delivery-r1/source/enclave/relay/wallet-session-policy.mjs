// relay/wallet-session-policy.mjs -- the ONE resolver of a wallet-held deployment's session policy (WalletSessionVault,
// contracts/WalletSessionVault.sol + WalletSessionPolicy.sol). NEW in wallet-owned-session-create-r1; not run, not tested.
//
// Imported by every consumer that must agree on it:
//   relay/sessions.mjs          createCustodyGate().custodyRefusal  (relay/secrets.js fetch, relay/secrets-release.mjs
//                               attested release, relay/shield-secrets.mjs Shield release all call that ONE function)
//                               sessionRowRefusal                   (relay API sessions acting on one row)
//                               createSessionsService isVault       (relay SUBMISSION of a wallet vault's SessionCall)
//   windows/node/session-api-auth.mjs  verify / refusal / visible   (host api.* session authorization)
// Shipping path: relay/api-relay.js builds it from WALLET_SESSIONS_PINS (+ ledger) and hands it to the custody gate,
// sessionRowRefusal and initSessions; a host passes its own walletPolicy to createSessionApiAuth (the host-side
// construction site, supervisor.js, is outside this candidate: see REPORT.md).
//
// Identity. A record's binding is trusted only through a PINNED factory: { factory, codeHash } plus the chain id and the
// ledger the consumer already uses. The pin checks the factory's runtime code hash (which embeds its immutable
// implementation address), its PROTOCOL constant and its immutable ledger(). No operator allowlist of owners: any
// wallet uses the reviewed factory with no admission; no request-, URL- or owner()-supplied registry is consulted.
//
// Decision kinds (resolve(row)):
//   inactive        this consumer pins no wallet-session factory (explicit config: the new version is NOT activated here)
//   legacy-unbound  every pinned factory ANSWERED creatorOf(id) == 0: a proven plain-wallet / legacy row
//   bound           created and bound by a vault of a pinned factory, whose owner still holds it: { env, approved, ... }
//   detached        the binding wallet explicitly detached it (owner decision, on chain)
//   void            the binding wallet no longer holds it (it transferred it away): the binding grants nothing
//   invalid         a pinned factory names a creator but the binding is unreadable as bound/detached: refuse
// Any read failure THROWS - never a downgrade to "legacy" (callers fail closed: 503).

import { getAddress, keccak256, encodeAbiParameters, isAddress } from "viem";

export const WALLET_SESSION_PROTOCOL = keccak256(new TextEncoder().encode("enclave.wallet-session.v1"));
export const WALLET_SESSION_VERSION = "wallet-v1";
export const ENV_STAGING = 1;
export const ENV_PROD = 2;
export const BOUND = 1;
export const DETACHED = 2;
const ZERO = "0x0000000000000000000000000000000000000000";

export const walletSessionFactoryAbi = [
  { type: "function", name: "creatorOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isVault", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PROTOCOL", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
];
export const walletSessionVaultPolicyAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "env", type: "uint8" }, { name: "state", type: "uint8" }, { name: "revision", type: "uint64" },
      { name: "approved", type: "bytes32" }, { name: "createdBy", type: "bytes32" }] }] },
];

/** keccak256(abi.encode(appRef, configCid)) - WalletSessionPolicy.contentHash */
export function contentHash(appRef, configCid) {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [String(appRef ?? ""), String(configCid ?? "")]));
}

/** "catalog://0x<64 lower hex>/<n>" -> appId (lower-case), else null (SessionVaultLib.parseRef's spelling) */
export function appIdOfRef(ref) {
  const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(0|[1-9][0-9]{0,9})$/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

/** WALLET_SESSIONS_PINS="0xFactory:0xCodeHash[,...]" -> [{ factory, codeHash }]. Malformed THROWS (no silent drop). */
export function walletPinsFromEnv(env = process.env) {
  const raw = String(env.WALLET_SESSIONS_PINS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
    const [f, h, extra] = e.split(":");
    if (extra !== undefined || !isAddress(f || "") || !/^0x[0-9a-fA-F]{64}$/.test(h || ""))
      throw new Error(`WALLET_SESSIONS_PINS: "${e}" is not 0x<factory>:0x<runtime code hash>`);
    return { factory: getAddress(f), codeHash: h.toLowerCase() };
  });
}

/**
 * pc       viem public client (readContract, getCode, getChainId)
 * chainId  the chain this consumer serves (the pin is per chain)
 * ledger   () => the deployments ledger address this consumer reads rows from (a pinned factory must name the same)
 * pins     [{ factory, codeHash }] - REQUIRED (an explicit [] means "not activated here"; undefined throws)
 */
export function createWalletPolicyResolver({ pc, chainId, ledger, pins }) {
  if (!pc) throw new Error("createWalletPolicyResolver: a public client is required");
  if (!Array.isArray(pins)) throw new Error("createWalletPolicyResolver: pins must be given explicitly (an array)");
  if (!Number.isSafeInteger(Number(chainId))) throw new Error("createWalletPolicyResolver: chainId is required");
  if (typeof ledger !== "function") throw new Error("createWalletPolicyResolver: ledger() is required");
  const list = pins.map((p) => ({ factory: getAddress(p.factory), codeHash: String(p.codeHash).toLowerCase() }));
  const verified = new Map();   // factory -> ledger it was verified against (code and immutables never change)
  const vaultOwner = new Map(); // vault -> owner (initialize-once)

  async function checkPin(p) {
    const l = getAddress(await ledger());
    if (verified.get(p.factory) === l) return;
    if (Number(await pc.getChainId()) !== Number(chainId)) throw new Error("wallet-session pin: wrong chain");
    const code = await pc.getCode({ address: p.factory });
    if (!code || code === "0x" || keccak256(code).toLowerCase() !== p.codeHash)
      throw new Error(`wallet-session pin: ${p.factory} code is not the reviewed factory`);
    const [proto, fl] = await Promise.all([
      pc.readContract({ address: p.factory, abi: walletSessionFactoryAbi, functionName: "PROTOCOL" }),
      pc.readContract({ address: p.factory, abi: walletSessionFactoryAbi, functionName: "ledger" })]);
    if (String(proto).toLowerCase() !== WALLET_SESSION_PROTOCOL.toLowerCase()) throw new Error("wallet-session pin: wrong protocol");
    if (getAddress(fl) !== l) throw new Error(`wallet-session pin: ${p.factory} is bound to ledger ${fl}, not ${l}`);
    verified.set(p.factory, l);
  }

  /** is `vault` a vault of a pinned (verified) factory? -> the factory, or null. Throws on an unreadable chain. */
  async function factoryOfVault(vault) {
    const v = getAddress(vault);
    for (const p of list) {
      await checkPin(p);
      if (await pc.readContract({ address: p.factory, abi: walletSessionFactoryAbi, functionName: "isVault", args: [v] })) return p.factory;
    }
    return null;
  }

  async function ownerOfVault(v) {
    if (vaultOwner.has(v)) return vaultOwner.get(v);
    const o = getAddress(await pc.readContract({ address: v, abi: walletSessionVaultPolicyAbi, functionName: "owner" }));
    vaultOwner.set(v, o);
    return o;
  }

  /** the decision for ONE ledger row { id, owner, appRef, configCid }: read fresh every call (only immutables cached) */
  async function resolve(row) {
    const id = String(row?.id ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("wallet-session policy: row id is not a bytes32");
    if (!row?.owner || !isAddress(String(row.owner))) throw new Error("wallet-session policy: row owner unreadable");
    const holder = getAddress(row.owner);
    if (!list.length) return { kind: "inactive", id, owner: holder };
    for (const p of list) {
      await checkPin(p);
      const c = await pc.readContract({ address: p.factory, abi: walletSessionFactoryAbi, functionName: "creatorOf", args: [id] });
      if (!c || getAddress(c) === ZERO) continue;
      const vault = getAddress(c);
      const base = { id, factory: p.factory, vault, owner: holder };
      if (!(await pc.readContract({ address: p.factory, abi: walletSessionFactoryAbi, functionName: "isVault", args: [vault] })))
        return { ...base, kind: "invalid", reason: "creator is not a vault of its factory" };
      const bindingOwner = await ownerOfVault(vault);
      if (bindingOwner !== holder) return { ...base, kind: "void", bindingOwner };
      const b = await pc.readContract({ address: vault, abi: walletSessionVaultPolicyAbi, functionName: "policyOf", args: [id] });
      const env = Number(b.env), state = Number(b.state);
      const out = { ...base, bindingOwner, env, state, revision: BigInt(b.revision), approved: String(b.approved).toLowerCase(),
        createdBy: String(b.createdBy).toLowerCase() };
      if (state === DETACHED) return { ...out, kind: "detached" };
      if (state === BOUND && (env === ENV_STAGING || env === ENV_PROD)) return { ...out, kind: "bound" };
      return { ...out, kind: "invalid", reason: `binding state ${state} env ${env}` };
    }
    return { kind: "legacy-unbound", id, owner: holder };
  }

  return { resolve, factoryOfVault, pins: list.map((p) => ({ ...p })) };
}

/** Secret release for a wallet-held row (one rule for secrets.js, secrets-release.mjs, shield-secrets.mjs).
 *  null = no objection, else why not. STAGING keeps the existing staging semantics (no promotion needed); PROD needs
 *  the owner's approval of EXACTLY the row's current (appRef, configCid). */
export function walletSecretRefusal(p, row) {
  if (!p) return "wallet-session policy unresolved";
  switch (p.kind) {
    case "inactive": case "legacy-unbound": case "detached": case "void": return null;
    case "bound":
      if (p.env === ENV_STAGING) return null;
      if (p.env === ENV_PROD) {
        if (p.approved && p.approved === contentHash(row.appRef, row.configCid).toLowerCase()) return null;
        return "production deployment: its current version/config has not been approved by the owner";
      }
      return "wallet-session binding has no environment";
    default: return `wallet-session binding unreadable (${p.reason || p.kind})`;
  }
}

/** May verified session `s` ({ vault, owner, envs, anyApp, apps, version }) act on wallet-held row `row` whose policy is
 *  `p`? null = yes. A wallet-v1 session acts ONLY on rows its own vault bound; no session acts on another vault's binding. */
export function walletSessionRefusal(s, row, p) {
  const holder = String(row?.owner || "").toLowerCase();
  if (!holder || holder !== String(s.owner || "").toLowerCase()) return "This session does not belong to the deployment's owner.";
  if (p.kind !== "bound") {
    if (p.kind === "detached") return "The owner detached this deployment from session management.";
    if (p.kind === "invalid") return "This deployment's session binding is unreadable.";
    return "This deployment was not created under this wallet-session vault.";
  }
  if (String(p.vault).toLowerCase() !== String(s.vault || "").toLowerCase())
    return "This deployment is bound to another session vault.";
  if ((Number(s.envs) & p.env) === 0)
    return `This deployment is ${p.env === ENV_PROD ? "production" : "staging"}, outside this session's environments.`;
  if (!s.anyApp) {
    const app = appIdOfRef(row.appRef);
    const apps = (s.apps || []).map((a) => String(a).toLowerCase());
    if (!app || !apps.includes(app)) return "This deployment's app is outside this session's apps.";
  }
  return null;
}
