// Computes, with a GIVEN repository's own code (default: main), the absent-pinnedRelays outputs the candidate must keep
// byte-identical: the host transit, the legacy guest env, the direct guest env and the bound direct-config digest.
//   node compute.mjs [repo]   -> one JSON object (sha256 of each, plus the values)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto"; import { pathToFileURL } from "node:url";
const repo = path.resolve(process.argv[2] || new URL("../../enclave", import.meta.url).pathname);
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const LG = await imp("network/lease-gas-conduit.mjs"), MC = await imp("metal/guest/measured-control.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const RECORD = Buffer.from('{"format":"enclave-lease-gas-deployment/v1","chainId":8453,"reserve":"0x12A3f873041Dec436DaA0085B766a399A6fA3639","executor":"0x8900BACA2167873BA2F8a8bAE8b4876E6396d343","reserveCodeHash":"0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979","executorCodeHash":"0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2","ledger":"0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B","registry":"0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC"}');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-")), file = path.join(dir, "deployment.json"); fs.writeFileSync(file, RECORD);
const host = { recordFile: file, digest: "sha256:" + sha(RECORD), rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], relays: ["https://134.209.248.172"], quorum: 2 };
const t = LG.leaseGasTransit(host, { readFile: (f) => fs.readFileSync(f) });
const transit = JSON.stringify(t);
const legacyEnv = JSON.stringify(LG.leaseGasGuest(JSON.parse(transit), { recordFile: "/run/lease-gas/deployment.json" }).env);
const a20 = (n) => "0x" + n.toString(16).padStart(40, "0");
const RAW = { format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a20(0x11), deployments: a20(0x12), appCatalog: a20(0x13), proofOfTime: a20(0x14), enclavePay: a20(0), verificationFees: a20(0), sessionVaultFactory: a20(0), secretVaultV2: a20(0) },
  profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
  replicas: { gateways: ["http://192.0.2.10:8189", "https://replica.example"], storagePlan: null },
  identity: { publicUrl: "https://host.example.org", repo: "owner/enclave", operator: a20(0x99) },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444 };
const cfg = MC.canonicalDirectConfig({ ...RAW, leaseGas: JSON.parse(transit) });
const directEnv = JSON.stringify(Object.fromEntries(Object.entries(MC.directSupervisorEnv(cfg)).filter(([k]) => LG.isLeaseGasName(k))));
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ repo, transitSha256: sha(transit), legacyEnvSha256: sha(legacyEnv), directEnvSha256: sha(directEnv),
  directConfigDigest: MC.configDigest(cfg), withoutLeaseGasDigest: MC.configDigest(MC.canonicalDirectConfig(RAW)), transit: JSON.parse(transit), legacyEnv: JSON.parse(legacyEnv) }, null, 1));
