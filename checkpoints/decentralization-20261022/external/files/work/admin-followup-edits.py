from pathlib import Path
r=Path('work/enclave')
p=r/'test/supervisor-wallet-policy.test.mjs';s=p.read_text().replace('tenantProvisions:new Set(),','tenantProvisions:new Set(),_releaseIntents:new Map(),');p.write_text(s)
p=r/'site/js/core/chain.js';s=p.read_text().replace('appCount:"b55ca2c3",','getApp:"42c71f1d", appCount:"b55ca2c3",');needle='export async function catGetAppsPage(start, n){';s=s.replace(needle,'''export async function catGetApp(appId){
  return decodeStruct(await ethCall(encCall(CAT_SEL.getApp, [{t:"bytes32",v:appId}])), APP_SCHEMA);
}
'''+needle);p.write_text(s)
p=r/'site/js/pages/deploy.js';s=p.read_text().replace('waitReceipt, catVersionFee }','waitReceipt, catVersionFee, catGetApp, catGetVersion }');s=s.replace('import { PREPARE_ONLY_ENVELOPE }', 'import { catalogAdmissionRefusal } from "../core/catalog-policy.js";\nimport { PREPARE_ONLY_ENVELOPE }');needle='  const capMsg = await gpuCapRefusal(spec.gpuMilli);';s=s.replace(needle,'''  const catalogRef = parseCatalogRef(spec.reference);
  if (!catalogRef) return showToast("Deploy refused: a catalog version is required.");
  try {
    const [app, version] = await Promise.all([catGetApp(catalogRef.appId), catGetVersion(catalogRef.appId,catalogRef.index)]);
    const refusal = catalogAdmissionRefusal(app,version,{forPrivate:spec.isPublic===false});
    if (refusal) return showToast("Deploy refused: " + refusal);
  } catch { return showToast("Deploy refused: could not verify current catalog moderation. Please retry."); }
'''+needle);p.write_text(s)
p=r/'docs/design/decentralized-architecture.md';s=p.read_text();a=s.index('Censorship resistance');b=s.index('\nIndependent operators',a);s=s[:a]+'''Censorship resistance means resistance to external parties and infrastructure
failures. Enclave's admin wallet retains platform governance: contract migration,
catalog moderation and malicious-host enforcement. Host owners may decline work
on their own machines but cannot override platform moderation. Computation remains
private. Moving Nan's processes to minipc completed server retirement, not removal
of mandatory centralized infrastructure.
''' +s[b:];s=s.replace('Required behavior under Enclave refusal','Required behavior under external censorship or service loss').replace('Accepted host owner chooses its policy; payout and operator are not ownership','Accepted host owner applies additional restrictions; platform moderation remains mandatory; payout and operator are not ownership').replace('without API moderation/quotes','without a mandatory centralized API or quote service; on-chain moderation applies').replace("without Enclave's release signer",'without one mandatory online release-signing server').replace('Independent host can use a sufficient independent quorum despite Enclave refusing shares','Authorized hosts can use a sufficient custodian quorum when endpoints fail').replace('Enclave cannot retire the serving ledger, redirect authorities, or impose an arbitrary global admission restriction','Enclave admin retains contract migration, catalog moderation and platform admission powers').replace('Irreversible ownership seal and fixed-block review tooling implemented; production ownership and dependency review remain outstanding','Admin-removal plans superseded; retain ownership and verify administrative operations and enforcement through migration')
a=s.index('## Governance disposition');b=s.index('## Storage and production acceptance',a)
s=s[:a]+'''## Governance disposition

The platform admin retains ledger administration, future contract migration,
catalog moderation and malicious-host enforcement. Host-wallet policy adds
restrictions for that host; it cannot exempt rejected, delisted or yanked apps.
Pending releases remain available for private development only. Admission and
renewal must read current policy from agreeing chain sources without requiring Nan.

The earlier `GovernanceSeal` ownership-sink proposal and its activation instructions
are superseded. Its source and fork tests are historical experiments, not release
requirements or authorization to remove admin powers. Never nominate a seal or
burn ownership as part of the current migration. Sealing completed ledger imports
is a distinct integrity operation and does not remove future administration.

Read-only production checks on 2026-10-20 confirmed the admin wallet still owns
ledger, catalog, proof verifier, pay and key-attestation contracts. Administrative
calls were simulated successfully, with unauthorized callers rejected. This does
not prove every administrative workflow or malicious-host enforcement path;
those remain explicit integration and migration acceptance requirements.

''' +s[b:];p.write_text(s)
p=r/'docs/network/authority-profile.md';s=p.read_text().replace("hosts admit deployments by catalog approval. On a host running wallet policy,\nthe host owner's policy decides whether approval is required.","hosts admit deployments by catalog approval. Wallet-policy hosts must enforce\nthe same platform moderation; an owner may add restrictions. Pending versions\nmay run only as private development deployments; rejection, yank and delisting\nremain mandatory refusals regardless of visibility.").replace('3. **Governance seal.** The owner powers listed above remain until the seal is\n   activated.','3. **Administrative continuity.** The owner powers listed above must remain\n   available after migration. Ownership-sink activation is superseded; verify\n   admin migration, catalog moderation and malicious-host enforcement.');p.write_text(s)
