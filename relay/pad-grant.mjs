// Canonical platform-authenticated seed grants. Encryption to a public pad
// key does not prove who chose the seed; this signature does.
const HEX = /^[0-9a-f]+$/;
const hex = (s, n) => typeof s === "string" && s.length === n && HEX.test(s);
export function padGrantDigestsValid(model, calib) { return hex(model, 64) && hex(calib, 64); }
export function padGrantNonceValid(nonce) { return hex(nonce, 64); }

export function seedGrantMessage(g) {
  if (!g || g.grant_version !== 1 || typeof g.name !== "string" ||
      g.name.length < 1 || g.name.length > 64 || /[^A-Za-z0-9_-]/.test(g.name) ||
      !hex(g.transport_key, 88) || !g.transport_key.startsWith("302a300506032b6570032100") ||
      !hex(g.pad_key, 64) || !padGrantDigestsValid(g.model_digest, g.calib_digest) ||
      !padGrantNonceValid(g.request_nonce) || !hex(g.seed_id, 32) ||
      !Number.isSafeInteger(g.epoch) || g.epoch < 1 ||
      !hex(g.epk, 64) || !hex(g.nonce, 24) || !hex(g.box, 96))
    throw new Error("invalid pad seed grant");
  return ["enclave-pads-seed-grant-v1", g.name, g.transport_key, g.pad_key,
    g.model_digest, g.calib_digest, g.request_nonce, g.seed_id, g.epoch,
    g.epk, g.nonce, g.box].join("\n");
}
