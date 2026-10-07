import { bytesToHex, concat, numberToBytes, sha256, stringToBytes, type Address, type Hex } from "viem";
import { SessionError, type RelayClient } from "./client.js";
import { keyHashOf } from "./typed.js";

/** Attested session keys (docs/design/sessions.md §10, phase g).
 *
 *  A grant whose `measurement` is non-zero may only be used by a key generated
 *  INSIDE an enclave running that image. The enclave makes the key, puts
 *  `sessionKeyReportData(chainId, x, y)` in report_data[0:32] of its SEV-SNP
 *  report, and hands the report to the relay (`requestAttestation`), which
 *  verifies it and records keyHash -> measurement in EnclaveKeyAttestations.
 *  The relay (relay/sessions.mjs) computes the same bytes. */

export const SESSION_KEY_DOMAIN = "enclave-session-key-v1";
/** How a 48-byte SEV-SNP launch measurement becomes the grant's bytes32. */
export const SESSION_KEY_MEASUREMENT_MAPPING = "sha256(SEV-SNP MEASUREMENT, the 48 raw bytes)";

const TWO_256 = 1n << 256n;
function u256(v: number | bigint, name: string): Uint8Array {
  const b = BigInt(v);
  if (b < 0n || b >= TWO_256) throw new Error(`${name} out of range`);
  return numberToBytes(b, { size: 32 });
}

/** report_data[0:32] for a session key: sha256("enclave-session-key-v1" ‖ uint256 chainId ‖ uint256 x ‖ uint256 y),
 *  the domain as ASCII and the three integers as 32-byte big-endian. */
export function sessionKeyReportData(chainId: number | bigint, x: bigint, y: bigint): Uint8Array {
  return sha256(concat([stringToBytes(SESSION_KEY_DOMAIN), u256(chainId, "chainId"), u256(x, "x"), u256(y, "y")]), "bytes");
}

/** The grant `measurement` for an SNP image: sha256 of its 48-byte launch measurement. */
export function snpMeasurementToBytes32(measurement: Hex | Uint8Array): Hex {
  const b = typeof measurement === "string" ? measurement.replace(/^0x/, "") : bytesToHex(measurement).slice(2);
  if (!/^[0-9a-fA-F]{96}$/.test(b)) throw new Error("an SEV-SNP measurement is 48 bytes");
  return sha256(`0x${b}`);
}

export interface SnpKeyEvidence {
  type: "sev-snp";
  /** the raw 0x4A0-byte ATTESTATION_REPORT */
  report: Hex | Uint8Array;
  /** the chip's VCEK (PEM, or DER as hex); else the relay fetches it from AMD KDS */
  vcek?: string;
  /** or the guest's whole certificate table (hex), as the SNP extended report returns it */
  auxblob?: Hex | Uint8Array;
}

/** Codes the relay answers /attest refusals with (SessionError.code). */
export type AttestErrorCode =
  | "attest_disabled" | "bad_request" | "bad_key" | "unsupported_evidence" | "bad_report" | "bad_vcek"
  | "report_data_mismatch" | "policy_refused" | "not_vcek_signed" | "vmpl_mismatch" | "measurement_not_allowed"
  | "evidence_refused" | "attestor_not_authorized" | "key_revoked" | "measurement_conflict" | "attest_rate" | "revert";

export interface AttestationResult {
  keyHash: Hex;
  /** the bytes32 a grant names (SESSION_KEY_MEASUREMENT_MAPPING of snpMeasurement) */
  measurement: Hex;
  /** the report's 48-byte measurement, hex without 0x */
  snpMeasurement: string;
  mapping: string;
  /** EnclaveKeyAttestations */
  contract: Address;
  attestor: Address;
  /** null when the key was already attested under this measurement (nothing written) */
  txHash: Hex | null;
  already: boolean;
  block?: number;
  tcb?: unknown;
}

const hexOf = (v: Hex | Uint8Array): Hex => (typeof v === "string" ? v : bytesToHex(v));

/** Ask the relay to verify the enclave's report and record the key's measurement on chain. The answer is
 *  checked against the key asked about; whether the binding holds is the chain's to say (bindingOf). */
export async function requestAttestation(relay: RelayClient, p: { x: bigint; y: bigint; evidence: SnpKeyEvidence }):
  Promise<AttestationResult> {
  const evidence = {
    type: p.evidence.type, report: hexOf(p.evidence.report),
    ...(p.evidence.vcek !== undefined ? { vcek: p.evidence.vcek } : {}),
    ...(p.evidence.auxblob !== undefined ? { auxblob: hexOf(p.evidence.auxblob) } : {}),
  };
  const res = await relay.request<AttestationResult>("POST", "/attest", { x: p.x, y: p.y, evidence });
  if (String(res.keyHash).toLowerCase() !== keyHashOf(p.x, p.y).toLowerCase())
    throw new SessionError("relay", "the relay answered for a different key", { keyHash: res.keyHash });
  return res;
}
