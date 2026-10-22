// The IPNS Publisher release handoff pins: everything the local page may do is fixed here and rebuilt, never chosen at
// run time. Three 0-ETH transactions from the app's owner (also the catalog owner) on Base, after one upload authorization:
//   1 personal_sign  enclave-upload:<frozen wasm sha256>:<expiry>  (the upload of the frozen, tested artifact)
//   2 publishVersion ipns-publisher 1.0.6 = index 6, the frozen CID, version 1.0.5's resources/ports/config VERBATIM, fee 0
//   3 setAppRef      the EXISTING deployment d9798e4c… -> catalog://<appId>/6           (enclave upgrade <id> 1.0.6)
//   4 setConfig      the same deployment's public envelope with ONLY config.ipni.announceAllBlocks false -> true
// No new deployment, contract, deposit, transfer or other spending. Reviewed shared constants (admin, ledger, book,
// oracle, code hashes, RPCs, fee cap, confirmations) come from the existing reviewed trust files, unchanged; the release
// constants from worker 9d's composed-release (release-prep.json, wallet-prep.json) and the files frozen in ./pins and
// ./artifact. No key, token or signature is ever stored here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, encodePacked } from "../../enclave/node_modules/viem/_esm/index.js";
import { SITE, CATALOG_ABI, LEDGER_ABI } from "../../site-host-live-publish/handoff/site-trust.mjs";
import { ENROLLMENT } from "../../lease-enrollment-signing/trust.mjs";

export { CATALOG_ABI, LEDGER_ABI };
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A frozen text file, refused unless it still has its pinned sha256. */
const pinned = (f, h) => { const s = fs.readFileSync(path.join(here, "pins", f), "utf8"); if (sha(s) !== h) throw Error(`pins/${f} is not the pinned file`); return s; };

const V5_CONFIG = pinned("version-config-v5.json", "c681a628454c9ffef5522cd5e3fd570aab0480307a91d7afd735cec9fce2b2ee");
const ENVELOPE_CURRENT = pinned("envelope-current.json", "d59dc724df6a1784e9bb55eead51ffe991526260a1db6a89bd6ef15ddf7510c8");
const ENVELOPE_NEW = pinned("envelope-new.json", "d92631c621a0888d67463516a76f3d14aa396e6dd15c5301c927fbe594a1a18c");

export const PUB = Object.freeze({
  chainId: 8453,
  admin: ENROLLMENT.admin,                         // 0x0b2d…eE61: the app's publisher, the deployment's owner, the catalog owner
  book: ENROLLMENT.book, ledger: SITE.ledger, catalog: SITE.catalog, oracle: ENROLLMENT.oracle,
  codeHashes: Object.freeze({ catalog: SITE.codeHashes.catalog, ledger: SITE.codeHashes.ledger }),
  catalogSchema: 9n, ledgerSchema: 16n,
  app: Object.freeze({ appId: "0x9afdfb401d6f2cfea70c446f9f5874bbca8ce7dd116e2b15715312d8d32a65ef", slug: "ipns-publisher", name: "IPNS Publisher",
    // the catalog's CURRENT description, verbatim (a publish rewrites name/description: they must stay exactly these)
    description: "Publish an IPNS name whose ed25519 key never leaves the enclave: held in attestation, not a plaintext file on disk. Records are signed in the TEE and pushed out three ways: served over /routing/v1, PUT to delegated routers, and stored on the public IPFS DHT by a hand-rolled, outbound-only libp2p stack (Noise XX, yamux, Kademlia PUT_VALUE), since rust-libp2p does not target wasip2. Byte-for-byte kubo-compatible; any node resolves the name straight from the DHT." }),
  // the live version the deployment runs today, and the one this publish appends
  prev: Object.freeze({ index: 5, version: "1.0.5", cid: "bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii", configSha256: sha(V5_CONFIG) }),
  publish: Object.freeze({ index: 6, version: "1.0.6", res: Object.freeze([0, 0, 128, 1]), ports: "http:8000", config: V5_CONFIG, feePerSec6: 0n }),
  // the frozen, tested artifact (worker 9d: 68 native + 18 real-WASM tests); never a rebuild
  wasm: Object.freeze({ path: path.join(here, "artifact/ipns-publisher-ensrepair.wasm"), sha256: "eaa493235bb27421445bffeb526ee65685d5667cc822a693ae54e79094264435", bytes: 1428694 }),
  expectedCid: "bafybeia2ymbg45dgh3sr3nqkxeumv3ayanfwtw6y5adj7tlg3ho33553fu",
  deployment: Object.freeze({ id: "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", envelopeCurrent: ENVELOPE_CURRENT, envelopeNew: ENVELOPE_NEW }),
  upload: Object.freeze({ ...SITE.upload, maxCarBytes: 1428694 + 2 * 1024 * 1024 }),
  gasCaps: Object.freeze({ publish: 1_100_000n, upgrade: 150_000n, config: 250_000n }),   // simulated 766,194 / ~40k / 108,083, +25% margin inside
  rpcs: ENROLLMENT.rpcs, receiptRpcs: ENROLLMENT.receiptRpcs,
  maxFeePerGas: ENROLLMENT.maxFeePerGas, confirmations: ENROLLMENT.confirmations, maxAgeMs: ENROLLMENT.maxAgeMs,
  port: 39671,
});

