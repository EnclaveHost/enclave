/* ============================================================
   Session owners that are CONTRACT accounts (independent mode).

   The pinned SessionVault accepts any owner address. An owner
   signature is either 65-byte low-s ECDSA from that address, or -
   when the owner carries code - ERC-1271 isValidSignature on it
   (contracts/SessionVault.sol _ownerSigValid). USDC's EIP-3009 deposit
   behind openWithDeposit honors ERC-1271 the same way. So a Safe (its
   own M-of-N signers and recovery), an EIP-7702 account, or a passkey
   smart account can own sessions and deployments with no Enclave
   account authority. (work/passkey-independence-interface.txt has
   the whole plan.)

   This page does not re-implement any of those signature checks. It
   asks the contracts: the EXACT factory call that would be submitted
   (openFor / openWithDepositFor) is simulated with eth_call at a block
   the profile's RPCs agree on. An agreed success means the vault -
   and USDC, for a deposit - accept these very signatures now; an
   agreed revert is refused before any transaction or user operation
   exists. Two things are said plainly instead of being discovered on
   chain:
   - an ERC-6492 (counterfactual) signature: SessionVault has no
     ERC-6492 support, so the account must be deployed first;
   - what kind of owner this is (EOA, EIP-7702-delegated EOA, or a
     contract account whose own rules - signers, threshold, recovery -
     decide).
   ============================================================ */
import { reader as quorumReader } from "./independent-chain.js";

// ERC-6492: a signature wrapped for a not-yet-deployed account ends with this 32-byte magic suffix
const MAGIC_6492 = "6492".repeat(16);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export class OwnerSignatureError extends Error {
  constructor(message, { code = "refused", kind = null } = {}){ super(message); this.name = "OwnerSignatureError"; this.code = code; this.kind = kind; }
}

export function isErc6492(sig){
  const s = String(sig || "").toLowerCase();
  return /^0x[0-9a-f]+$/.test(s) && s.length > 2 + 64 && s.endsWith(MAGIC_6492);
}

/* The owner's kind from its code at the agreed block: "eoa" (no code), "delegated-eoa" (EIP-7702 designator
   0xef0100 || delegate), or "contract" (ERC-1271 decides). */
export function kindOfCode(code){
  const c = String(code || "0x").toLowerCase();
  if (c === "0x" || c === "") return { kind: "eoa" };
  const m = /^0xef0100([0-9a-f]{40})$/.exec(c);
  if (m) return { kind: "delegated-eoa", delegate: "0x" + m[1] };
  return { kind: "contract" };
}
export async function ownerAccountKind(owner, { reader = quorumReader() } = {}){
  if (!ADDR.test(owner || "")) throw new OwnerSignatureError("an owner address is required", { code: "input" });
  const snap = await reader.snapshot();
  return { ...kindOfCode(await reader.code(snap, owner)), block: snap.number };
}

/* Plain words for the panel. */
export function describeOwnerKind(k){
  if (!k) return "";
  if (k.kind === "eoa") return "an ordinary wallet key (EOA): its signature is checked with ECDSA";
  if (k.kind === "delegated-eoa") return "a wallet key delegated by EIP-7702 to " + k.delegate + ": the key's ECDSA signature, or the delegate's ERC-1271 check";
  return "a contract account: its own ERC-1271 rules decide (its signers, any threshold and recovery)";
}

/**
 * Would the vault accept these owner signatures in exactly this call? `prep` is the SDK's prepared factory call
 * ({to, data}); `signatures` are the owner signatures inside it (grant, and the USDC authorization for a budget).
 * -> { kind, block, result } on an agreed success; throws OwnerSignatureError otherwise (nothing is sent).
 */
export async function verifyOwnerSubmission({ prep, owner, signatures = [] }, { reader = quorumReader() } = {}){
  if (!prep || !ADDR.test(prep.to || "") || !/^0x[0-9a-fA-F]*$/.test(prep.data || "")) throw new OwnerSignatureError("a prepared call is required", { code: "input" });
  if (signatures.some(isErc6492))
    throw new OwnerSignatureError("This owner account is not deployed yet (its wallet returned an ERC-6492 signature). A session vault accepts only a deployed account's ERC-1271 signature: deploy the account first (any first transaction from it), then sign again. Nothing was sent.",
      { code: "undeployed", kind: "contract" });
  let snap, k;
  try {
    snap = await reader.snapshot();
    k = kindOfCode(await reader.code(snap, owner));
  } catch (e){ throw new OwnerSignatureError("The chain endpoints did not agree, so the owner signature could not be checked (" + String(e.message || e).slice(0, 160) + "). Nothing was sent.", { code: "chain" }); }
  try {
    const result = await reader.call(snap, prep.to, prep.data);
    return { ...k, block: snap.number, result };
  } catch (e){
    if (!(e && e.revert)) throw new OwnerSignatureError("The chain endpoints did not agree on the check (" + String(e.message || e).slice(0, 160) + "). Nothing was sent.", { code: "chain", kind: k.kind });
    throw new OwnerSignatureError(k.kind === "eoa"
      ? "The session vault would refuse this: the signature is not this wallet's over exactly this request (or the request is no longer valid). Nothing was sent."
      : "The session vault would refuse this: the owner account (" + k.kind + ") did not accept the signature through ERC-1271 for exactly this request, or the request is no longer valid. Its own signers or threshold may need to approve it. Nothing was sent.",
      { code: "refused", kind: k.kind });
  }
}

/* An SDK OwnerSigner that records what it signs, so the exact signatures can be checked before submission. */
export function recordingSigner(signer){
  const signatures = [];
  return { signatures, signer: { address: signer.address, signTypedData: async (td) => { const s = await signer.signTypedData(td); signatures.push(s); return s; } } };
}
