// servedOwner(host, owner): make `owner` the box's operator for a test that is NOT about the owner rule, so ownerSet()
// is {owner} and the tick's refreshOwners (which re-reads the operator key and the delegation files) keeps it.
//
// Since coordinator enclave-87's owner rule (2026-09-26) a node serves, in owner-only scope - which is every Windows
// node today - only its operator's and its delegated owners' deployments, and ensureApp HOLDS anything else. Fixtures
// that used OWNER_WALLET (or no owner at all) for "the box owner" now say so here. The rule itself is tested with a
// real operator key and real signed delegations in test/windows-node-owner-set.test.mjs.
export function servedOwner(host, owner) {
  host.owners = { operator: String(owner).toLowerCase(), delegations: [], invalid: new Map() };
  host.refreshOwners = async () => host.ownerSet();
  return host;
}
