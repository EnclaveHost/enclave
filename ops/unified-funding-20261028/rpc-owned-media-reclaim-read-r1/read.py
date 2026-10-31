import pathlib,json,subprocess,os
results={}
for name,argv in [('mount',['findmnt','-J','-o','TARGET,SOURCE,FSTYPE,OPTIONS','/']),('discard',['lsblk','-D','-J','-o','NAME,TYPE,FSTYPE,MOUNTPOINTS,DISC-GRAN,DISC-MAX,DISC-ZERO']),('trimVersion',['fstrim','--version'])]:
 r=subprocess.run(argv,capture_output=True,text=True,timeout=5)
 if len(r.stdout)>65536 or len(r.stderr)>4096:raise RuntimeError('Output bound')
 results[name]={'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
print(json.dumps({'invocation':os.environ.get('INVOCATION_ID'),'readOnly':True,'results':results}))
