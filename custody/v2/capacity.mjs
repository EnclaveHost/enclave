// Proof of capacity for a NON-Enclave custodian candidate (docs/security/secret-custody-v2.md §5 item 2): a capacity
// receipt from the capacity audit's witness (availability/witness.mjs), checked here by each member for itself:
//   - signed by a witness this custodian build trusts (MEASURED: the witness addresses and the receipt domain);
//   - fresh (issued, not expired) and labeled with the trust mode it claims (evidence.mjs verifyReceipt);
//   - naming THIS candidate: its hardware id is sha256 of the chip id in the candidate's own fresh report, its host is
//     the candidate's registry entry, its operator and payout wallet that entry's.
// The candidate presents its receipts (it obtains them from the witness for its host); a member never trusts a list.
import { createHash } from "node:crypto";
import { verifyReceipt } from "../../availability/evidence.mjs";

export function receiptCapacityCheck({ chainId, contract, witnesses, trustMode = "operator-bootstrap", minUnits = 1n, now = () => BigInt(Math.floor(Date.now() / 1000)) }) {
  const signers = Object.fromEntries(Object.entries(witnesses).map(([a, g]) => [a.toLowerCase(), g]));
  return async ({ machine, chipIdRaw, registry, receipts }) => {
    const hardwareId = "0x" + createHash("sha256").update(Buffer.from(String(chipIdRaw), "hex")).digest("hex");
    let last = "no capacity receipt was presented";
    for (const env of (receipts || []).slice(0, 8)) {
      try {
        const p = await verifyReceipt(env, { chainId, contract, signers, quorum: 1, nowSec: now(), kind: "capacity", hostOperator: registry.operator, trustMode });
        if (String(p.hardwareId).toLowerCase() !== hardwareId) { last = "the receipt names another chip"; continue; }
        if (String(p.hostId).toLowerCase() !== String(machine.registryId).toLowerCase()) { last = "the receipt names another host"; continue; }
        if (String(p.operator).toLowerCase() !== String(registry.operator).toLowerCase() || String(p.payoutWallet).toLowerCase() !== String(registry.payoutWallet).toLowerCase())
          { last = "the receipt's operator or payout wallet is not the registry's"; continue; }
        if (BigInt(p.units) < minUnits) { last = "the receipt's capacity is below the floor"; continue; }
        return { ok: true, units: p.units, issuedSec: p.issuedSec };
      } catch (e) { last = e.message; }
    }
    return { ok: false, reason: last };
  };
}
