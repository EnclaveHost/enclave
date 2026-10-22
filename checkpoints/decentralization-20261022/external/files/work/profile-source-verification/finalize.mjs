import fs from 'node:fs';
const E='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const T=await import(E+'/scripts/network/verify-deployed-sources.mjs');
const {parseProfile}=await import(E+'/network/authority-profile.mjs');
const m=JSON.parse(fs.readFileSync('manifest-draft.json'));
const {profile}=parseProfile(fs.readFileSync(E+'/contracts/deployments/network-profile-base.json'),{expectedDigest:'sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8'});
const rec=JSON.parse(fs.readFileSync(E+'/contracts/deployments/ledger-15d-base.json')).sessionVaultV2;
const w=a=>'0x'+a.toLowerCase().slice(2).padStart(64,'0');
let checked=0;
for(const [n,c] of Object.entries(m.contracts)){
  const p=c.profileName&&profile.contracts[c.profileName];
  if(p)assert(p.codeHash===c.codeHash&&p.runtimeBytes===c.runtimeBytes,n+' profile code');
  for(const [k,v] of Object.entries(c.immutables)){const g=k.split('.')[1];
    if(p&&typeof p.immutable[g]==='string'&&/^0x[0-9a-f]{40}$/.test(p.immutable[g])){assert(w(p.immutable[g])===v,n+'.'+g);checked++;}}
}
function assert(x,w){if(!x)throw Error('cross-check failed: '+w);}
const li=m.contracts.legacySessionVaultImplementation.immutables,a=rec.SessionVaultFactory.args;
for(const [k,v] of [['usdc',a.usdc],['book',a.book],['router',a.router],['keyAttestations',a.keyAttestations]]){assert(li['SessionVault.'+k]===w(v),'record '+k);checked++;}
assert(BigInt(li['SessionVault.maxVault6'])===BigInt(a.maxVault6),'maxVault6');checked++;
assert(li['SessionVault.factory']===w(rec.SessionVaultFactory.address),'factory');checked++;
assert(m.contracts.legacySessionVaultImplementation.links['SessionVault.sol:SessionVaultLib']===rec.SessionVaultLib.address.toLowerCase(),'lib link');checked++;
assert(m.contracts.legacySessionVaultFactory.address===rec.SessionVaultFactory.address.toLowerCase(),'factory address');
assert(m.contracts.deployments.links['EnclaveDeployments.sol:EnclaveLedgerBandwidth']===m.contracts.ledgerBandwidthLibrary.address,'ledger lib');checked++;
console.log('cross-checks',checked);
const P='Address immutables equal the authority profile getter bindings';
const basis={
 registry:'Full match (runtime and CBOR metadata) with b17db9a3 (2026-08-09, "registry schema 4"). No immutables. Source HEAD (blob b7064f3e since 9895865c, 2026-08-11) is schema 5 and adds CAP_* capability bits, registerRelay, setCaps and CapsSet; their selectors are absent from this runtime, so the deployed registry has no relay or capability registration.',
 deployments:'Full match with 4b7419bb0 (2026-10-12, "ledger rev 16d"), runs 1, viaIR. '+P+' (usdc, registry). Its one linked library is ledgerBandwidthLibrary, verified from the same build.',
 ledgerBandwidthLibrary:'EnclaveLedgerBandwidth from the ledger rev 16d build; library_deploy_address (the viaIR call guard) holds its own address. Not listed in the authority profile; pinned transitively because the ledger runtime the profile pins embeds this address.',
 appCatalog:'Full match with f2e9a71d0 (2026-08-18), runs 200, viaIR. No immutables; owner, approvals and imports are storage.',
 proofOfTime:'Full match with 44d5b928 (2026-07-28 source, unchanged until deployment), runs 200, viaIR. '+P+' (deployments, registry).',
 enclavePay:'Full match with cf6022cc (2026-07-14), runs 200. '+P+' (usdc). owner and payout are storage.',
 verificationFees:'Full match with 28dd23c2 (2026-09-30), runs 200, viaIR. '+P+' (ledger, proof, token).',
 connectivity:'Full match only with unit names contracts/EnclaveConnectivity.sol and contracts/EnclaveDeployments.sol at runs 200, viaIR (not the build-contract-artifacts.mjs naming; no committed artifact held this metadata). Sources as of 4b7419bb0: connectivity blob c0fb0bed (unchanged 3ac18fcc..b28a9b2e^) with the live ledger rev 16d blob 3f3d2c3a. The live interface is the pre-v2 "tuna" one; b28a9b2e later renamed it. '+P+' (ledger, registry).',
 paymentRouter:'Full match with 09ccf9cd (2026-07-20), runs 200. '+P+' (usdc, treasury).',
 keyAttestations:'Full match with ee28c686 (2026-10-06), runs 200. No immutables; owner, pendingOwner and attestors are storage.',
 legacySessionVaultFactory:'Full match with 4aea7d89 (2026-10-07), runs 1, viaIR. implementation equals the profile binding and the legacy implementation below.',
 legacySessionVaultImplementation:'Full match with 4aea7d89, runs 1, viaIR. usdc, book, router, keyAttestations and maxVault6 equal the ledger-15d-base.json sessionVaultV2 factory args; book is the mutable EnclaveAddressBook. Linked SessionVaultLib equals that record.',
 legacySessionVaultLib:'SessionVaultLib from the same build; library_deploy_address holds its own address, which equals ledger-15d-base.json sessionVaultV2.SessionVaultLib.',
};
for(const [n,c] of Object.entries(m.contracts))c.basis=basis[n];
m.external.usdc.basis='External Circle upgradeable proxy (CBOR solc 0.6.12). Only the proxy runtime hash is pinned and its source is not verified here. Implementation and admin live in the ZeppelinOS slots named below; they are observed on every run but deliberately not pinned, because the admin can replace the implementation without changing the proxy hash. Verifying this proxy says nothing about future USDC behavior.';
T.validateManifest(m);
fs.writeFileSync(E+'/contracts/deployments/source-verification-base.json',JSON.stringify(m,null,2)+'\n',{flag:'wx'});
console.log('written');
