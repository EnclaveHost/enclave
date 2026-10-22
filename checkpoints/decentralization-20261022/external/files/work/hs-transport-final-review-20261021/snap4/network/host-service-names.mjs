// The public names of a HOST's own service roles on the Enclave network (work/host-service-transport-20261021): derived
// from the host's FULL registry id, never chosen by anyone. A WireGuard provider grants exactly these names to a 'service'
// peer of that host (wg-provider/provider.mjs), and the host's ingress worker answers exactly these (host-service-ingress.mjs).
//   <label>-<base32(registry id)>.<zone>     label: dir | boot | policy
// base32 is RFC 4648 (lowercase, no padding) of all 32 bytes: 52 characters, injective, so two hosts never share a name
// (an 8-hex prefix like an app label would collide). A service name has a hyphen and 52 base32 characters, so it can
// never be an app label (8 hex) and is kept apart from app names and custom domains on both sides.
export const HOST_SERVICE_LABELS = Object.freeze({ dir: 'directory-replica', boot: 'bootstrap-replica', policy: 'policy-mirror' });
export const HOST_SERVICE_ROLES = Object.freeze(Object.fromEntries(Object.entries(HOST_SERVICE_LABELS).map(([l, r]) => [r, l])));
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID = /^0x[0-9a-f]{64}$/;
export const SERVICE_ZONE = /^(?=.{1,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function base32(bytes) {
  let out = '', bits = 0, value = 0;
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } value &= 0xff; }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function hostLabel(hostId) {
  const id = String(hostId || '').toLowerCase();
  if (!ID.test(id) || /^0x0{64}$/.test(id)) throw new Error('a host service name needs a nonzero 32-byte registry id');
  return base32(Buffer.from(id.slice(2), 'hex'));
}
export function validServiceZone(zone) {
  if (typeof zone !== 'string' || !SERVICE_ZONE.test(zone)) throw new Error('hostServices.zone must be a lowercase DNS zone');
  return zone;
}
/** -> { 'directory-replica': 'dir-<b32>.<zone>', ... } for one host */
export function hostServiceNames(hostId, zone) {
  const h = hostLabel(hostId); validServiceZone(zone);
  return Object.fromEntries(Object.entries(HOST_SERVICE_LABELS).map(([label, role]) => [role, `${label}-${h}.${zone}`]));
}
/** a name of the host-service SHAPE (any host) in `zone`, or of that shape anywhere when zone is null */
export function isHostServiceName(name, zone = null) {
  const n = String(name || '').toLowerCase();
  const m = /^(dir|boot|policy)-([a-z2-7]{52})\.(.+)$/.exec(n);
  return !!m && (zone === null || m[3] === zone);
}
