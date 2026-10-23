"""Read-only aggregate observation of one existing restore handle; never starts a unit."""
import datetime, importlib.util, json, pathlib, sys

base = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('whole_restore', base / 'whole_restore.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
attempt = pathlib.Path(sys.argv[1]).resolve()
handle = json.loads((attempt / 'handle.json').read_text())
assert handle['target'] == 'vm'
remote = handle['remote']
code = '''import hashlib,json,pathlib,subprocess
p=pathlib.Path(REMOTE)
probes=json.loads((p/'probes.json').read_text())
plan=json.loads((p/'plan.json').read_text())
unit=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',UNIT,'-p','ActiveState','-p','MemoryCurrent','-p','MemoryPeak','-p','MemoryMax','-p','MainPID','-p','Result','-p','ControlGroup'],text=True).splitlines() if '=' in line)
cg=pathlib.Path('/sys/fs/cgroup'+unit.pop('ControlGroup'))
stats=dict(line.split() for line in (cg/'memory.stat').read_text().splitlines())
memory={key:int(stats[key]) for key in ('anon','file','sock','kernel') if key in stats}
processes=[]
for pid in (cg/'cgroup.procs').read_text().splitlines():
 try:
  fields=dict(line.split(':',1) for line in (pathlib.Path('/proc')/pid/'status').read_text().splitlines() if ':' in line)
  processes.append({key:fields[key].strip() for key in ('Name','RssAnon','VmRSS','Threads') if key in fields})
 except FileNotFoundError: pass
objects=p/'restored'/'objects'
files=list(objects.glob('*.bin'))
partial=list(objects.glob('*.part'))
out={'unit':unit,'memoryBreakdownBytes':memory,'processes':processes,'sourceRunnerSha256':hashlib.sha256((p/'runner.py').read_bytes()).hexdigest(),'isolation':{'blocked':sum(x['blocked'] for x in probes['blocked']),'blockedTried':len(probes['blocked']),'namesResolved':sum(x['resolved'] for x in probes['names']),'namesTried':len(probes['names']),'allowedReached':probes['allowedReached'],'allowedTried':probes['allowedTried'],'isolated':probes['isolated']},'bridgeOverrides':plan.get('bridge',{}),'progress':{'completedFiles':len(files),'completedBytes':sum(x.stat().st_size for x in files),'partialFiles':len(partial)},'finalResultPresent':(p/'result.json').exists()}
print(json.dumps(out))
'''.replace('REMOTE', repr(remote)).replace('UNIT', repr(handle['unit']))
rc, raw = harness.ssh(handle['ssh'], 'sudo -n python3 -', stdin=code.encode(), timeout=45)
if rc:
    print('Observation failed; no new receipt written')
    raise SystemExit(2)
result = json.loads(raw)
result['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
result['sourceCommit'] = 'f98786e90e83c66da6f593315faea83e717caeed'
result['status'] = 'RUNNING_NOT_COMPLETE' if not result['finalResultPresent'] else 'FINAL_RESULT_REQUIRES_REVIEW'
result['limitation'] = 'An isolated read-only recovery on the same physical machine as indexd; not physical-host-loss proof. No final inventory verified yet. Prior failed-attempt data retained.'
out = pathlib.Path('outputs/decentralization-audit/storage-whole-recovery-bounded-live-20261023.json')
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
