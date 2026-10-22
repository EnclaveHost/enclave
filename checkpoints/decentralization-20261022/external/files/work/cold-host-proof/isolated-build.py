import json,os,pathlib,subprocess,tempfile,sys,datetime
root=pathlib.Path(__file__).resolve().parent
repo=root.parent/'enclave'
hidden=['/boot','/lib/modules',str(root.parent/'direct-bootstrap-hardware-release-v3'),str(root.parent/'bootstrap-hardware/guests/store')]
if '--inner' in sys.argv:
 with tempfile.TemporaryDirectory(prefix='cold-host-hidden-') as empty:
  subprocess.run(['mount','--make-rprivate','/'],check=True)
  for target in hidden:
   if not os.path.isdir(target):raise RuntimeError('missing expected hidden directory: '+target)
   subprocess.run(['mount','--bind',empty,target],check=True)
  env=dict(os.environ,DOMAIN_RELEASE_DIR=str(root/'release'),DOMAIN_RELEASE_ID='5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad',OVMF_OVERRIDE='',KERNEL_HASHES='on',APP_IMAGE_TEMPLATE='/deliberately-missing/legacy-template',SHIELDED_IMAGE_TEMPLATE='',BUNDLETOOL='')
  result=subprocess.run(['sh',str(repo/'isolation/m4/build-app-guest.sh'),str(root/'app.bundle'),str(root/'guest.cpio.gz'),'1'],env=env,text=True,capture_output=True,timeout=180)
  (root/'build.log').write_text(result.stdout+result.stderr)
  assert result.returncode==0, result.stderr
  expected='caf11b488b5235182d5b4628f0d663d454585d84a790bb9b303cedb2ea99690496951529ca395ff032d5a729b30a733a'
  assert 'predicted measurement: '+expected in result.stdout,result.stdout
  routes=pathlib.Path('/proc/net/route').read_text().strip().splitlines()
  proof={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'measurement':expected,'networkNamespace':True,'defaultRoutes':routes[1:],'hiddenDirectories':hidden,'legacyTemplate':'/deliberately-missing/legacy-template','source':'downloaded-pinned-release-and-bundle','actualGuestBoot':False}
  (root/'isolated-build.json').write_text(json.dumps(proof,indent=2)+'\n')
  print(json.dumps(proof))
else:
 subprocess.run(['unshare','--user','--map-root-user','--net','--mount',sys.executable,__file__,'--inner'],check=True,timeout=200)
