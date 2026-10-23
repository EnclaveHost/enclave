// A FIXTURE EnclaveSecretVaultV2 for the dashboard's custody v2 tests (test/custody-v2-dashboard*.test.mjs). It is NOT the
// chain: it serves the custody/v2/chain.mjs reader interface (readVaultIdentity, snapshot, readRelease, readCommittee) from
// in-memory state, and applies an owner's `update` calldata with the rules of contracts/EnclaveSecretVaultV2.sol _apply
// (owner = policy owner, or beneficialOwnerOf at the first write; expectPolicyRev; a first write sets a policy; a bundle
// needs an existing committee; secretRev + 1 per bundle; policyRev + 1 per update). The committee key Y is a real v2
// genesis key whose secret x the test keeps, so a stored bundle can be opened exactly as a custodian quorum would.
import { decodeFunctionData, bytesToHex, hexToBytes } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as v2 from "../../custody/v2/protocol.mjs";
import { UPDATE_V2_ABI } from "../../custody/v2/owner.mjs";
import { REVIEWED_CUSTODY_VAULTS, PRODUCTION_CUSTODY_VAULT } from "../../network/custody-vaults.mjs";

export const VAULT = PRODUCTION_CUSTODY_VAULT;
export const BOOK = REVIEWED_CUSTODY_VAULTS[VAULT].immutable.book;
export const GENESIS_COMMITTEE = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
const ZERO = "0x" + "00".repeat(20);
const lc = (a) => String(a || "").toLowerCase();

export class VaultError extends Error { constructor(name){ super("execution reverted: " + name); this.revert = name; } }

export function committeeKey(){
  const g = v2.genesis();
  return { x: g.shares[0].x, Y: g.Y };
}
/** a committee record the way readCommitteeAt returns it */
export function committee(committeeId, Y, { machines = 1, enclave = machines, t = 1, epoch = 1 } = {}){
  return { committeeId: lc(committeeId), Y, epoch, t, W: machines, activatedAt: 1,
           machines: Array.from({ length: machines }, (_, i) => ({ identity: "0x" + String(i + 1).padStart(40, "a"), encKey: "0x" + "11".repeat(32),
             endpoint: "https://custodian-" + i + ".example", chipId: "0x" + String(i).padStart(64, "c"), registryId: "0x" + String(i).padStart(64, "e"),
             measurement: "0x" + "33".repeat(32), enclave: i < enclave })),
           commitments: new Uint8Array(0) };
}
/** open a stored bundle with the committee secret x, as t custodians would (R * x) */
export function openBundle({ x, chainId = 8453, vault = VAULT, id, secretRev, committeeId, bundle }){
  const label = v2.labelOf({ chainId, vault: lc(vault), id, secretRev, committeeId });
  const R = secp256k1.ProjectivePoint.fromHex(bundle.subarray(0, 33));
  return v2.decryptBundle({ S: R.multiply(x), label, bundle });
}

