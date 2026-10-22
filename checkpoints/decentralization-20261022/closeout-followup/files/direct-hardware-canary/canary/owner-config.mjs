// owner-config.mjs: the canary's BARE direct-control owner config, validated by the PUBLISHED canonicalDirectConfig
// (tree/metal/guest/measured-control.mjs), with the config digest and the HOST_DATA the published launcher binds.
//   - bare: no mcp, platformApi, platformPolicyCarriers, leaseGas or ownerNomination member;
//   - not selling: cpuPrice6/payout null, and the operator address is a hash with NO private key (the launcher gets no
//     registryKeyFile, so REGISTRY_ENABLED/CLAIM_ENABLED are 0 in the guest);
//   - identity.publicUrl https://direct-control-canary.invalid: its registry id is not registered (expected "pending");
//   - isolation endpoints: 10.0.2.2:<two ports the harness proved have NO host listener> (never production guestd 8095/8096),
//     and the canary also runs slirp with restrict=on, so the guest reaches no host or outside address at all;
//   - contracts: the production pins (contracts/deployments/contract-pins-base.json of the commit), used only as bound,
//     public addresses; rpcs: two public Base RPCs (the guest cannot reach them under restrict=on; the host-side verifier
//     may read the registry through them, read-only).
//   node canary/owner-config.mjs --manager-port N --data-port M [--control-port 8444] --out FILE  -> prints {digest, hostData}
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tree");
const MC = await import(path.join(TREE, "metal/guest/measured-control.mjs"));
const sha = (s) => createHash("sha256").update(s).digest("hex");

export const CANARY = Object.freeze({
  publicUrl: "https://direct-control-canary.invalid",
  operator: "0x" + sha("enclave direct-control hardware canary operator: no private key exists").slice(0, 40),
  releaseId: sha("enclave direct-control hardware canary: no app release"),
  rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  gateways: ["http://192.0.2.1:9"],   // TEST-NET-1, never routed; the bare guest launches no app
  repo: "EnclaveHost/enclave",
});
const PRODUCTION_GUESTD = [8095, 8096];

export function buildOwnerConfig({ managerPort, dataPort, controlPort = MC.DEFAULT_CONTROL_PORT }) {
  for (const p of [managerPort, dataPort]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error("guestd stand-in ports must be integers 1024..65535");
    if (PRODUCTION_GUESTD.includes(p)) throw new Error(`port ${p} is production guestd's: refused`);
  }
  if (managerPort === dataPort) throw new Error("manager and data ports must differ");
  const pins = JSON.parse(fs.readFileSync(path.join(TREE, "contracts/deployments/contract-pins-base.json"), "utf8")).contracts;
  const raw = {
    format: MC.CONFIG_FORMAT, chainId: MC.CHAIN_ID, contracts: { ...pins }, profileDigest: null,
    rpcs: [...CANARY.rpcs], quorum: 2, releaseId: CANARY.releaseId,
    replicas: { gateways: [...CANARY.gateways], storagePlan: null },
    identity: { publicUrl: CANARY.publicUrl, repo: CANARY.repo, operator: CANARY.operator },
    selling: { cpuPrice6: null, payout: null },
    isolation: { managerUrl: `http://10.0.2.2:${managerPort}`, dataAddr: `10.0.2.2:${dataPort}` },
    hostAdmissionSha256: null, controlPort,
  };
  const config = MC.canonicalDirectConfig(raw);
  for (const k of ["mcp", "platformApi", "platformPolicyCarriers", "leaseGas", "ownerNomination"]) if (k in config) throw new Error(`the canary config is bare: ${k} present`);
  const digest = MC.configDigest(config);
  return { config, text: MC.canonicalJson(config) + "\n", digest, hostData: MC.hostDataHex(digest) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg("out");
  if (!out) { console.error("usage: owner-config.mjs --manager-port N --data-port M [--control-port P] --out FILE"); process.exit(2); }
  const r = buildOwnerConfig({ managerPort: Number(arg("manager-port")), dataPort: Number(arg("data-port")), controlPort: Number(arg("control-port", MC.DEFAULT_CONTROL_PORT)) });
  fs.writeFileSync(out, r.text, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ digest: r.digest, hostData: r.hostData, controlPort: r.config.controlPort, isolation: r.config.isolation, operator: r.config.identity.operator, publicUrl: r.config.identity.publicUrl }));
}
