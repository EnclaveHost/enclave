// Legacy routing builds and builds allowed to receive pad seeds are separate
// admissions. Older payloads can sign arbitrary binding transcripts, so a v2
// claim never promotes a legacy code hash into the pad allowlist.
export function avfPolicyFromEnv(env) {
  const pins = (key) => String(env[key] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const codeHashes = pins("METAL_AVF_CODE_HASHES");
  const padCodeHashes = pins("METAL_AVF_PAD_CODE_HASHES");
  const authorityHashes = pins("METAL_AVF_AUTHORITY_HASHES");
  return (codeHashes.length || padCodeHashes.length) && authorityHashes.length ?
    { codeHashes, padCodeHashes, authorityHashes } : null;
}
