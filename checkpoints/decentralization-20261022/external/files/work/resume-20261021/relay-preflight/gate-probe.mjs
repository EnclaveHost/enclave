// READ-ONLY: would the relay ROLE's own platform host policy gate admit metal0 right now? The FROZEN release's code
// (app/network/host-services/lease-relay-host.mjs hostRelayGate) is run with the target's configuration shape:
// production policy, the policy carriers (an EMPTY scratch importDir and the pinned service index), metal0's registered
// endpoint. Its policy state goes to a scratch directory under this preflight (deleted after). It makes chain reads and
// policy-mirror GETs only; it starts no relay, holds no key and changes nothing. Prints one JSON line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), WORK = path.resolve(HERE, "../..");
const inv = JSON.parse(fs.readFileSync(path.join(WORK, "eu-relay-user-target/inventory.json"), "utf8"));
const REL = path.join(WORK, "eu-relay-user-target/release", inv.release.id);
const { hostRelayGate, validateHostRelayConfig } = await import(pathToFileURL(path.join(REL, "app/network/host-services/lease-relay-host.mjs")).href);
const scratch = fs.mkdtempSync(path.join(HERE, ".gate-"));
const out = { at: new Date().toISOString(), release: inv.release.id, endpoint: "https://api.enclave.host/t/metal0" };
try {
  fs.mkdirSync(path.join(scratch, "import"), { mode: 0o700 });
  const cfg = validateHostRelayConfig({ format: "enclave-host-relay/v1", host: { endpoint: out.endpoint, publicEndpoints: [] }, platformHostPolicy: "production",
    platformHostPolicyCarriers: { importDir: path.join(scratch, "import"), serviceIndex: true },
    serviceIndex: { chainId: 8453, address: "0x54dEcb43DE6f9Cc953Ba582B190b56C5a60B5941", codeHash: "0x696944fed82d8b312e4db3ab89069240f8063a6a49b47e8a322804cdfd127898" },
    packagesDir: path.join(REL, "packages"), stateRoot: scratch,
    relay: { package: inv.release.relayPackagePin, heapMiB: 128, port: 8549, bind: "127.0.0.1", record: path.join(WORK, "eu-relay-user-target/config/lease-gas-deployment.json"),
      digest: "sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089", rpc: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io"], quorum: 2,
      maxFloatEth: "0.001", minFloatEth: "0.00001" } });
  const logs = [];
  const gate = await hostRelayGate(cfg, { log: (m) => logs.push(String(m).slice(0, 300)) });
  await Promise.race([gate.check(), new Promise((_, no) => setTimeout(() => no(new Error("gate check timed out (60 s)")), 60_000))]);
  out.refusal = gate.serviceRefusal() || null;
  out.admitted = !out.refusal;
  out.status = gate.status?.() ?? null;
  out.log = logs.slice(-12);
  gate.stop?.();
} catch (e) { out.error = String(e.message || e).slice(0, 400); }
finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log(JSON.stringify(out));
process.exit(0);
