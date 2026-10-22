import json,pathlib,subprocess
out=pathlib.Path('work/resume-after-checkpoint-20261022/production-run')
script='''import pathlib,hashlib,stat,json
p=pathlib.Path('/root/indexd-migration/20991231T000000Z-0badc0de')
expected={'replicactl.py':'1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83','live-primary.profile.json':'abcd361224f0ed55e693084e557da5df23bc27ebe6bd127e212daa733de7af3a','fence.indexd':'c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568','c2.indexd':'2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7'}
assert not p.is_symlink() and stat.S_ISDIR(p.lstat().st_mode) and p.stat().st_uid==0
assert set(x.name for x in p.iterdir())==set(expected)
ids={}
for n,h in expected.items():
 f=p/n;st=f.lstat();assert stat.S_ISREG(st.st_mode) and st.st_uid==0
 assert hashlib.sha256(f.read_bytes()).hexdigest()==h
 ids[n]=(st.st_dev,st.st_ino)
for n in expected:
 f=p/n;st=f.lstat();assert (st.st_dev,st.st_ino)==ids[n];f.unlink()
p.rmdir()
print(json.dumps({'removedOnlyVerifiedDuplicateStaging':True,'directory':str(p),'files':list(expected)}))
'''
ssh=['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
r=subprocess.run(ssh+['sudo python3 -'],input=script,capture_output=True,text=True,timeout=60)
(out/'worker-staging-remove.out').write_text(r.stdout+r.stderr);print(r.stdout);raise SystemExit(r.returncode)
