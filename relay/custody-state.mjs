// The relay's view of EnclaveSecretVault (docs/security/secret-custody.md): for a deployment whose owner moved its
// secrets to custodians, the relay holds NO value and can decrypt nothing. It still answers two questions, from the chain:
//   - custodyStateFor(id): the deployment's custody POINTER for its attested release (secrets-release.mjs puts it in the
//     sealed, signed release; the guest fetches the values from the custodians itself), or null for no custody policy;
//   - custodyHeld(id): whether the relay must refuse to store or serve a plaintext copy for it (secrets.js).
// Reads go through >= minAgree RPCs that must agree at one block (the relay's confirmRow rule), so one RPC cannot make
// the relay serve a stale plaintext copy or point a guest at the wrong committee. custody/chain.mjs is the same reader
// for custodians; test/custody-relay.test.mjs pins the two equal. Self-contained (viem only): the relay ships relay/ files.
//
// Config: CUSTODY_VAULT (address; unset = custody off, every path behaves as before) and the RPC list the release
// already uses (SECRETS_RELEASE_CATALOG_RPCS, two or more).
import { createPublicClient, http } from "viem";

const ABI = [
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }, { name: "policyRev", type: "uint64" }, { name: "secretRev", type: "uint64" }, { name: "committeeId", type: "bytes32" }, { name: "paused", type: "bool" }, { name: "rules", type: "bytes" }] },
  { type: "function", name: "bundleOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "secretRev", type: "uint64" }, { name: "epoch", type: "uint32" }, { name: "ciphertext", type: "bytes" }] },
  { type: "function", name: "sharesOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "complete", type: "bool" }, { name: "source", type: "uint256" }, { name: "commitments", type: "bytes" }, { name: "sealedShares", type: "bytes[]" }] },
  { type: "function", name: "epochOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "threshold", type: "uint8" }, { name: "activatedAt", type: "uint64" },
              { name: "members", type: "tuple[]", components: [{ name: "operator", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" }] }] },
];

// custody v2 (docs/security/secret-custody-v2.md): EnclaveSecretVaultV2, the host-run committee's vault
const MACHINE = [{ name: "identity", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" },
                 { name: "chipId", type: "bytes32" }, { name: "registryId", type: "bytes32" }, { name: "measurement", type: "bytes32" }];
const ABI_V2 = [
  ABI[0],
  { type: "function", name: "bundleOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "committeeId", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "bundle", type: "bytes" }] },
  { type: "function", name: "committeeOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }],
    outputs: [{ name: "Y", type: "bytes" }, { name: "epoch", type: "uint32" }, { name: "t", type: "uint8" }, { name: "W", type: "uint8" }, { name: "activatedAt", type: "uint64" }] },
  { type: "function", name: "machinesOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "machines", type: "tuple[]", components: MACHINE }, { name: "enclave", type: "bool[]" }] },
  { type: "function", name: "commitmentsOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }], outputs: [{ type: "bytes" }] },
];
// the seat layout (custody/v2/protocol.mjs seatLayout; self-contained here because the relay ships relay/ only): all
// Enclave machines are ONE seat; n >= 3: weight 1, t = ceil(2n/3); n < 3: Enclave seat weight t = others + 1
export function seatIndicesV2(enclaveFlags) {
  const enc = enclaveFlags.map((e, i) => (e ? i : -1)).filter((i) => i >= 0), others = enclaveFlags.map((e, i) => (e ? -1 : i)).filter((i) => i >= 0);
  const n = others.length + (enc.length ? 1 : 0);
  let t, wE;
  if (n >= 3) { t = Math.ceil((2 * n) / 3); wE = 1; } else { if (!enc.length) throw new Error("fewer than 3 seats without the Enclave seat"); t = others.length + 1; wE = t; }
  const idx = new Array(enclaveFlags.length);
  let next = 1;
  if (enc.length) { const ks = Array.from({ length: wE }, (_, j) => next + j); for (const i of enc) idx[i] = ks; next += wE; }
  for (const i of others) idx[i] = [next++];
  return { t, W: next - 1, indices: idx };
}

// authority: the relay's verifier chain authority (relay/relay-chain-authority.mjs) or null. With it the vault is read through
// that ONE proven client (minAgree 1: one authority, not a vote), every field at the same numbered block of its head chain,
// and the block-age bound applies as before; a provider list (CUSTODY_RPCS, CUSTODY_MIN_AGREE) was refused at startup.
export function custodyConfig(env = process.env, { authority = null } = {}) {
  const vault2 = String(env.CUSTODY_VAULT_V2 || "").trim().toLowerCase();
  if (vault2 && !/^0x[0-9a-f]{40}$/.test(vault2)) return { on: false, error: "CUSTODY_VAULT_V2 is not an address" };
  const vault = String(env.CUSTODY_VAULT || "").trim().toLowerCase();
  const chainId = parseInt(env.CUSTODY_CHAIN_ID || "8453", 10);
  const rpcs = String(env.CUSTODY_RPCS || env.SECRETS_RELEASE_CATALOG_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!vault && !vault2) return { on: false };
  if (vault && !/^0x[0-9a-f]{40}$/.test(vault)) return { on: false, error: "CUSTODY_VAULT is not an address" };
  if (authority) {
    if (chainId !== 8453) return { on: false, error: `custody under the verifier authority reads Base mainnet (8453), not CUSTODY_CHAIN_ID ${chainId}` };
    return { on: true, vault: vault || null, vault2: vault2 || null, chainId, rpcs: [], clients: [authority.client], minAgree: 1,
             maxAgeSec: parseInt(env.CUSTODY_MAX_AGE_SEC || "120", 10), authority: "local-verifier" };
  }
  const minAgree = parseInt(env.CUSTODY_MIN_AGREE || "2", 10);
  if (rpcs.length < minAgree || minAgree < 1) return { on: false, error: `custody needs ${minAgree} or more RPCs (CUSTODY_RPCS or SECRETS_RELEASE_CATALOG_RPCS)` };
  const maxAgeSec = parseInt(env.CUSTODY_MAX_AGE_SEC || "120", 10);
  return { on: true, vault: vault || null, vault2: vault2 || null, chainId, rpcs, minAgree, maxAgeSec };
}

export function createCustodyReader({ vault = null, vault2 = null, chainId, rpcs = [], minAgree = 2, clients = null, ttlMs = 15_000, now = () => Date.now(), maxAgeSec = 120 }) {
  const cs = clients || rpcs.map((url) => createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 1 }) }));
  const cache = new Map();   // id -> { at, value } for custodyHeld only (the release always reads fresh)
  async function readAtV2(c, id, blockNumber) {
    const rd = (functionName, args) => c.readContract({ address: vault2, abi: ABI_V2, functionName, args, blockNumber });
    const [[owner, policyRev, secretRev, committeeId, paused], [bCid, bRev, bundle]] = await Promise.all([rd("policyOf", [id]), rd("bundleOf", [id])]);
    if (policyRev === 0n) return { policyRev: "0" };
    const out = { v: 2, policyRev: String(policyRev), secretRev: String(secretRev), committeeId: committeeId.toLowerCase(), paused, owner: owner.toLowerCase(),
                  hasBundle: bundle !== "0x", bundleCommittee: bCid.toLowerCase(), bundleRev: String(bRev) };
    if (!out.hasBundle) return out;
    const [, epoch, t] = await rd("committeeOf", [committeeId]);
    const [[machines, enclave], commitments] = await Promise.all([rd("machinesOf", [committeeId, epoch]), rd("commitmentsOf", [committeeId, epoch])]);
    return { ...out, epoch: Number(epoch), t: Number(t), bundle: bundle.slice(2).toLowerCase(), commitments: commitments.slice(2).toLowerCase(),
             machines: machines.map((m, i) => ({ encKey: m.encKey.slice(2).toLowerCase(), endpoint: m.endpoint, enclave: enclave[i] })) };
  }
  async function readAt(c, id, blockNumber) {
    const v2 = vault2 ? await readAtV2(c, id, blockNumber) : { policyRev: "0" };
    if (v2.policyRev !== "0") return v2;   // a v2 policy wins: the owner moved to the host-run committee
    if (!vault) return { policyRev: "0" };
    const rd = (functionName, args) => c.readContract({ address: vault, abi: ABI, functionName, args, blockNumber });
    const [[owner, policyRev, secretRev, committeeId, paused], [, epoch, ciphertext]] = await Promise.all([rd("policyOf", [id]), rd("bundleOf", [id])]);
    if (policyRev === 0n) return { policyRev: "0" };
    const out = { policyRev: String(policyRev), secretRev: String(secretRev), committeeId, paused, epoch, owner: owner.toLowerCase(), hasBundle: ciphertext !== "0x" };
    if (!out.hasBundle || epoch === 0) return out;
    const [[complete, , commitments], [threshold, , members]] = await Promise.all([rd("sharesOf", [id, secretRev, epoch]), rd("epochOf", [committeeId, epoch])]);
    return { ...out, complete, threshold, c0: commitments.slice(2, 2 + 66), ciphertext,
             members: members.map((m) => ({ encKey: m.encKey.slice(2).toLowerCase(), endpoint: m.endpoint })) };
  }
  async function read(id) {
    const heads = await Promise.allSettled(cs.map((c) => c.getBlockNumber({ cacheTime: 0 })));
    const ok = heads.filter((h) => h.status === "fulfilled").map((h) => h.value);
    if (ok.length < minAgree) throw Object.assign(new Error(`only ${ok.length} RPCs answered`), { code: "custody_unconfirmed" });
    // the HIGHEST head, never the lowest: a lagging RPC drops out instead of dragging the others back (custody/chain.mjs)
    const at = ok.reduce((a, x) => (x > a ? x : a));
    const got = (await Promise.allSettled(cs.map((c) => readAt(c, id, at)))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (got.length < minAgree) throw Object.assign(new Error(`only ${got.length} RPCs could read the vault at block ${at}`), { code: "custody_unconfirmed" });
    const d0 = JSON.stringify(got[0]);
    if (got.some((g) => JSON.stringify(g) !== d0)) throw Object.assign(new Error("RPCs disagree about the vault"), { code: "custody_unconfirmed" });
    if (maxAgeSec != null) {
      const blk = await cs[0].getBlock({ blockNumber: at }).catch(() => null);
      if (!blk || Number(blk.timestamp) < Math.floor(now() / 1000) - maxAgeSec)
        throw Object.assign(new Error(`the agreed block ${at} is older than ${maxAgeSec} s, or unreadable`), { code: "custody_unconfirmed" });
    }
    return got[0];
  }
  return {
    // the pointer for the attested release; null = no custody policy; { cleared: true } = a policy with no bundle
    async custodyStateFor(id) {
      const s = await read(id);
      if (s.policyRev === "0") return null;
      if (!s.hasBundle) return { cleared: true };
      if (s.v === 2) {
        if (s.bundleCommittee !== s.committeeId || s.bundleRev !== s.secretRev) throw Object.assign(new Error("the v2 bundle is not the policy's committee and revision"), { code: "custody_incomplete" });
        const lay = seatIndicesV2(s.machines.map((m) => m.enclave));
        if (lay.t !== s.t) throw Object.assign(new Error("the committee's threshold does not match its seats"), { code: "custody_incomplete" });
        return { v: 2, chainId, vault: vault2, committeeId: s.committeeId, epoch: s.epoch, t: s.t, policyRev: s.policyRev, secretRev: s.secretRev,
                 bundle: s.bundle, commitments: s.commitments, machines: s.machines.map((m, i) => ({ ...m, indices: lay.indices[i] })) };
      }
      if (!s.complete) throw Object.assign(new Error("the bundle's share set is incomplete"), { code: "custody_incomplete" });
      return { chainId, vault, policyRev: s.policyRev, secretRev: s.secretRev, epoch: s.epoch, threshold: s.threshold, members: s.members,
               c0: s.c0, ciphertext: Buffer.from(s.ciphertext.slice(2), "hex").toString("base64") };
    },
    // whether a custody policy exists. Only a YES is cached: custody is monotonic (a policy revision never returns to 0),
    // so a cached yes stays true, while a cached NO could let the legacy fetch serve the old plaintext copy in the seconds
    // after the owner moved the deployment. A no is always read fresh.
    async custodyHeld(id) {
      const c = cache.get(id);
      if (c && now() - c.at < ttlMs) return true;
      const s = await read(id);
      const value = s.policyRev !== "0";
      if (value) cache.set(id, { at: now() });
      return value;
    },
  };
}
