# READ/FREEZE/AUDIT ONLY, after root supplies actual admission record and unit is terminal.
from pathlib import Path
from datetime import datetime
import hashlib,json,shutil,subprocess
p=Path(__file__).resolve().parent
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
a=json.loads((p/'admission-record.json').read_text())
status=subprocess.check_output(['systemctl','--user','show',a['unit'],'-p','ActiveState','-p','SubState','-p','MainPID','-p','InvocationID','-p','ExecMainStatus'],text=True)
assert 'MainPID=0' in status and ('ActiveState=inactive' in status or 'ActiveState=failed' in status),status
assert all(not Path('/proc/'+str(a[k])).exists() for k in ['mainPid','runnerPid','claudePid']),'known process exists'
reviewedExe=Path(json.loads((p/'PREPARED.json').read_text())['claudeExecutable']['path'])
unknown=[]
for x in Path('/proc').iterdir():
 if not x.name.isdigit():continue
 try:exe=(x/'exe').resolve(strict=True)
 except OSError:continue
 if exe!=reviewedExe:continue
 try:cwd=(x/'cwd').resolve(strict=True)
 except OSError:unknown.append(x.name);continue
 assert cwd!=p and not cwd.is_relative_to(p),'same reviewed author executable remains in preparation tree'
assert not unknown,'reviewed executable with unreadable cwd needs manual terminal audit: '+str(unknown)
pins=json.loads((p/'input-pins.json').read_text());drift=[n for n,h in pins.items() if not Path(n).is_file() or sha(Path(n))!=h]
start=json.loads((p/'started.json').read_text())['startedAt'];logdir=Path('/home/steven/.claude/projects')/str(p).replace('/','-')
try:result=json.loads((p/'claude.out').read_text())
except (ValueError,FileNotFoundError):
 logs=list(logdir.glob('*.jsonl'));assert len(logs)==1,'session needs explicit audit';result={'is_error':True,'session_id':logs[0].stem,'outputParseFailed':True}
session=result['session_id'];source=logdir/(session+'.jsonl');calls=[];results={};counts={};outside=[];assistantIds=set();userRows=0
for line in source.read_text().splitlines():
 try:d=json.loads(line);ts=datetime.fromisoformat(d.get('timestamp','').replace('Z','+00:00')).timestamp()
 except (ValueError,TypeError):continue
 if ts<start:continue
 if d.get('type')=='assistant':assistantIds.add(d.get('message',{}).get('id'))
 if d.get('type')=='user':userRows+=1
 blocks=d.get('message',{}).get('content',[])
 if not isinstance(blocks,list):continue
 for b in blocks:
  if not isinstance(b,dict):continue
  if b.get('type')=='tool_result':results[b.get('tool_use_id')]=b
  if b.get('type')!='tool_use':continue
  n=b.get('name');counts[n]=counts.get(n,0)+1
  if n not in ('Write','Edit'):continue
  arg=b.get('input',{});f=Path(arg.get('file_path','')).resolve();rel=None
  try:rel=str(f.relative_to(p/'candidate'))
  except ValueError:outside.append({'tool':n,'path':str(f),'toolUseId':b.get('id')})
  calls.append({'tool':n,'path':str(f),'rel':rel,'id':b.get('id'),'input':arg})
seed=json.loads((p/'seed-pins.json').read_text());seedroot=Path(json.loads((p/'seed-provenance.json').read_text())['frozenRoot'])
replay={};first={};events=[];issues=[]
for c in calls:
 r=results.get(c['id']);outcome='missing-result' if r is None else ('tool-error' if r.get('is_error') is True else 'reported-success')
 event={k:c[k] for k in ['tool','path','rel','id']};event['outcome']=outcome;events.append(event)
 if outcome!='reported-success' or c['rel'] is None:
  if outcome=='missing-result':issues.append({'id':c['id'],'reason':'missing tool result; mutation outcome unknown'})
  continue
 rel=c['rel'];arg=c['input']
 if rel not in replay:
  replay[rel]=(seedroot/rel).read_text() if rel in seed else None
 try:
  if c['tool']=='Write':
   body=arg.get('content');assert isinstance(body,str),'Write content not text'
  else:
   body=replay[rel];old=arg.get('old_string');new=arg.get('new_string')
   assert isinstance(body,str) and isinstance(old,str) and old and isinstance(new,str),'Edit source/strings unavailable'
   count=body.count(old);assert count>0 and (arg.get('replace_all') is True or count==1),'Edit occurrence count does not match replay'
   body=body.replace(old,new) if arg.get('replace_all') is True else body.replace(old,new,1)
  replay[rel]=body;first.setdefault(rel,body)
 except (AssertionError,UnicodeError) as e:issues.append({'id':c['id'],'file':rel,'reason':str(e)})
