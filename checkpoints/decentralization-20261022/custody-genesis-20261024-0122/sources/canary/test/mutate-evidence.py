#!/usr/bin/env python3
"""Mutation checks for evidence gates, offline only. Any surviving mutant fails this run."""
from pathlib import Path
import tempfile, shutil, subprocess, re
root=Path(__file__).resolve().parents[1]
mutants=[
 ('genesis-success','genesis.mjs',"receipt.status==='success' && "," "),
 ('genesis-event-identity','genesis.mjs',"lc(created[0].args.committeeId)===cid", "true"),
 ('genesis-provider-agreement','genesis.mjs',"equal(pick(reads[0]),pick(reads[1]))", "true"),
 ('genesis-confirmations','genesis.mjs',"head>=receipt.blockNumber+2n", "true"),
 ('genesis-host-owner','genesis.mjs',"lc(e.owner) === ADMIN", "true"),
 ('genesis-code-activation','genesis.mjs',"facts.codeActiveAt?.[R2.measurementSha256]===Number(genesisBlock.timestamp)", "true"),
 ('genesis-old-code','genesis.mjs',"facts.codeActiveAt?.[OLD_CUSTODIAN_MEASUREMENT_SHA]===0", "true"),
 ('genesis-key-binding','genesis.mjs',"hex(c.Y)===derived.Y", "true"),
 ('journal-order','journal.mjs','if (!ready.ok) throw new Error','if (false) throw new Error'),
 ('current-hmac','proof.mjs','matched = required.every(matches);','matched = true;'),
 ('reject-old','proof.mjs','if (oldMatches) reasons.push','if (false) reasons.push'),
 ('exact-shape','proof.mjs',"same(Object.keys(body).sort(), ['names', 'proofs', 'v'])",'true'),
 ('empty-sets','assert.mjs','if (reasons.length) return { outcome: "fail", reasons, evidence: { scope: "search coverage missing" } };','if (false) return { outcome: "fail", reasons, evidence: { scope: "search coverage missing" } }; reasons.length=0;'),
 ('typed-control','assert.mjs','!Number.isSafeInteger(control?.[loc]) || control[loc] <= 0','!(control?.[loc] > 0)'),
 ('observed-rollback','assert.mjs','if (obs.olderBlobOpened !== true || obs.sameIdentity !== true || typeof obs.custodianRefusedOldState !== "boolean")','if (false)'),
 ('missing-protected-fields','assert.mjs','before?.[k] === undefined || after?.[k] === undefined || before[k] === null || after[k] === null || ',' '),
 ('release-recipient','assert.mjs','m[3] !== recipientEndpoint || ',' '),
 ('refusal-recipient','assert.mjs','m[3] === recipientEndpoint && ',' '),
 ('committee-binding','prepare.mjs',"if (chain.committee?.committeeId !== committeeId)","if (false)"),
 ('old-committee-guard','prepare.mjs',"if (committeeId === OLD_COMMITTEE_4774 && step.id !== 'X.old.create')","if (false)"),
]
for label,file,before,after in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-evidence-mutant-') as t:
  d=Path(t)
  for folder in ('driver','test'):
   (d/folder).mkdir()
   for p in (root/folder).glob('*.mjs'): shutil.copy2(p,d/folder/p.name)
  shutil.copy2(root/'pins.base.json',d/'pins.base.json')
  p=d/'driver'/file;s=p.read_text();assert s.count(before)==1,(label,s.count(before));p.write_text(s.replace(before,after))
  result=subprocess.run(['node','--test','--test-concurrency=1','--test-timeout=60000','test/proof.test.mjs','test/assert.test.mjs','test/prepare.test.mjs','test/core.test.mjs','test/genesis.test.mjs'],cwd=d,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
  # Distinguish real assertion failures from syntax/import errors or startup failure.
  failures=re.findall(r'# fail (\d+)',result.stdout)
  assert result.returncode!=0 and failures and int(failures[-1])>0 and 'ERR_MODULE_NOT_FOUND' not in result.stdout and 'SyntaxError' not in result.stdout, f'{label}: survived or not an assertion failure\n{result.stdout[-2000:]}'
  print(label+': killed',flush=True)
print(f'{len(mutants)}/{len(mutants)} mutants killed; no production access')
