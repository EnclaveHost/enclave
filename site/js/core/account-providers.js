/* ============================================================
   Owner accounts that are existing, audited passkey smart accounts
   (independent mode). No Enclave account, RP, relay, bundler or
   paymaster is required; nothing here deploys, signs or pays.

   Providers are PINNED: each contract an account relies on is named
   by address AND by the keccak256 of its deployed runtime code, as
   observed on Base at block 52,836,800 (three independent public RPCs
   agreeing). Safe's core contracts also match Safe's own published
   codeHash. Sources, revisions and audits are listed per provider and
   in work/claude-passkey-account-result.md.

   This module only READS, at one block the profile's RPCs agree on:
   - verifyProviderDeployment: every pinned contract still has exactly
     the pinned code (a mismatch means "do not trust this provider here");
   - identifyAccount: what an owner address is - a Safe on the pinned
     singleton (its owners, which of them are passkey signers from the
     pinned factory or shared signer, its threshold, modules, fallback
     handler and guard), a Coinbase Smart Wallet on the pinned
     implementation (its owners: addresses and passkeys), an EIP-7702
     delegated EOA, an EOA, or an unrecognized contract - and the
     plain warnings that follow from it;
   - validateAccountTransport: an owner-chosen ERC-4337 bundler/paymaster
     set for a provider (HTTPS, distinct origins, the provider's
     EntryPoint, never only Enclave-operated). Nothing sends user ops yet.

   Signatures stay the contracts' business: SessionVault asks the account
   (ERC-1271) and USDC does the same for EIP-3009 deposits; owner-signature.js
   simulates the exact call before anything is submitted. Nothing here
   verifies WebAuthn or P-256 itself.
   ============================================================ */
import { reader as quorumReader } from "./independent-chain.js";
import { keccak256Hex } from "./keccak.js";

export const PIN_BLOCK = 52836800;
const SENTINEL = "0x0000000000000000000000000000000000000001";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => String(a || "").toLowerCase();