def manifest(root):
 out={}
 for f in sorted(root.rglob('*')):
  assert not f.is_symlink(),'unexpected source symlink: '+str(f)
  if f.is_file():out[str(f.relative_to(root))]=sha(f)
 return out
before=manifest(p/'candidate');assert not (p/'author-delivery').exists(),'already frozen'
for rel,body in replay.items():
 if body is None or hashlib.sha256(body.encode()).hexdigest()!=before.get(rel):issues.append({'file':rel,'reason':'mutation replay differs from final bytes; manual audit required'})
changes={rel:{'seedSha256':seed.get(rel),'finalSha256':h,'kind':'modified' if rel in seed else 'new'} for rel,h in before.items() if seed.get(rel)!=h};removed=[r for r in seed if r not in before]
for rel in changes:
 if rel not in replay:issues.append({'file':rel,'reason':'changed file not explained by successful Write/Edit'})
for rel in removed:issues.append({'file':rel,'reason':'removed file needs explicit audit'})
shutil.copytree(p/'candidate',p/'author-delivery');assert before==manifest(p/'author-delivery')==manifest(p/'candidate')
(p/'author-delivery-manifest.json').write_text(json.dumps(before,indent=2)+'\n');(p/'author-first-mutation').mkdir()
for rel,body in first.items():
 f=p/'author-first-mutation'/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(body)
(p/'author-first-mutation-manifest.json').write_text(json.dumps(manifest(p/'author-first-mutation'),indent=2)+'\n')
(p/'mutation-audit.json').write_text(json.dumps({'events':events,'replayIssues':issues,'outsideCandidateAttempts':outside,'note':'first successful mutation snapshots reconstructed from immutable seed and successful tool results; any mismatch requires manual audit, never assumed clean'},indent=2)+'\n')
(p/'source-changes.json').write_text(json.dumps({'changes':changes,'removed':removed},indent=2)+'\n');(p/'unit-result.txt').write_text(status)
report={'admission':a,'unit':status,'finished':json.loads((p/'finished.json').read_text()) if (p/'finished.json').exists() else {'runnerFinalizationMissing':True},'currentInputDrift':drift,'session':session,'duration_ms':result.get('duration_ms'),'num_turns':result.get('num_turns'),'configuredMaxAgenticTurns':40,'distinctAssistantMessageIds':len(assistantIds),'transcriptUserRows':userRows,'turnMetricNote':'Raw success-result num_turns is a different user-message counter from max-agentic/API-turn limit; retain without conflating. See pinned turn-metric-investigation.json.','is_error':result.get('is_error'),'outputParseFailed':result.get('outputParseFailed',False),'files':len(before),'changedFiles':len(changes),'removedFiles':removed,'manifestSha256':sha(p/'author-delivery-manifest.json'),'firstMutations':len(first),'firstMutationManifestSha256':sha(p/'author-first-mutation-manifest.json'),'currentInvocationTools':counts,'unexpectedTools':[n for n in counts if n not in ('Read','Grep','Write','Edit')],'outsideCandidateMutationAttempts':outside,'mutationReplayIssues':issues,'mutationAuditSha256':sha(p/'mutation-audit.json'),'innerGuard':(p/'inner.guard.log').read_text() if (p/'inner.guard.log').exists() else None,'outerGuard':(p/'outer.guard.log').read_text() if (p/'outer.guard.log').exists() else None}
(p/'terminal-summary.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
