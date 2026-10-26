// owner-config.mjs: the canary's VERIFIER-ONLY direct-control owner config, validated by the PUBLISHED canonicalDirectConfig
// (tree/metal/guest/measured-control.mjs of 0235e7d96), with the config digest and the HOST_DATA the published launcher binds.
//   - verifier-only: chainVerifier {format enclave-chain-verifier/v1, unsafeSigner = the documented Base sequencer pin
//     (docs/network/local-chain-verifier.md), proofSources = ONE host-loopback stand-in port the harness proved has NO
//     listener, expose "attested"}; no mcp, platformApi, platformPolicyCarriers, leaseGas, ownerNomination or nativeControl
//     member, and NO txBackend (a read-only verifier);
//   - the Base backend is therefore UNREADY by construction: its only proof source has no listener, and slirp restrict=on
//     (canary/qemu-restrict.sh) blocks every host and outside address anyway. The route must fail closed; nothing is faked;
//   - not selling: cpuPrice6/payout null; the operator address is a hash with NO private key (no registryKeyFile is given to
//     the launcher, so REGISTRY_ENABLED/CLAIM_ENABLED are 0 in the guest);
//   - identity.publicUrl https://snp-verifier-canary.invalid: not registered (registry diagnostic expected "pending");
//   - isolation endpoints: 10.0.2.2:<two more refused stand-in ports> (never production guestd 8095/8096);
//   - contracts: the commit's public production pins, used only as bound addresses; rpcs: two public Base RPCs the guest
//     cannot reach under restrict=on (the host-side registry read is off in the recommended run).
//   node canary/owner-config.mjs --manager-port N --data-port M --proof-port Q [--verifier-port V] [--control-port 8444] --out FILE
//     -> prints {digest, hostData, ...}
//   node canary/owner-config.mjs ... --variant wrong-config --out FILE   -> the SAME config with one bound field changed
//     (controlPort+1 is NOT used: the variant changes chainVerifier.unsafeSigner), for the wrong-config rejection check only.
// Adapted 2026-10-25 from the root-reviewed native-final-canary/canary/owner-config.mjs (79c592e0): only the verifier-only
// chainVerifier member, its stand-in port and the wrong-config variant were added; the bare refusal list is unchanged.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tree");
const MC = await import(path.join(TREE, "metal/guest/measured-control.mjs"));
const sha = (s) => createHash("sha256").update(s).digest("hex");

export const CANARY = Object.freeze({
  publicUrl: "https://snp-verifier-canary.invalid",
  operator: "0x" + sha("enclave verifier-only SNP hardware canary operator: no private key exists").slice(0, 40),
  releaseId: sha("enclave verifier-only SNP hardware canary: no app release"),
  rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  gateways: ["http://192.0.2.1:9"],   // TEST-NET-1, never routed; the guest launches no app
  repo: "EnclaveHost/enclave",
  unsafeSigner: "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a",   // docs/network/local-chain-verifier.md (Base sequencer pin)
  wrongUnsafeSigner: "0x" + sha("not the sequencer: wrong-config variant").slice(0, 40),
  verifierPort: 50546,
});
const PRODUCTION_GUESTD = [8095, 8096];
export const BARE_REFUSED = ["mcp", "platformApi", "platformPolicyCarriers", "leaseGas", "ownerNomination", "nativeControl"];

export function buildOwnerConfig({ managerPort, dataPort, proofPort, verifierPort = CANARY.verifierPort, controlPort = MC.DEFAULT_CONTROL_PORT, variant = null }) {
  for (const p of [managerPort, dataPort, proofPort]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error("stand-in ports must be integers 1024..65535");
    if (PRODUCTION_GUESTD.includes(p)) throw new Error(`port ${p} is production guestd's: refused`);
  }
  if (new Set([managerPort, dataPort, proofPort]).size !== 3) throw new Error("manager, data and proof stand-in ports must differ");
  if (variant !== null && variant !== "wrong-config") throw new Error(`unknown variant ${variant}`);
  const pins = JSON.parse(fs.readFileSync(path.join(TREE, "contracts/deployments/contract-pins-base.json"), "utf8")).contracts;
  const raw = {
    format: MC.CONFIG_FORMAT, chainId: MC.CHAIN_ID, contracts: { ...pins }, profileDigest: null,
    rpcs: [...CANARY.rpcs], quorum: 2, releaseId: CANARY.releaseId,
    replicas: { gateways: [...CANARY.gateways], storagePlan: null },
    identity: { publicUrl: CANARY.publicUrl, repo: CANARY.repo, operator: CANARY.operator },
    selling: { cpuPrice6: null, payout: null },
    isolation: { managerUrl: `http://10.0.2.2:${managerPort}`, dataAddr: `10.0.2.2:${dataPort}` },
    hostAdmissionSha256: null, controlPort,
    chainVerifier: { format: "enclave-chain-verifier/v1", unsafeSigner: variant === "wrong-config" ? CANARY.wrongUnsafeSigner : CANARY.unsafeSigner,
      proofSources: [`http://10.0.2.2:${proofPort}/`], port: verifierPort, expose: "attested" },
  };
  const config = MC.canonicalDirectConfig(raw);
  for (const k of BARE_REFUSED) if (k in config) throw new Error(`the canary config is verifier-only: ${k} present`);
  const cv = config.chainVerifier;
  if (!cv || cv.expose !== "attested" || "txBackend" in cv) throw new Error("the canary config must keep a read-only, attested-only chainVerifier");
  if (cv.proofSources.length !== 1 || cv.proofSources[0] !== `http://10.0.2.2:${proofPort}/`) throw new Error("the only proof source must be the refused stand-in");
  const digest = MC.configDigest(config);
  return { config, text: MC.canonicalJson(config) + "\n", digest, hostData: MC.hostDataHex(digest) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg("out");
  if (!out) { console.error("usage: owner-config.mjs --manager-port N --data-port M --proof-port Q [--verifier-port V] [--control-port P] [--variant wrong-config] --out FILE"); process.exit(2); }
  const r = buildOwnerConfig({ managerPort: Number(arg("manager-port")), dataPort: Number(arg("data-port")), proofPort: Number(arg("proof-port")),
    verifierPort: Number(arg("verifier-port", CANARY.verifierPort)), controlPort: Number(arg("control-port", MC.DEFAULT_CONTROL_PORT)), variant: arg("variant", null) });
  fs.writeFileSync(out, r.text, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ digest: r.digest, hostData: r.hostData, controlPort: r.config.controlPort, isolation: r.config.isolation,
    chainVerifier: r.config.chainVerifier, operator: r.config.identity.operator, publicUrl: r.config.identity.publicUrl }));
}
