# Writes INVENTORY.json + release-d05104403.sha256 from local staged files only (no main writes, no secrets).
import hashlib,json,os,subprocess,sys
L=os.path.dirname(os.path.abspath(__file__)); S=L+'/stage2'; R=S+'/metal-d05104403'; O=S+'/dist-leasegas-d05104403'
h=lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
rows=[]
for d,_,fs in os.walk(R):
    for f in fs:
        p=os.path.join(d,f); rel=os.path.relpath(p,R)
        rows.append((rel, 'symlink->'+os.readlink(p) if os.path.islink(p) else h(p)))
rows.sort(); open(L+'/release-d05104403.sha256','w').write(''.join(f'{v}  {k}\n' for k,v in rows))
img={f: {'sha256':h(O+'/'+f),'bytes':os.path.getsize(O+'/'+f)} for f in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json','MEASUREMENT']}
m=json.load(open(O+'/manifest.json'))
delta=json.load(open(L+'/image-delta-v2-vs-kept.json'))
inv={'status':'STAGED_NOT_ADMITTED_NOT_ACTIVATED','productionChanged':False,
 'release':{'dir':R,'commitB':'d0510440398e5f50720bb28accb4d1d8088175df','commitA':'77a3653a11db55efd2af107f181ab97bf894a184',
   'mainHead':'e762a9c5f523cf7fcb6d68118ca459290926f8fa','files':len(rows),'listSha256':h(L+'/release-d05104403.sha256'),
   'commitAIs':'exact capture of main working tree (main tree hash identical before/after/final)','commitBAdds':['metal/overlay-control-image.py','test/metal-control-overlay.test.py']},
 'image':{'dir':O,'measurement':open(O+'/MEASUREMENT').read().strip(),'files':img,'base':'/home/steven/enclave-prod/dist-sdshield-2857356cd (b8376e15)',
   'overlayBuilderSha256':m['controlOverlay']['builderSha256'],'overlaidFiles':len(m['controlOverlay']['files']),
   'deltaVsKept':{'kept':'ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2','changed':delta['changed'],'added':delta['added'],'removed':delta['removed'],'entries':delta['entries']}},
 'overlayFix':{'base':{'metal/overlay-control-image.py':h(L+'/overlay-fix/base/overlay-control-image.py'),'test/metal-control-overlay.test.py':h(L+'/overlay-fix/base/metal-control-overlay.test.py')},
   'new':{'metal/overlay-control-image.py':h(L+'/overlay-fix/new/metal/overlay-control-image.py'),'test/metal-control-overlay.test.py':h(L+'/overlay-fix/new/test/metal-control-overlay.test.py')},
   'diffs':{f:h(L+'/overlay-fix/'+f) for f in ['overlay-symlink.metal.diff','overlay-symlink.test.diff']},'appliedToMain':False},
 'generatedInMain':dict(l.split()[::-1] for l in open(L+'/generated-after.sha256') if l.strip()),
 'ownerConfig':{'file':L+'/metal0-owner-nomination.json','sha256':h(L+'/metal0-owner-nomination.json')},
 'logs':sorted(f for f in os.listdir(L+'/logs') if not f.endswith('.guard.log'))}
json.dump(inv,open(L+'/INVENTORY.json','w'),indent=1); print('INVENTORY-WRITTEN',len(rows),'release files',inv['image']['measurement'][:16])
