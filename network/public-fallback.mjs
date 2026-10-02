import net from 'node:net';
import {isBlockedHost} from '../relay/net-guard.mjs';

// A fleet may provision a pair of ordinary TUNA reverse ports per app, with
// an optional TLS passthrough frontend on 443. These are allocation hints,
// never an exemption from the owner's provider or diversity policy.
export function validatePublicFallback(value) {
  if (value === undefined || value === null) return null;
  if (!value || Object.keys(value).some(k => !['identity','address','httpsPort','httpPort'].includes(k)) ||
      !/^(?:[a-zA-Z0-9_.-]{1,128}\.)?[0-9a-f]{64}$/.test(value.identity || '') ||
      !net.isIP(value.address) || isBlockedHost(value.address) ||
      ![value.httpsPort,value.httpPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
      value.httpsPort === value.httpPort) throw new Error('invalid public fallback allocation');
  return {...value};
}
export const publicPorts = provider => provider.publicTcp || [443,80];
export const publicReservations = provider => publicPorts(provider).map(port => `${provider.address}:${port}`);
export function fallbackInventory(nodes, fallback) {
  const f = validatePublicFallback(fallback);
  return nodes.map(n => f && n.identity === f.identity && n.address === f.address
    ? {...n,publicTcp:[f.httpsPort,f.httpPort],fallback:true} : n);
}
