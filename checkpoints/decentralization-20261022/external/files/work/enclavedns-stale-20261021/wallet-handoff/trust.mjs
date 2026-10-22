// The EnclaveDNS 0.1.5 release handoff pins: everything the local page may do is fixed here and rebuilt, never chosen at run
// time. After one upload authorization, two 0-ETH transactions from the app's owner (also the catalog owner) on Base:
//   1 personal_sign  enclave-upload:<frozen wasm sha256>:<expiry>        (the upload of the frozen, reviewed artifact)
//   2 publishVersion enclavedns 0.1.5 = index 5, the frozen CID, version 0.1.4's resources/ports/config VERBATIM, fee 0
//   3 ownerCall      SessionVault 0xB794… (the deployment's owner, owned by the admin) -> ledger.setAppRef(the EXISTING
//                    deployment 0x59f1273d…, catalog://<appId>/5). DIRECT owner call: the vault stays the owner and the
//                    deployment stays STAGING-held (no promote).
// Adapted from the reviewed IPNS Publisher handoff (ens-public-site-20261021/publisher-wallet-handoff/trust.mjs): the same
// shared constants (admin, ledger, book, oracle, code hashes, RPCs, fee cap, confirmations) from the existing reviewed trust
// files, unchanged; the release constants from work/enclavedns-stale-20261021 (RELEASE-PLAN, release-0.1.5-r2, reviewed
// in work/enclavedns-stale-review-20261021/REVIEW-R2.txt) and the files frozen in ./pins and ./artifact.
// No key, token or signature is ever stored here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, encodePacked, parseAbi } from "../../enclave/node_modules/viem/_esm/index.js";
import { SITE, CATALOG_ABI, LEDGER_ABI } from "../../site-host-live-publish/handoff/site-trust.mjs";
import { ENROLLMENT } from "../../lease-enrollment-signing/trust.mjs";

export { CATALOG_ABI, LEDGER_ABI };
// SessionVault (contracts/SessionVault.sol): ownerCall is DIRECT owner-only (never signable); held(id) = (env, promoted, createdBy)
export const VAULT_ABI = parseAbi(["function owner() view returns (address)", "function factory() view returns (address)",
  "function held(bytes32) view returns (uint8, bytes32, bytes32)", "function ownerCall(address target, bytes data) returns (bytes)"]);
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A frozen text file, refused unless it still has its pinned sha256. */
const pinned = (f, h) => { const s = fs.readFileSync(path.join(here, "pins", f), "utf8"); if (sha(s) !== h) throw Error(`pins/${f} is not the pinned file`); return s; };

// version 0.1.4's config, byte-equal to the chain (read 2026-10-21 at block 52906804 on both providers: sha256 2f409c56…)
const V4_CONFIG = pinned("version-config-v4.json", "2f409c560bdefbaa4011fa95650d9406251d1f8072bfc6e986c7937411dc407a");
// the deployment's public config envelope today; no step changes it
const ENVELOPE = pinned("envelope-current.json", "bc8728bc8f23a8f4d0fa6084988bff552476bd954727e5363022cdfded0a7e2a");

