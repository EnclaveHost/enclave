// accepted-image-assets r3 (stage helper, not in the tree): the ROLE's own composition for the relay startup case.
//   node unenrolled-startup-config.mjs REPO INPUTS OUTROOT  -> prints the derived env (JSON) the role would give the relay
// A bound config with the verifier authority and platformApi.derivedReader (the RPC VM origins over 10.0.2.2) goes through the
// tree's canonicalDirectConfig, then composeDerivedReader with the COMMITTED template and record (only the record's template
// path is moved to the checkout: same bytes, same pin). The image paths do not exist on the host, so the composed file's
// native/Helios/glibc/checkpoint paths are then pointed at the verified INPUTS (the same pinned bytes the image installs).
// Nothing else changes; the endpoints stay the bound ones, initializeState stays false, and NO state is created here.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, inputs, outRoot] = process.argv.slice(2);
if (![repo, inputs, outRoot].every((p) => p && path.isAbsolute(p))) throw new Error("usage: REPO INPUTS OUTROOT (absolute)");
const MC = await import(pathToFileURL(path.join(repo, "metal/guest/measured-control.mjs")));
const role = await import(pathToFileURL(path.join(repo, "metal/guest/platform-api-role.mjs")));
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
const cfg = MC.canonicalDirectConfig({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189"], storagePlan: null },
  identity: { publicUrl: "https://host-1.example.org", repo: "owner/enclave", operator: a(0xb1) },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444,
  platformApi: { apiPort: 8098, peerPort: 8099, hostname: "api.enclave.host",
    members: [0, 1, 2].map((i) => ({ operator: a(0xb0 + i), publicUrl: `https://host-${i}.example.org`, controlUrl: `https://198.51.100.${10 + i}:8444` })),
    measurements: ["77".repeat(48)], minTcb: null, admins: [a(0xad)], recovery: ["11".repeat(32)], archives: ["https://archive.example"], archiveMs: 30000,
    relayEnv: { ADDRESS_BOOK_ADDRESS: "0x7777777777777777777777777777777777777777", SIWE_DOMAIN: "enclave.host", SIWE_URI: "https://enclave.host",
      ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:9" },
    leaseMs: 10000,
    derivedReader: { format: MC.DERIVED_READER_ENDPOINTS_FORMAT, l1ConsensusUrl: "http://10.0.2.2:25052", l1ExecutionUrl: "http://10.0.2.2:28645", baseUrl: "http://10.0.2.2:28545" } } });
const record = JSON.parse(fs.readFileSync(path.join(repo, "metal/derived-reader-image.json"), "utf8"));
record.config.path = path.join(repo, record.config.source);
fs.mkdirSync(outRoot, { recursive: true, mode: 0o700 });
const image = path.join(outRoot, "DERIVED-READER-IMAGE.json");
fs.writeFileSync(image, JSON.stringify(record));
const env = role.composeDerivedReader({ cfg, root: outRoot, image });
const file = env.ENCLAVE_DERIVED_READER_CONFIG, c = JSON.parse(fs.readFileSync(file, "utf8"));
c.native.path = path.join(inputs, "derivation_harness_lease_v3"); c.native.runtime.dir = inputs;
c.l1.binary.path = path.join(inputs, "helios"); c.l1.runtime.dir = inputs; c.l1.checkpointFile = path.join(inputs, "checkpoint.json");
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ env, endpoints: [c.l1.consensusUrl, c.l1.executionUrl, c.baseUrl], initializeState: c.initializeState, stateDir: c.stateDir }));
