// Public release authority, distinct from the boot's IDKS report-signing key.
// signer is SHA-256 of the 104-byte CNG ECC public blob, as reported by VBS.
const HEX = /^[0-9a-f]{64}$/;
const u32 = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const fields = (p, names) => !!p && typeof p === 'object' && !Array.isArray(p) &&
  Reflect.ownKeys(p).length === names.length && names.every(k => {
    const d = Object.getOwnPropertyDescriptor(p, k);
    return d && Object.hasOwn(d, 'value') && d.enumerable;
  });
export function validImageIdentity(p) {
  return fields(p, ['signer', 'productId', 'moduleId']) && typeof p.signer === 'string' && p.signer.length === 64 && HEX.test(p.signer) &&
    p.signer !== '0'.repeat(64) && u32(p.productId) && u32(p.moduleId);
}

export function validImageIdentities(pins) {
  return Array.isArray(pins) && pins.length > 0 && pins.length <= 256 &&
    Array.from(pins).every(p => fields(p, ['measurement', 'identity']) &&
      typeof p.measurement === 'string' && p.measurement.length === 64 && HEX.test(p.measurement) && validImageIdentity(p.identity));
}

// A partially pinned candidate set is ambiguous. Refuse it rather than turn a
// missing identity into a wildcard or combine one image with another signer.
export function imageIdentityPins(images) {
  if (!images.some(p => p.identity !== undefined || p.nativeDesktop === true)) return undefined;
  const pins = images.map(p => ({ measurement: p.measurement, identity: p.identity }));
  if (!validImageIdentities(pins)) throw new Error('explicit image signer/product/module pins are required for every candidate');
  return pins;
}