export class FakeVault {
  constructor({ vault = VAULT, identity = null, bookEntry = VAULT } = {}){
    const r = REVIEWED_CUSTODY_VAULTS[lc(vault)];
    this.vault = lc(vault);
    this.identity = identity || (r ? { codeHash: r.codeHash, runtimeBytes: r.runtimeBytes, book: r.immutable.book, enclaveOwner: r.immutable.enclaveOwner } : null);
    this.bookEntry = lc(bookEntry);
    this.ledger = new Map();      // id -> { owner, envelope, sessionOwner? }
    this.codes = new Map();       // address -> code
    this.contractOwners = new Map(); // contract address -> what its owner() answers (a SessionVault stand-in)
    this.committees = new Map();  // cid -> committee
    this.policies = new Map();    // id -> policy
    this.bundles = new Map();     // id -> { committeeId, data }
    this.calls = [];              // every reader call, in order
    this.applied = [];            // every accepted update
    this.failIdentity = null; this.failBook = null; this.tamper = null; this.raceBump = false;
  }
  beneficialOwnerOf(id){ const row = this.ledger.get(id); if (!row) return ZERO; return lc(row.sessionOwner || row.owner); }
  policyOf(id){ return this.policies.get(id) || { owner: ZERO, policyRev: 0n, secretRev: 0n, committeeId: "0x" + "00".repeat(32), paused: false, rules: new Uint8Array(0) }; }
  release(id){
    const p = this.policyOf(id), b = this.bundles.get(id), row = this.ledger.get(id);
    const committee = /^0x0{64}$/.test(p.committeeId) ? null : (this.committees.get(p.committeeId) || null);
    return { policy: { ...p }, bundle: { committeeId: b ? b.committeeId : "0x" + "00".repeat(32), secretRev: p.secretRev, data: b ? b.data : new Uint8Array(0) },
             committee, beneficialOwner: this.beneficialOwnerOf(id),
             lease: row ? { owner: lc(row.owner), runner: ZERO, leaseUntil: 0, appRef: "", envelope: row.envelope || "" } : null, endpointId: null, endpointOperator: null };
  }
  get reader(){
    const self = this;
    return {
      vault: this.vault, vaultKind: "book",
      readVaultIdentity: async () => { self.calls.push("identity"); if (self.failIdentity) throw self.failIdentity; return { ...self.identity }; },
      snapshot: async (fn) => { self.calls.push("snapshot");
        if (self.failBook) throw self.failBook;
        // as custody/v2/quorum.mjs does: an object result merged with the agreed block's facts (a bare value is lost)
        const out = await fn({ block: 1n,
          call: async (address, abi, name, args) => {
            if (lc(address) === lc(self.identity && self.identity.book) && name === "addr") return self.bookEntry;
            if (name === "owner" && self.contractOwners.has(lc(address))) return self.contractOwners.get(lc(address));
            throw new Error("fixture: no call " + name + " on " + address);
          },
          code: async (a) => self.codes.get(lc(a)) || "0x" });
        return { ...out, blockNumber: 1n, blockHash: "0x" + "01".repeat(32), blockTimestamp: Math.floor(Date.now() / 1000) }; },
      readRelease: async ({ id }) => { self.calls.push("release"); return self.release(lc(id)); },
      readCommittee: async ({ committeeId }) => { self.calls.push("committee"); return { committee: self.committees.get(lc(committeeId)) || null, pending: null }; },
    };
  }
  /** the chain executing `to.update(...)` sent by `from`: the contract's _apply rules, or a revert */
  execute(from, to, data){
    if (lc(to) !== this.vault) throw new VaultError("WrongTarget");
    const { functionName, args } = decodeFunctionData({ abi: UPDATE_V2_ABI, data });
    if (functionName !== "update") throw new VaultError("NotUpdate");
    const [id, u] = [lc(args[0]), args[1]];
    const p = this.policyOf(id);
    const owner = p.policyRev ? p.owner : this.beneficialOwnerOf(id);
    if (!owner || owner === ZERO || lc(from) !== owner) throw new VaultError("NotOwner");
    if (this.raceBump) { this.raceBump = false; p.policyRev += 1n; this.policies.set(id, { ...p }); }
    if (u.expectPolicyRev !== p.policyRev) throw new VaultError("StaleRevision");
    const next = { ...p, owner };
    if (!p.policyRev && !u.setPolicy) throw new VaultError("BadRules");
    if (u.setBundle && u.clear) throw new VaultError("BadBundle");
    if (u.setPolicy){
      const cid = lc(u.committeeId);
      if (!this.committees.has(cid)) throw new VaultError("BadCommittee");
      next.committeeId = cid; next.paused = u.paused; next.rules = hexToBytes(u.rules);
    }
    if (u.setBundle){
      if (!this.committees.has(next.committeeId)) throw new VaultError("BadCommittee");
      next.secretRev = p.secretRev + 1n;
      let data = hexToBytes(u.bundle);
      if (this.tamper) data = this.tamper(data);
      this.bundles.set(id, { committeeId: next.committeeId, data });
    }
    if (u.clear){ next.secretRev = p.secretRev + 1n; this.bundles.delete(id); }
    next.policyRev = p.policyRev + 1n;
    this.policies.set(id, next);
    this.applied.push({ from: lc(from), id, update: u });
    return "0x" + (this.applied.length).toString(16).padStart(64, "0");
  }
  /** a wallet that signs as `address` and whose transactions this fixture executes */
  wallet(address){
    const self = this, sent = [];
    return { address: lc(address), sent,
      sendTx: async (to, data) => { sent.push({ to, data }); return self.execute(address, to, data); },
      waitReceipt: async () => ({ status: "success" }) };
  }
}
export { bytesToHex };
