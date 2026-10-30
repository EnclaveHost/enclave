// The production incident always includes both original deployments, even when their leases have expired.
// An empty/partial inventory must never bypass the existing lease-window protection. Generic protocol fixtures
// can model an account with no leases; the production preparation and NEW-signing entrypoints cannot.
export const PROTECTED_IDS=Object.freeze([
 '0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9',
 '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c',
]);
export function requireProtectedInventory(quiesce){
 const leases=quiesce?.leases;
 if(!Array.isArray(leases)||leases.length!==PROTECTED_IDS.length||new Set(leases.map(l=>l?.id)).size!==PROTECTED_IDS.length||PROTECTED_IDS.some(id=>!leases.some(l=>l?.id===id)))throw Error('Both original metal0 deployments must be included; omitted leases cannot waive the maintenance window');
 return quiesce;
}
