// Is a WireGuard provider configured as MINIMAL TRANSPORT (work/hosted-service-placement)? A transport machine keeps only
// WireGuard tunnel establishment, packet/byte forwarding and the management that strictly needs: exit/guard tunnels and
// peers, raw SNI/Host routing to the tunnel of the peer that holds a name (no TLS termination), the peer-grant control API,
// its signed provider record and its transfer budget (network/wg-provider/*). Everything else is an application service
// that belongs on an Enclave host or app, and this refuses it:
//   localRoutes  - services ON the box (a custodian, a website) reached by name on the public ports;
//   noSniRoute   - an IP-certificate recovery ingress into an on-box TLS service;
//   relay        - the Enclave relay's custom-domain map (and, in a legacy bootstrap, the directory fallback);
//   bootstrap "legacy" - Enclave's mutable defaults instead of the operator's explicit authorities.
// A paid/settlement role (pricePerGiB6 > 0: receipts, on-chain attestations) is reported as a separate role, not transport.
//   node scripts/check-transport-profile.mjs <provider.json>     exit 0 = transport-only, 1 = not (reasons printed)
// It reads the configuration's FIELD NAMES and values only; it never opens a key file the configuration names.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkTransportProfile(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('provider configuration must be an object');
  const violations = [], separateRoles = [], transport = [];
  const roles = Array.isArray(cfg.roles) ? cfg.roles : ['guard', 'ingress', 'egress'];
  for (const r of roles) if (!['guard', 'ingress', 'egress'].includes(r)) violations.push(`role ${JSON.stringify(r)} is not a transport role`);
  transport.push(`WireGuard roles ${roles.join(', ')}`, 'raw SNI/Host routing to peer tunnels (no TLS termination)', 'peer-grant control API', 'signed provider record', 'transfer budget');
  const local = cfg.localRoutes && typeof cfg.localRoutes === 'object' ? Object.keys(cfg.localRoutes) : [];
  if (local.length) violations.push(`localRoutes serves ${local.length} on-box service name(s) (${local.slice(0, 4).join(', ')}): application co-location; move each service to an Enclave host/app`);
  if (cfg.noSniRoute) violations.push('noSniRoute forwards SNI-less TLS to an on-box service (an IP-certificate recovery ingress): an application endpoint on the transport machine');
  if (cfg.relay) violations.push('relay: the custom-domain map comes from the Enclave relay; route records and owner names belong in directories');
  const mode = cfg.bootstrap ?? 'legacy';
  if (mode !== 'explicit') violations.push('bootstrap is legacy (Enclave defaults: relay directory fallback, mutable address book); use "explicit" with the operator\'s own authorities');
  if ((cfg.pricePerGiB6 || 0) > 0 || cfg.proofKeyFile) separateRoles.push('paid provider: receipt co-signing and on-chain checker attestations (settlement for a community provider on a registry host), not transport');
  return { ok: violations.length === 0, transport, violations, separateRoles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: check-transport-profile.mjs <provider.json>'); process.exit(2); }
  const r = checkTransportProfile(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
