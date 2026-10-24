// Production dependencies = root's renew-protected-2331.mjs logic, unchanged in substance: the same unchanged production lease
// client (restore repo), the same digest-pinned deployment record, the same 3 public RPCs at quorum 2, the same guestd control
// client and pairing key, the same operator check. Only ROOT runs this (it reads the operator key and the guestd pair key,
// never logs either). The key is read only inside renew(), i.e. only when the reserve already says Ready.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(W, "custody-recipient-restore-20261023/repo");
const imp = (p) => import(pathToFileURL(p).href);
const { createPublicClient, http } = await imp(path.join(REPO, "node_modules/viem/_esm/index.js"));
const { privateKeyToAccount } = await imp(path.join(REPO, "node_modules/viem/_esm/accounts/index.js"));
const { parseDeploymentRecord, LEDGER_ABI } = await imp(path.join(REPO, "network/lease-gas-owner.mjs"));
const { createLeaseClient, policy } = await imp(path.join(REPO, "client/lease-executor-client.mjs"));
const { verifiedLeaseAuthority } = await imp(path.join(REPO, "client/lease-executor-authority.mjs"));
const { GuestdControl, parseKey } = await imp(path.join(W, "linux-post-adoption-release/stage/metal-deabf8f90/isolation/m4/guestd/control-client.mjs"));
import { PINS } from "./lib.mjs";

const CONFIG = "/home/steven/Projects/enclave/metal/config.json";
const dep = parseDeploymentRecord(fs.readFileSync("/home/steven/enclave-prod/lease-gas/deployment.json"),
  { expectedDigest: "sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089" });
const clients = ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io"]
  .map((url) => createPublicClient({ transport: http(url, { timeout: 12000, retryCount: 0 }) }));
const authority = () => verifiedLeaseAuthority({ clients, deployment: dep, quorum: 2 });

export const deps = {
  async lease(id) {
    const a = await authority();
    const row = await a.client.readContract({ address: a.pins.ledger, abi: LEDGER_ABI, functionName: "get", args: [id] });
    return { active: row.active, runner: row.runner, runnerOperator: row.runnerOperator, leaseUntil: row.leaseUntil, blockTs: a.block?.timestamp };
  },
  async guest(id, vm) {
    const pair = parseKey(fs.readFileSync("/home/steven/enclave-prod/guestd-pair.key", "utf8"));
    try {
      const c = new GuestdControl("http://127.0.0.1:8095", pair, { requestTimeoutMs: 12000, maxResponseBytes: 131072 });
      const v = await c.request("GET", "/vms/" + vm);
      return { status: v.status === 200 ? v.body.status : `http ${v.status}`, name: v.body?.name, vm: v.status === 200 ? vm : null };
    } finally { pair.fill(0); }
  },
  async availability() {
    const r = await fetch("https://api.enclave.host/t/metal0/availability", { signal: AbortSignal.timeout(12000), redirect: "error" });
    if (r.status !== 200) throw new Error(`availability -> ${r.status}`);
    return (await r.json())?.instanceSweep?.held ?? null;
  },
  async policy(id, lease) {
    const a = await authority();
    return policy({ client: a.client, reserve: a.pins.reserve, id, kind: "renew", enclaveId: lease.runner, operator: lease.runnerOperator });
  },
  async renew(id, onSigned) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const account = privateKeyToAccount(cfg.registryKey);
    if (account.address.toLowerCase() !== PINS.operator) throw new Error("operator");
    const lc = createLeaseClient({ clients, account, reserve: dep.reserve, deployment: dep, relays: cfg.leaseGas.relays, quorum: 2, onSigned, log: () => {} });
    const r = await lc.renew(id);
    return { hash: r.hash, chargedWei: String(r.verified.chargedWei) };
  },
};
