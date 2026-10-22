from pathlib import Path
r=Path('work/ledger17-migration')
p=r/'plan2.mjs';s=p.read_text();a=s.index('export function assertAdminRetainedReplay');b=s.index('\nexport async function writePlan2',a);s=s[:a]+'''export function assertAdminRetainedReplay(rep, expectedAdmin) {
  if (rep.result !== 'pass' || rep.governancePolicy !== 'enclave-admin-retained/v1' || rep.checks?.adminRetained?.verified !== true)
    throw Error('a successful admin-retaining replay is required; old governance-seal reports are superseded');
  const proof=rep.checks.adminRetained;
  if (!/^0x[0-9a-f]{40}$/i.test(expectedAdmin || '') || /^0x0{40}$/i.test(expectedAdmin)) throw Error('expected admin required');
  for(const key of ['ledgerOwner','proverOwner']) if(lc(proof[key])!==lc(expectedAdmin))throw Error('admin ownership mismatch');
  for(const key of ['ledgerPendingOwner','proverPendingOwner']) if(!/^0x0{40}$/i.test(proof[key]||''))throw Error('pending admin removal');
  for(const key of ['ledger.setLeaseSec','ledger.setPayout','ledger.retire (simulation only)','prover.setProofWindow'])
    if(proof.operations?.[key]?.adminAccepted!==true || proof.operations?.[key]?.outsiderRejected!==true)throw Error('missing admin operation proof: '+key);
  if (!Array.isArray(rep.executed) || !rep.executed.length || rep.executed.some(t => t.phase === 'X' || /GovernanceSeal|seal\\(\\)|ownership.*sink/i.test(t.label || '')))
    throw Error('admin-removal transactions are forbidden in the migration plan');
  const transfers=['setOwner(address)','transferOwnership(address)'].map(toFunctionSelector);
  const accept=toFunctionSelector('acceptOwnership()'), renounce=toFunctionSelector('renounceOwnership()');
  const targets=[rep.addresses?.ledger17,rep.addresses?.proofOfTime17];
  for(const target of targets) {
    if(!/^0x[0-9a-f]{40}$/i.test(target||''))throw Error('missing migration target');
    if(!rep.executed.some(t=>lc(t.to)===lc(target)&&lc(t.data)===accept&&lc(t.signer?.address)===lc(expectedAdmin)))
      throw Error('admin ownership acceptance missing');
  }
  for(const tx of rep.executed){
    if(!tx.to)continue; // constructor bytes are not function calls
    const data=lc(tx.data), selector=data.slice(0,10);
    if(selector===renounce)throw Error('ownership renunciation forbidden');
    if(transfers.includes(selector) && (data.length!==74 || data.slice(10,34)!=='0'.repeat(24) || '0x'+data.slice(34)!==lc(expectedAdmin)))
      throw Error('ownership transfer must retain the admin wallet');
    if(targets.some(a=>lc(a)===lc(tx.to))&&selector===accept&&lc(tx.signer?.address)!==lc(expectedAdmin))
      throw Error('only the admin wallet may accept ownership');
  }
}
''' + s[b:];s=s.replace('assertAdminRetainedReplay(rep);','assertAdminRetainedReplay(rep, snap.ledger.params.owner);');s=s.replace("replay: { file: path.basename(replayFile), result: rep.result },", "replay: { file: path.basename(replayFile), result: rep.result }, admin: snap.ledger.params.owner, adminControls: rep.checks.adminRetained,")
p.write_text(s)
p=r/'migrate-ledger-17.mjs';s=p.read_text().replace('every predicted address (incl. CREATE2 seals) still empty','every predicted address still empty; admin-retaining plan required');s=s.replace("    const plan = JSON.parse(fs.readFileSync(arg('--plan2'), 'utf8'));", "    const plan = JSON.parse(fs.readFileSync(arg('--plan2'), 'utf8'));\n    const {assertAdminRetainedReplay}=await import('./plan2.mjs');\n    if(plan.version!==3)throw Error('superseded migration plan; regenerate with admin retention');\n    assertAdminRetainedReplay({result:plan.replay?.result,governancePolicy:plan.governancePolicy,checks:{adminRetained:plan.adminControls},addresses:plan.addresses,executed:plan.transactions},plan.admin);")
s=s.replace("    const proxy = await codeAt(block, '0x4e59b44847b379578588920cA78FbF26c0B4956C');\n",'').replace(" && keccak256(proxy) === '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989'",'').replace('      create2ProxyCodeHash: keccak256(proxy), note:', '      governancePolicy: plan.governancePolicy, note:');p.write_text(s)
p=r/'replay.mjs';s=p.read_text().replace("if (adminError !== null || outsiderError === null)","if (adminError !== null || outsiderError === null || !/revert/i.test(outsiderError))");p.write_text(s)