/** The exact calls for a given trust (tests substitute fixture addresses and the test admin; production uses PUB unchanged). */
export function publisherPlan(t = PUB) {
  const appId = keccak256(encodePacked(["address", "string"], [t.admin, t.app.slug]));
  const p = t.publish, d = t.deployment;
  const appRefPrev = `catalog://${appId}/${t.prev.index}`, appRefNext = `catalog://${appId}/${p.index}`;
  const publishData = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion",
    args: [t.app.slug, t.app.name, t.app.description, p.version, t.expectedCid, [...p.res], p.ports, p.config, p.feePerSec6] });
  const upgradeData = encodeFunctionData({ abi: LEDGER_ABI, functionName: "setAppRef", args: [d.id, appRefNext] });
  const configData = encodeFunctionData({ abi: LEDGER_ABI, functionName: "setConfig", args: [d.id, d.envelopeNew] });
  const tx = (step, n, title, to, data, destination) => ({ step, n, kind: "transaction", title, from: t.admin.toLowerCase(), to: to.toLowerCase(), value: "0x0", data,
    gasCap: t.gasCaps[step], destination, amountWei: "0" });
  const steps = [
    { step: "upload", n: 1, kind: "personal_sign", title: `Authorize the upload of ipns-publisher-ensrepair.wasm (sha256 ${t.wasm.sha256.slice(0, 12)}…, ${t.wasm.bytes} bytes) to the Enclave IPFS gateway`,
      destination: t.upload.addUrl, amountWei: "0" },
    tx("publish", 2, `Publish catalog version ${t.app.slug}:${p.version} (index ${p.index}, CID ${t.expectedCid.slice(0, 16)}…; resources, ports and config exactly as ${t.prev.version})`,
      t.catalog, publishData, "EnclaveAppCatalog " + t.catalog),
    tx("upgrade", 3, `Upgrade the existing IPNS Publisher deployment ${d.id.slice(0, 10)}… from ${t.app.slug}:${t.prev.version} to ${p.version}`, t.ledger, upgradeData, "EnclaveDeployments " + t.ledger),
    tx("config", 4, `Set that deployment's public config: ONLY ipni.announceAllBlocks false -> true (secret references, placement and isolation unchanged)`, t.ledger, configData, "EnclaveDeployments " + t.ledger),
  ];
  return Object.freeze({ appId, appRefPrev, appRefNext, publishData, upgradeData, configData, steps: Object.freeze(steps.map((s) => Object.freeze(s))) });
}
