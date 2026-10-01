// The wallet binds the host and fallback policy together. Omitted fallback is
// the previous client format, whose only policy was to allow fallback.
export const placementMessage = (ledger, id, hostId, expiry, nonce, allowFallback) =>
  `Enclave placement\nLedger: ${ledger}\nDeployment: ${id}\nPreferred host: ${hostId || 'Auto'}${allowFallback === undefined ? '' : `\nAllow fallback: ${allowFallback}`}\nExpires: ${expiry}\nNonce: ${nonce}`;
export function pinnedHost(raw = '') {
  const envelope = JSON.parse(String(raw || '{}'));
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') throw Error('Invalid deployment options.');
  if (!('placement' in envelope)) return '';
  const p = envelope.placement;
  if (!p || Array.isArray(p) || typeof p !== 'object' || Object.keys(p).some(k => k !== 'hostId')
      || typeof p.hostId !== 'string' || !/^0x[0-9a-f]{64}$/.test(p.hostId) || /^0x0{64}$/.test(p.hostId))
    throw Error('Invalid placement pin.');
  return p.hostId;
}
export function withPlacementPin(raw, hostId, allowFallback = true, cap = 4096) {
  pinnedHost(raw); // Never silently discard an unknown policy.
  const envelope = JSON.parse(String(raw || '{}'));
  if (hostId && !allowFallback) envelope.placement = { hostId };
  else delete envelope.placement;
  const text = JSON.stringify(envelope);
  if (new TextEncoder().encode(text).length > cap) throw Error(`Deployment options exceed this ledger’s ${cap}-byte limit.`);
  return text;
}
