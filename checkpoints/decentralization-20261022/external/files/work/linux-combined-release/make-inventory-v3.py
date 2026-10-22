# Writes INVENTORY-final.json (stage3) + release-e68067d24.sha256 from local staged files only (no main writes, no secrets).
import hashlib,json,os,subprocess,sys
L=os.path.dirname(os.path.abspath(__file__)); S=L+'/stage3'; R=S+'/metal-e68067d24'; O=S+'/dist-leasegas-e68067d24'
h=lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
rows=[]
for d,_,fs in os.walk(R):
    for f in fs:
        p=os.path.join(d,f); rel=os.path.relpath(p,R)
        rows.append((rel, 'symlink->'+os.readlink(p) if os.path.islink(p) else h(p)))
rows.sort(); open(L+'/release-e68067d24.sha256','w').write(''.join(f'{v}  {k}\n' for k,v in rows))
img={f: {'sha256':h(O+'/'+f),'bytes':os.path.getsize(O+'/'+f)} for f in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json','MEASUREMENT']}
m=json.load(open(O+'/manifest.json'))
delta=json.load(open(L+'/image-delta-v3-vs-kept.json'))
inv={'status':'STAGED_NOT_ADMITTED_NOT_ACTIVATED','productionChanged':False,
 'release':{'dir':R,'commit':'e68067d2480adbf3fb381f0ac4bf69fc4191d858','mainHead':'e762a9c5f523cf7fcb6d68118ca459290926f8fa','files':len(rows),
   'listSha256':h(L+'/release-e68067d24.sha256'),'commitIs':'exact capture of main working tree (root-integrated overlay fix + regenerated policy bundles); main tree hash identical before/after capture',
   'mainPathsChangedSinceStage2Capture':[l.strip() for l in open(L+'/main-delta-v2-to-v3.txt') if l.strip()]},
 'image':{'dir':O,'measurement':open(O+'/MEASUREMENT').read().strip(),'files':img,'base':'/home/steven/enclave-prod/dist-sdshield-2857356cd (b8376e15)',
   'overlayBuilderSha256':m['controlOverlay']['builderSha256'],'overlaidFiles':len(m['controlOverlay']['files']),
   'deltaVsKept':{'kept':'ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2','changed':delta['changed'],'added':delta['added'],'removed':delta['removed'],'entries':delta['entries']}},
 'overlayFix':{'rootIntegration':'work/linux-combined-release/root-overlay-integration/inventory.json','metal/overlay-control-image.py':'7a120502034f2c7f70930355dab1357ac9e4816188993a5601a69abd36a7159c','test/metal-control-overlay.test.py':'3eefe9411fcb90b26a2687d4820f403f0bb8aaaece5683ad8a61efbfa2030b9d'},
 'policyBundles':{'cause':'ONLY network/platform-host-policy-config.mjs 402c73b8 -> 6422d065 (PRODUCTION_MIRRORS [] -> 4 routes); proven by in-memory rebuild with the prior file reproducing both stored bundles byte-exactly',
   'before':{'windows/node/host-admission.bundle.mjs':'7ce23a55c9ffccf1c30c818ef3d7a6774cf3c8743fcac62a1421d11456794fc6','metal/guest/host-policy.bundle.mjs':'be01edb3838ca87503752bd08a4b7c72c1905c2c1822430113433cd6ce713654'},
   'after':{'windows/node/host-admission.bundle.mjs':'e83515fca7468d5d6636631617d73d9ed9ef12b798439e7aaed347f2f524182c','metal/guest/host-policy.bundle.mjs':'8b2dfbc6b5466d3c4f4559c15d874824f1ddddd3e530667a3848b3141b477af9'},
   'afterEqualsKeptProductionRelease':True,'manifests':'none exist; scripts/build-host-admission.mjs writes none (--check compares bytes)'},
 'imageDeltaVsStage2':json.load(open(L+'/image-delta-v3-vs-stage2.json')),
 'generatedInMain':dict(l.split()[::-1] for l in open(L+'/generated-after.sha256') if l.strip()),
 'ownerConfig':{'file':L+'/metal0-owner-nomination.json','sha256':h(L+'/metal0-owner-nomination.json')},
 'logs':sorted(f for f in os.listdir(L+'/logs') if not f.endswith('.guard.log'))}
json.dump(inv,open(L+'/INVENTORY-final.json','w'),indent=1); print('INVENTORY-WRITTEN',len(rows),'release files',inv['image']['measurement'][:16])
