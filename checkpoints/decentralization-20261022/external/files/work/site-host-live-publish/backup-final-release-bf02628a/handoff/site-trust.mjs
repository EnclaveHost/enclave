// The site activation (steps 1-3) pins: everything the local handoff may do is fixed here and rebuilt, never chosen at
// run time. Reviewed constants come from the existing enrollment trust (admin, ledger, registry, reserve, executor,
// oracle, code hashes, RPCs, fee caps); the site-specific ones from the frozen package and the public probes in
// ../logs (probe.json, probe3b.json, probe4.json, probe5.json). No key, token or signature is ever stored here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, encodePacked } from "../../enclave/node_modules/viem/_esm/index.js";
import { ENROLLMENT } from "../../lease-enrollment-signing/trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), W = path.resolve(here, "../..");
const abiOf = (name) => JSON.parse(fs.readFileSync(path.join(W, "enclave/contracts", `${name}.abi.json`), "utf8"));
// the deployed ABIs (generated from the live sources; sha256 pinned in the review inventory)
export const CATALOG_ABI = abiOf("EnclaveAppCatalog");
export const LEDGER_ABI = abiOf("EnclaveDeployments");

const RELEASE = "bafybeibs6ouoiqwsr632yvb4ffvmpee4bvxhiaqdg64khrijnt6lgbt3na";
export const SITE = Object.freeze({
  chainId: 8453,
  admin: ENROLLMENT.admin,                                   // the only account that may sign anything here
  book: ENROLLMENT.book, ledger: ENROLLMENT.ledger, registry: ENROLLMENT.registry, oracle: ENROLLMENT.oracle,
  reserve: ENROLLMENT.reserve, executor: ENROLLMENT.executor,
  catalog: "0x18419ca2b502d423a8de6269aeee171a378626e3",
  codeHashes: Object.freeze({ ledger: ENROLLMENT.codeHashes.ledger, registry: ENROLLMENT.codeHashes.registry, reserve: ENROLLMENT.reserveRuntimeHash,
    executor: ENROLLMENT.executorRuntimeHash, catalog: "0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f" }),
  catalogSchema: 9n, ledgerSchema: 16n,
  // the frozen package (work/site-host-final-release/deliver/package): never rebuilt
  wasm: Object.freeze({ path: path.join(W, "site-host-final-release/deliver/package/site_host.wasm"), sha256: "bc88d945fb1f569e842b8bb8edaf0528ff6eef642390e8976e5a9dd9487db93e", bytes: 46004290 }),
  expectedCid: "bafybeihfcjkkynfm6fumslxrziib2yinq52krrnjzgpqkf6fhwnh7wrad4",
  release: RELEASE,
  publish: Object.freeze({ slug: "enclave-site", name: "Enclave site", description: "The enclave.host website, served from one embedded, CID-verified release",
    version: "1", res: Object.freeze([0, 0, 256, 10]), ports: "", config: JSON.stringify({ release: RELEASE, wasi: "0.2" }), feePerSec6: 0n }),
  create: Object.freeze({ gpuMilli: 0, cpuMilli: 50, appPort: 8080, ports: "", isPublic: true, envelope: JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } }),
    feeRecipient: "0x0000000000000000000000000000000000000000", feePerSec6: 0n, maxRate6: 1n }),
  // the self-hosted premise of claimPolicy 1 and the zero compute rate: minipc's registry payout wallet is the admin
  minipc: Object.freeze({ hostId: "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", operator: "0x1a01194c34fe3577c6d0a54feb78af6253e494e0" }),
  predictedId: "0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e",
  upload: Object.freeze({ tokenUrl: "https://api.enclave.host/v1/apps/upload-token", addUrl: "https://ipfs.enclave.host/add-wasm",
    carUrl: (cid) => `https://ipfs.enclave.host/ipfs/${cid}?format=car&dag-scope=all`, expirySec: 300, signMarginSec: 20,
    maxJsonBytes: 65536, maxCarBytes: 46004290 + 2 * 1024 * 1024, timeoutMs: 600_000 }),
  gasCaps: Object.freeze({ publish: 900_000n, create: 600_000n }),
  // the stage-B queue (existing reviewed enrollment queue, unchanged) and its approved two operations
  stageB: Object.freeze({ depositWei: 1_000_000_000_000_000n, approvedOpsSha256: "104cfff82613feca6972f82cbbaeb79f908ca82eee1b54d2703f84228c7d9ef5", port: 39656 }),
  rpcs: ENROLLMENT.rpcs, receiptRpcs: ENROLLMENT.receiptRpcs,
  maxFeePerGas: ENROLLMENT.maxFeePerGas, confirmations: ENROLLMENT.confirmations, maxAgeMs: ENROLLMENT.maxAgeMs,
});

/** The exact calls for a given trust (a test may substitute fixture addresses; production uses SITE unchanged). */
export function sitePlan(t = SITE) {
  const appId = keccak256(encodePacked(["address", "string"], [t.admin, t.publish.slug]));
  const p = t.publish, c = t.create;
  const publishData = encodeFunctionData({ abi: CATALOG_ABI, functionName: "publishVersion",
    args: [p.slug, p.name, p.description, p.version, t.expectedCid, [...p.res], p.ports, p.config, p.feePerSec6] });
  const appRef = `catalog://${appId}/0`;
  const createData = encodeFunctionData({ abi: LEDGER_ABI, functionName: "create",
    args: [appRef, c.gpuMilli, c.cpuMilli, c.appPort, c.ports, c.isPublic, c.envelope, c.feeRecipient, c.feePerSec6, c.maxRate6] });
  const steps = [
    { step: "upload", n: 1, kind: "personal_sign", title: "Authorize the upload of site_host.wasm (sha256 " + t.wasm.sha256.slice(0, 12) + "…, " + t.wasm.bytes + " bytes) to the Enclave IPFS gateway",
      destination: t.upload.addUrl, amountWei: "0" },
    { step: "publish", n: 2, kind: "transaction", title: `Publish catalog version ${p.slug}:${p.version} (CID ${t.expectedCid.slice(0, 16)}…, release pin ${t.release.slice(0, 16)}…)`,
      from: t.admin.toLowerCase(), to: t.catalog, value: "0x0", data: publishData, gasCap: t.gasCaps.publish, destination: "EnclaveAppCatalog " + t.catalog, amountWei: "0" },
    { step: "create", n: 3, kind: "transaction", title: `Create the public site deployment ${t.predictedId.slice(0, 10)}… (Hyper-V tier, ${c.cpuMilli / 10}% CPU, rate cap ${c.maxRate6} µUSDC/s, no funding)`,
      from: t.admin.toLowerCase(), to: t.ledger.toLowerCase(), value: "0x0", data: createData, gasCap: t.gasCaps.create, destination: "EnclaveDeployments " + t.ledger, amountWei: "0" },
  ];
  return Object.freeze({ appId, appRef, publishData, createData, steps: Object.freeze(steps.map((s) => Object.freeze(s))) });
}