/* ---- the pinned providers (Base, chain 8453) ---- */
export const PROVIDERS = Object.freeze({
  "safe-passkey": Object.freeze({
    id: "safe-passkey", label: "Safe v1.4.1 with Safe passkey signers (v0.2.1)", chainId: 8453, preferred: true,
    entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",            // v0.7 (Safe4337Module v0.3.0 SUPPORTED_ENTRYPOINT)
    contracts: Object.freeze({
      safeL2:               { address: "0x29fcb43b46531bca003ddc8fcb67ffe91900c762", codeHash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff" },
      safeProxyFactory:     { address: "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67", codeHash: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317" },
      fallbackHandler:      { address: "0xfd0732dc9e303f09fcef3a7388ad10a83459ec99", codeHash: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9" },
      webauthnSignerFactory:{ address: "0x1d31f259ee307358a26dfb23eb365939e8641195", codeHash: "0x655b1f71eedf5aa223c8a7f5fc70f140a6475259a030829bc731642e181e4853" },
      webauthnSharedSigner: { address: "0x94a4f6affbd8975951142c3999aeab7ecee555c2", codeHash: "0xeaa32d0280053e2feea48a7c3fa15a535cd07c23ff60c9469cfa1999533e9332" },
      daimoP256Verifier:    { address: "0xc2b78104907f722dabac4c69f826a522b2754de4", codeHash: "0x3cd725b6ba67b40b7979190c41a015e82cf21e098eb61832ba623f8538bab7fc" },
      safe4337Module:       { address: "0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226", codeHash: "0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0" },
      safeModuleSetup:      { address: "0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47", codeHash: "0xaf2d170bb766d2773c3fa88717f5b3599827478074d3767d1dee55e5c2f3fbcb" },
      entryPoint:           { address: "0x0000000071727de22e5e9d8baf0edac6f37da032", codeHash: "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58" },
      // Safe v1.4.1 MultiSend (delegatecalled by Safe.setup to enable the 4337 module AND configure the shared passkey signer in
      // one initializer - Safe's own 4337-passkeys reference) and MultiSendCallOnly (CALL-only batches from the Safe); both
      // match safe-deployments v1.4.1's published codeHash on Base at the pin block
      multiSend:            { address: "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526", codeHash: "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77" },
      multiSendCallOnly:    { address: "0x9641d764fc13c8b624c04430c7356c1c7c8102e2", codeHash: "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939" },
    }),
    sources: [
      "https://github.com/safe-global/safe-deployments (e9cc9798ab834e7fe515d361566eb4a28c65387f, v1.4.1 assets: published codeHash)",
      "https://github.com/safe-fndn/safe-modules/tree/9e5f3d0701c4bd5d5fa4ce8ff7d5206f2ccc4acc/modules/passkey (release passkey/v0.2.1)",
      "https://github.com/safe-global/safe-modules-deployments (bc4d80f7de099b8926edc211d65d86b053ff6b85, safe-passkey-module/v0.2.1, safe-4337-module/v0.3.0)",
      "https://github.com/safe-global/safe-deployments/tree/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.4.1 (multi_send.json, multi_send_call_only.json: canonical address and codeHash)",
      "https://github.com/safe-fndn/safe-modules/blob/9e5f3d0701c4bd5d5fa4ce8ff7d5206f2ccc4acc/examples/4337-passkeys/src/logic/safe.ts (the shared-signer setup: MultiSend[enableModules, configure])",
    ],
    audits: ["passkey v0.2.1: Hats Finance competition, Certora, Nethermind (shared signer included)",
             "4337 module v0.3.0: Ackee Blockchain, Certora, Nethermind"],
  }),
  "coinbase-smart-wallet": Object.freeze({
    id: "coinbase-smart-wallet", label: "Coinbase Smart Wallet v1.1", chainId: 8453, preferred: false,
    entryPoint: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",            // v0.6 (CoinbaseSmartWallet.entryPoint())
    contracts: Object.freeze({
      factory:        { address: "0xba5ed110efdba3d005bfc882d75358acbbb85842", codeHash: "0xb60a629aa7c6af9b550871fd21b67ab84638156683cec68491049cb5d235ed2f" },
      implementation: { address: "0x00000110dcdedc9581cb5ecb8467282f2926534d", codeHash: "0x136185896fc519277ec953c0b3d048fc0c9f607b8d04022e60f23ef8dbc6c4d5" },
      entryPoint:     { address: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", codeHash: "0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70" },
    }),
    sources: ["https://github.com/coinbase/smart-wallet/tree/a4e83fd36c47b64cb4e21e1fa6bb9b04181a66da (release v1.1.0)",
              "https://github.com/base-org/webauthn-sol/tree/619f20ab0f074fef41066ee4ab24849a913263b2"],
    audits: ["Cantina (Dec 2023, Apr 2024), Certora (Feb 2024), Code4rena (Mar 2024) - all before the small v1.1 change"],
  }),
});

/* ---- tiny ABI readers (the answers are fixed-shape; nothing here parses untrusted structure beyond bounds) ---- */
const strip = (h) => String(h || "").replace(/^0x/, "");
const wordAt = (h, i) => { const s = strip(h); if (s.length < (i + 1) * 64) throw new Error("short ABI answer"); return s.slice(i * 64, i * 64 + 64); };
const uintAt = (h, i) => BigInt("0x" + wordAt(h, i));
const addrAt = (h, i) => "0x" + wordAt(h, i).slice(24);
const pad = (v) => strip(typeof v === "bigint" ? v.toString(16) : v).padStart(64, "0");
function addrArray(h, headIndex){                               // address[] at the offset stored in word headIndex
  const off = Number(uintAt(h, headIndex)) / 32, n = Number(uintAt(h, off));
  if (!Number.isSafeInteger(n) || n > 64) throw new Error("implausible array length");
  return Array.from({ length: n }, (_, i) => addrAt(h, off + 1 + i));
}
function bytesAt(h, headIndex){
  const off = Number(uintAt(h, headIndex)) / 32, n = Number(uintAt(h, off));
  if (!Number.isSafeInteger(n) || n > 4096) throw new Error("implausible bytes length");
  return "0x" + strip(h).slice((off + 1) * 64, (off + 1) * 64 + n * 2);
}
const SEL = { masterCopy: "a619486e", getOwners: "a0e67e2b", getThreshold: "e75235b8", getModulesPaginated: "cc2f8452",
  getStorageAt: "5624b25b", getConfiguration: "6bd50cef", getConfigurationOf: "c44b11f7", getSigner: "a541d91a",
  implementation: "5c60da1b", nextOwnerIndex: "d948fd2e", ownerAtIndex: "8ea69029", entryPoint: "b0d691fe" };
const FALLBACK_SLOT = "6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const GUARD_SLOT = "4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

/* ---- deployment check ---- */
export async function verifyProviderDeployment(providerId, { reader = quorumReader(), providers = PROVIDERS } = {}){
  const p = providers[providerId];
  if (!p) throw new Error("unknown account provider");
  const snap = await reader.snapshot();
  const rows = [];
  for (const [name, c] of Object.entries(p.contracts)){
    const code = await reader.code(snap, c.address);
    const hash = code && code !== "0x" ? keccak256Hex(code).toLowerCase() : null;
    rows.push({ name, address: c.address, ok: hash === c.codeHash, observed: hash });
  }
  return { provider: p.id, block: snap.number, ok: rows.every((r) => r.ok), rows };
}

/* ---- what an owner address is ---- */
const decodeVerifiers = (v) => ({ precompile: "0x" + (v >> 160n).toString(16).padStart(4, "0"), fallback: "0x" + (v & ((1n << 160n) - 1n)).toString(16).padStart(40, "0") });

async function identifySafe(reader, snap, account, singleton){
  const p = PROVIDERS["safe-passkey"], C = p.contracts;
  const call = (data) => reader.call(snap, account, "0x" + data);
  const owners = addrArray(await call(SEL.getOwners), 0);
  const threshold = Number(uintAt(await call(SEL.getThreshold), 0));
  const mods = await call(SEL.getModulesPaginated + pad(SENTINEL) + pad(20n));
  const modules = addrArray(mods, 0).map((m) => ({ address: lower(m), known: lower(m) === C.safe4337Module.address }));
  const storageWord = async (slot) => "0x" + bytesAt(await call(SEL.getStorageAt + pad(slot) + pad(1n)), 0).slice(2 + 24, 2 + 64);
  const fallbackHandler = lower(await storageWord(FALLBACK_SLOT)), guard = lower(await storageWord(GUARD_SLOT));
  const out = [];
  for (const o of owners){
    const a = lower(o), code = await reader.code(snap, a);
    if (!code || code === "0x"){ out.push({ kind: "eoa", address: a }); continue; }
    // an EIP-7702-delegated wallet key: the key itself still signs (ECDSA), whatever its delegate allows
    const d7702 = /^0xef0100([0-9a-f]{40})$/.exec(lower(code));
    if (d7702){ out.push({ kind: "delegated-eoa", address: a, delegate: "0x" + d7702[1] }); continue; }
    if (a === C.webauthnSharedSigner.address){
      const cfg = await reader.call(snap, a, "0x" + SEL.getConfigurationOf + pad(account));
      const v = uintAt(cfg, 2);
      out.push({ kind: "passkey", address: a, via: "shared signer", x: "0x" + wordAt(cfg, 0), y: "0x" + wordAt(cfg, 1), verifiers: decodeVerifiers(v), configured: uintAt(cfg, 0) !== 0n });
      continue;
    }
    // a per-passkey signer proxy counts only if the PINNED factory derives exactly this address from its configuration
    let passkey = null;
    try {
      const cfg = await reader.call(snap, a, "0x" + SEL.getConfiguration);
      const x = uintAt(cfg, 0), y = uintAt(cfg, 1), v = uintAt(cfg, 2);
      const derived = lower(addrAt(await reader.call(snap, C.webauthnSignerFactory.address, "0x" + SEL.getSigner + pad(x) + pad(y) + pad(v)), 0));
      if (derived === a) passkey = { kind: "passkey", address: a, via: "signer factory", x: "0x" + pad(x), y: "0x" + pad(y), verifiers: decodeVerifiers(v) };
    } catch { /* not a passkey signer proxy */ }
    out.push(passkey || { kind: "contract", address: a });
  }
  const warnings = [];
  const passkeys = out.filter((o) => o.kind === "passkey");
  if (owners.length === 1) warnings.push("One owner: losing that key loses the account. Add a second passkey (from another device or RP) or a recovery key.");
  else if (threshold === 1) warnings.push("Threshold 1: any single owner can act alone, including changing the owners.");
  if (owners.length - threshold < 1 && owners.length > 1) warnings.push("No spare key: losing any one key blocks the account (owners equal the threshold).");
  if (!passkeys.length) warnings.push("No passkey owner: this Safe is controlled only by wallet keys or other contracts.");
  if (passkeys.some((k) => k.via === "shared signer" && !k.configured)) warnings.push("The shared passkey signer is an owner but holds no key for this Safe.");
  if (passkeys.length) warnings.push("The passkey check binds the challenge and requires user verification, but not the website (origin) or RP: use passkeys from RPs whose domains serve no untrusted pages.");
  for (const m of modules) if (!m.known) warnings.push("Module " + m.address + " is enabled: a module can execute transactions without the owners' signatures. Review it or disable it.");
  if (/^0x0{40}$/.test(fallbackHandler)) warnings.push("No fallback handler: ERC-1271 signatures (sessions, USDC authorizations) cannot be checked.");
  // the pinned Safe4337Module is itself a CompatibilityFallbackHandler (contract Safe4337Module is IAccount, HandlerContext,
  // CompatibilityFallbackHandler): Safes set up for ERC-4337 use it as their fallback handler
  else if (fallbackHandler !== C.fallbackHandler.address && fallbackHandler !== C.safe4337Module.address) warnings.push("Fallback handler " + fallbackHandler + " is not the pinned CompatibilityFallbackHandler: its ERC-1271 answers are unreviewed.");
  if (!/^0x0{40}$/.test(guard)) warnings.push("Guard " + guard + " is set: it can block this Safe's transactions.");
  return { provider: "safe-passkey", version: "1.4.1", recognized: lower(singleton) === C.safeL2.address, singleton: lower(singleton), owners: out, threshold,
    modules, fallbackHandler, guard, entryPoint: p.entryPoint, warnings };
}

async function identifyCoinbase(reader, snap, account, impl){
  const p = PROVIDERS["coinbase-smart-wallet"];
  const n = Number(uintAt(await reader.call(snap, account, "0x" + SEL.nextOwnerIndex), 0));
  if (!Number.isSafeInteger(n) || n > 64) throw new Error("implausible owner count");
  const owners = [];
  for (let i = 0; i < n; i++){
    const b = bytesAt(await reader.call(snap, account, "0x" + SEL.ownerAtIndex + pad(BigInt(i))), 0);
    const len = (b.length - 2) / 2;
    if (len === 32) owners.push({ kind: "eoa-or-contract", index: i, address: "0x" + b.slice(2 + 24) });
    else if (len === 64) owners.push({ kind: "passkey", index: i, x: "0x" + b.slice(2, 66), y: "0x" + b.slice(66) });
    // len 0: a removed owner
  }
  const recognized = lower(impl) === p.contracts.implementation.address;
  const warnings = ["Any one owner of this account can act alone, including upgrading the account and removing every other owner: there is no threshold or timelock."];
  if (owners.length === 1) warnings.unshift("One owner: losing that key loses the account. Add a second passkey or a recovery key.");
  if (owners.some((o) => o.kind === "passkey")) warnings.push("This account's passkey check does not require user verification and binds neither the website (origin) nor the RP: use passkeys from RPs whose domains serve no untrusted pages.");
  if (!recognized) warnings.push("The account has been upgraded to implementation " + lower(impl) + ", which is not the pinned v1.1 code: treat it as unrecognized.");
  return { provider: "coinbase-smart-wallet", version: recognized ? "1.1" : "unknown", recognized, implementation: lower(impl), owners, threshold: 1,
    entryPoint: p.entryPoint, warnings };
}

/** What `address` is, at one agreed block. Never throws for an unrecognized contract; throws only on no agreement. */
export async function identifyAccount(address, { reader = quorumReader() } = {}){
  if (!ADDR.test(address || "")) throw new Error("an account address is required");
  const a = lower(address);
  const snap = await reader.snapshot();
  const code = lower(await reader.code(snap, a));
  const base = { address: a, block: snap.number };
  if (!code || code === "0x") return { ...base, provider: "eoa", recognized: true, owners: [], warnings: ["An ordinary wallet key: no passkey, no threshold and no recovery beyond the key itself."] };
  const d = /^0xef0100([0-9a-f]{40})$/.exec(code);
  if (d) return { ...base, provider: "delegated-eoa", delegate: "0x" + d[1], recognized: false, owners: [],
    warnings: ["An EIP-7702-delegated wallet key: the original key keeps full control, whatever the delegate allows."] };
  // a contract with a permissive fallback answers unknown selectors with empty success: only a full word counts
  const tryCall = async (data) => { try { const r = await reader.call(snap, a, "0x" + data); return strip(r).length >= 64 ? r : null; } catch { return null; } };
  const mc = await tryCall(SEL.masterCopy);
  if (mc){
    const singleton = addrAt(mc, 0);
    if (lower(singleton) === PROVIDERS["safe-passkey"].contracts.safeL2.address) return { ...base, ...(await identifySafe(reader, snap, a, singleton)) };
    return { ...base, provider: "safe-unrecognized", singleton: lower(singleton), recognized: false, owners: [],
      warnings: ["A Safe on singleton " + lower(singleton) + ", which is not the pinned Safe v1.4.1 L2 code."] };
  }
  const impl = await tryCall(SEL.implementation), ep = await tryCall(SEL.entryPoint);
  if (impl && ep && lower(addrAt(ep, 0)) === PROVIDERS["coinbase-smart-wallet"].entryPoint) return { ...base, ...(await identifyCoinbase(reader, snap, a, addrAt(impl, 0))) };
  return { ...base, provider: "contract-unknown", recognized: false, owners: [],
    warnings: ["An unrecognized contract account: sessions still work if it answers ERC-1271, but this page cannot describe its owners or recovery."] };
}

/* ---- owner-chosen ERC-4337 transport (validated now; used when user operations are added) ---- */
const enclaveHost = (h) => h === "enclave.host" || h.endsWith(".enclave.host");
// a bundler the owner runs on this computer (loopback) needs no certificate; anything else is https
const loopback = (h) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(String(h).toLowerCase());
export function validateAccountTransport(t){
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("account transport must be an object");
  const extra = Object.keys(t).filter((k) => !["provider", "entryPoint", "bundlers", "paymaster"].includes(k));
  if (extra.length) throw new Error("unknown account transport fields: " + extra.join(", "));
  const p = PROVIDERS[t.provider];
  if (!p) throw new Error("account transport names an unknown provider");
  if (lower(t.entryPoint) !== p.entryPoint) throw new Error("this provider uses EntryPoint " + p.entryPoint + "; the transport names " + t.entryPoint);
  if (!Array.isArray(t.bundlers) || t.bundlers.length < 1 || t.bundlers.length > 8) throw new Error("name 1 to 8 bundler endpoints");
  const hosts = t.bundlers.map((u) => {
    let x; try { x = new URL(u); } catch { throw new Error("bundler endpoint is not a URL: " + u); }
    if (!(x.protocol === "https:" || (x.protocol === "http:" && loopback(x.hostname))) || x.username || x.password || x.hash)
      throw new Error("bundler endpoints must be plain https URLs (http only on this computer's loopback): " + u);
    return x.hostname.toLowerCase();
  });
  if (new Set(hosts).size !== hosts.length) throw new Error("bundler endpoints must be on distinct hosts");
  if (hosts.every(enclaveHost)) throw new Error("every bundler named is Enclave-operated: name at least one you or another operator run");
  let paymaster = null;
  if (t.paymaster != null){
    const m = t.paymaster;
    if (!m || typeof m !== "object" || !["erc20", "verifying"].includes(m.kind) || !ADDR.test(m.address || "")) throw new Error("paymaster needs a kind (erc20 or verifying) and an address");
    let u; try { u = new URL(m.url); } catch { throw new Error("paymaster needs an https url"); }
    if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback(u.hostname))) || u.username || u.password) throw new Error("paymaster needs a plain https url");
    paymaster = { kind: m.kind, address: lower(m.address), url: m.url, enclaveOperated: enclaveHost(u.hostname.toLowerCase()) };
  }
  return { provider: p.id, entryPoint: p.entryPoint, bundlers: [...t.bundlers], paymaster,
    gas: paymaster ? (paymaster.kind === "erc20" ? "the paymaster charges gas in a token (its terms apply)" : "the paymaster sponsors gas under its own policy") : "the account pays gas in ETH itself" };
}
