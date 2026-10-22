/* ============================================================
   Native-client launch instructions (independent mode).

   The attestation-pinned native client (docs/network/native-client.md,
   scripts/network/native-get.mjs) reaches an app with no Enclave DNS, CA
   or control API. This builds the STARTING trust profile from what the
   browser profile already pins, and says exactly which trust decisions
   are still the user's: provider checker keys, the SNP firmware floor
   and the reviewed runtime release. Nothing here is filled from a host
   or an API, and nothing is presented as verified.
   ============================================================ */

const ZERO = "0x" + "0".repeat(40);

/* A base profile for scripts/network/native-profile.mjs. Fields the user must decide are null, with `todo` naming
   them; the generator then reproduces the measurement from a reviewed release and the owner-committed package. */
export function nativeStarter(profile, deploymentId, label){
  if (!/^0x[0-9a-f]{64}$/.test(deploymentId || "")) throw new Error("a full deployment id is required");
  const rpc = profile.rpcs.filter((u) => u.startsWith("https://"));
  const gateways = profile.storage ? profile.storage.replicas.map((r) => r.gateway) : [];
  const todo = [];
  if (rpc.length < 2) todo.push("rpc: the native client needs at least two HTTPS RPC origins with distinct hostnames");
  if (!profile.directories.length) todo.push("directories: one to eight public network directories serving /v1/network/records");
  todo.push("connectivity: the network connectivity contract (zero disables paid providers)",
    "checkers: the provider-qualification signer addresses you trust",
    "linux.minTcb and collateral policy: your SNP firmware floor",
    "stateDir: an absolute directory this client owns and keeps");
  if (!gateways.length) todo.push("startup.gateways: where the owner-committed startup package can be fetched");
  return {
    starter: {
      version: 1, deploymentId, hostname: label + ".app.enclave.host",
      stateDir: null, chainId: profile.chainId, rpc,
      authorityPins: { deployments: profile.contracts.deployments, registry: profile.contracts.registry, connectivity: ZERO,
        sessionVaultFactory: profile.contracts.sessionVaultFactory },
      directories: [...profile.directories], checkers: null,
      startup: { gateways },
      linux: { minTcb: null },
    },
    todo,
    commands: [
      "node scripts/network/native-profile.mjs --profile base-profile.json --release-id <64-hex reviewed runtime release> \\",
      "  --artifact-gateways <public raw-CID sources> --vcpus 1 --out client-profile.json",
      "node scripts/network/native-get.mjs client-profile.json /",
    ],
    notes: [
      "The hostname is only the TLS routing name; the client never resolves it through DNS and does not treat it as identity.",
      "The client connects only while the deployment holds an active public lease, and only after the guest's fresh hardware evidence matches the measurement reproduced from the reviewed release and the owner's committed startup package.",
      "Deployments without committed startup settings need explicit `expected` app and runtime values from material you trust instead of `startup`.",
    ],
  };
}
