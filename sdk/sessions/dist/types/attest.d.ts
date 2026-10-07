import { type Address, type Hex } from "viem";
import { type RelayClient } from "./client.js";
/** Attested session keys (docs/design/sessions.md §10, phase g).
 *
 *  A grant whose `measurement` is non-zero may only be used by a key generated
 *  INSIDE an enclave running that image. The enclave makes the key, puts
 *  `sessionKeyReportData(chainId, x, y)` in report_data[0:32] of its SEV-SNP
 *  report, and hands the report to the relay (`requestAttestation`), which
 *  verifies it and records keyHash -> measurement in EnclaveKeyAttestations.
 *  The relay (relay/sessions.mjs) computes the same bytes. */
export declare const SESSION_KEY_DOMAIN = "enclave-session-key-v1";
/** How a 48-byte SEV-SNP launch measurement becomes the grant's bytes32. */
export declare const SESSION_KEY_MEASUREMENT_MAPPING = "sha256(SEV-SNP MEASUREMENT, the 48 raw bytes)";
/** report_data[0:32] for a session key: sha256("enclave-session-key-v1" ‖ uint256 chainId ‖ uint256 x ‖ uint256 y),
 *  the domain as ASCII and the three integers as 32-byte big-endian. */
export declare function sessionKeyReportData(chainId: number | bigint, x: bigint, y: bigint): Uint8Array;
/** The grant `measurement` for an SNP image: sha256 of its 48-byte launch measurement. */
export declare function snpMeasurementToBytes32(measurement: Hex | Uint8Array): Hex;
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
export type AttestErrorCode = "attest_disabled" | "bad_request" | "bad_key" | "unsupported_evidence" | "bad_report" | "bad_vcek" | "report_data_mismatch" | "policy_refused" | "not_vcek_signed" | "vmpl_mismatch" | "measurement_not_allowed" | "evidence_refused" | "attestor_not_authorized" | "key_revoked" | "measurement_conflict" | "attest_rate" | "revert";
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
/** Ask the relay to verify the enclave's report and record the key's measurement on chain. The answer is
 *  checked against the key asked about; whether the binding holds is the chain's to say (bindingOf). */
export declare function requestAttestation(relay: RelayClient, p: {
    x: bigint;
    y: bigint;
    evidence: SnpKeyEvidence;
}): Promise<AttestationResult>;