export const DNS = Object.freeze({
  chainId: 8453,
  admin: ENROLLMENT.admin,                         // 0x0b2d…eE61: the app's publisher, the catalog owner, the vault's owner
  book: ENROLLMENT.book, ledger: SITE.ledger, catalog: SITE.catalog, oracle: ENROLLMENT.oracle,
  codeHashes: Object.freeze({ catalog: SITE.codeHashes.catalog, ledger: SITE.codeHashes.ledger,
    vault: "0x3028a275d579db5365554abb3dc85acee22d8a6bb7ace5e230a9adb89bc92a30" }),   // the vault's 45-byte EIP-1167 clone
  catalogSchema: 9n, ledgerSchema: 16n,
  app: Object.freeze({ appId: "0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06", slug: "enclavedns", name: "EnclaveDNS",
    // the catalog's CURRENT description, verbatim (a publish rewrites name/description: they must stay exactly these)
    description: "Validating DNSSEC resolver with native .eth (ENS) and .onion resolution, served as DNS-over-HTTPS and a JSON API; signed hosted zones; no query logs." }),
  // the live version the deployment runs today, and the one this publish appends
  prev: Object.freeze({ index: 4, version: "0.1.4", cid: "bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu", configSha256: sha(V4_CONFIG) }),
  publish: Object.freeze({ index: 5, version: "0.1.5", res: Object.freeze([0, 0, 256, 16]), ports: "http:8000", config: V4_CONFIG, feePerSec6: 0n }),
  // the frozen, reviewed artifact (work/enclavedns-stale-20261021/release-0.1.5-r2, REVIEW-R2 APPROVED); never a rebuild
  wasm: Object.freeze({ path: path.join(here, "artifact/enclavedns-0.1.5.wasm"), sha256: "e3780187ebaff9e0f4f1440d8292f7e161f764825e5e2f56880150d6605ef5e9", bytes: 2588705 }),
  expectedCid: "bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau",
  vault: Object.freeze({ address: "0xb794c4dd0e1c5e6b72281799f282bfde7654345d", factory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c",
    // the deployment is held as STAGING (env 1) by the vault, created by session 0x95bf…; no step may change this
    held: Object.freeze({ env: 1, promoted: "0x" + "00".repeat(32), createdBy: "0x95bfb425bfe3ea356d08b2e8e3a2920097ad3d6de5ff60e65583f4d9ba5fcb5d" }) }),
  deployment: Object.freeze({ id: "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", envelope: ENVELOPE }),
  upload: Object.freeze({ ...SITE.upload, maxCarBytes: 2588705 + 2 * 1024 * 1024 }),
  gasCaps: Object.freeze({ publish: 1_100_000n, upgrade: 150_000n }),   // checked against the simulation at every prepare (x1.25 margin inside)
  rpcs: ENROLLMENT.rpcs, receiptRpcs: ENROLLMENT.receiptRpcs,
  maxFeePerGas: ENROLLMENT.maxFeePerGas, confirmations: ENROLLMENT.confirmations, maxAgeMs: ENROLLMENT.maxAgeMs,
  port: 39681,
});

/** The exact calls for a given trust (tests substitute fixture addresses and the test admin; production uses DNS unchanged). */
export function releasePlan(t = DNS) {
  const appId = keccak256(encodePacked(["address", "string"], [t.admin, t.app.slug]));
  const p = t.publish, d = t.deployment;
  const appRefPrev = `catalog://${appId}/${t.prev.index}`, appRefNext = `catalog://${appId}/${p.index}`;
  const publishData = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion",
    args: [t.app.slug, t.app.name, t.app.description, p.version, t.expectedCid, [...p.res], p.ports, p.config, p.feePerSec6] });
  const setAppRefData = encodeFunctionData({ abi: LEDGER_ABI, functionName: "setAppRef", args: [d.id, appRefNext] });
  const upgradeData = encodeFunctionData({ abi: VAULT_ABI, functionName: "ownerCall", args: [t.ledger, setAppRefData] });
  const tx = (step, n, title, to, data, destination) => ({ step, n, kind: "transaction", title, from: t.admin.toLowerCase(), to: to.toLowerCase(), value: "0x0", data,
    gasCap: t.gasCaps[step], destination, amountWei: "0" });
  const steps = [
    { step: "upload", n: 1, kind: "personal_sign", title: `Authorize the upload of enclavedns-0.1.5.wasm (sha256 ${t.wasm.sha256.slice(0, 12)}…, ${t.wasm.bytes} bytes) to the Enclave IPFS gateway`,
      destination: t.upload.addUrl, amountWei: "0" },
    tx("publish", 2, `Publish catalog version ${t.app.slug}:${p.version} (index ${p.index}, CID ${t.expectedCid.slice(0, 16)}…; resources, ports and config exactly as ${t.prev.version})`,
      t.catalog, publishData, "EnclaveAppCatalog " + t.catalog),
    tx("upgrade", 3, `Upgrade the existing EnclaveDNS deployment ${d.id.slice(0, 10)}… from ${t.app.slug}:${t.prev.version} to ${p.version} (through its SessionVault: ownerCall -> ledger.setAppRef; stays STAGING)`,
      t.vault.address, upgradeData, "SessionVault " + t.vault.address + " -> EnclaveDeployments " + t.ledger),
  ];
  return Object.freeze({ appId, appRefPrev, appRefNext, publishData, setAppRefData, upgradeData, steps: Object.freeze(steps.map((s) => Object.freeze(s))) });
}
