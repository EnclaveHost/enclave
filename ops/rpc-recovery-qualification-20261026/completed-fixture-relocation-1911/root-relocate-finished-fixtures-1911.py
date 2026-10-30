import os, pathlib, shutil, subprocess, json, time
P=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
D=pathlib.Path('/vm/enclave-volumes/rpc-completed-fixtures-20261027-1911')
names=['root-windows-proof-20261026T045553Z','root-windows-proof-r2-20261026T050834Z']
G=1024**3
assert pathlib.Path('/vm').is_mount()
assert os.stat('/vm').st_dev != os.stat('/').st_dev
assert shutil.disk_usage('/vm').free > 64*G+40*G+2*G
assert not D.exists()
for name in names:
    base=P/'logs'/name
    assert json.loads((base/'result.json').read_text())['rc']==1
    assert (base/'repo').is_dir() and not (base/'repo').is_symlink()
D.mkdir(mode=0o700)
record={'startedEpoch':time.time(),'rootFreeBefore':shutil.disk_usage('/').free,'relocations':[]}
for name in names:
    src=P/'logs'/name/'repo'; dst=D/name/'repo'; dst.parent.mkdir()
    subprocess.run(['rsync','-aH','--',str(src)+'/',str(dst)+'/'],check=True)
    # Verify every file's bytes and copied attributes, including extra paths.
    check=subprocess.run(['rsync','-aHnci','--delete','--',str(src)+'/',str(dst)+'/'],check=True,capture_output=True,text=True)
    assert not check.stdout, check.stdout
    subprocess.run(['sync','-f',str(dst)],check=True)
    quarantine=src.with_name('repo.verified-relocation-1911')
    assert not quarantine.exists()
    src.rename(quarantine)
    try:
        src.symlink_to(dst,target_is_directory=True)
    except BaseException:
        quarantine.rename(src)
        raise
    # Only this completed test copy is removed; verified NVMe copy remains accessible at original path.
    assert src.resolve()==dst and dst.is_dir()
    shutil.rmtree(quarantine)
    record['relocations'].append({'original':str(src),'destination':str(dst),'verification':'rsync -aHnci --delete: no differences','originalPath':'symlink to verified preserved copy'})
    (P/'logs/fixture-relocation-1911.json').write_text(json.dumps(record,indent=2)+'\n')
record.update(completedEpoch=time.time(),rootFreeAfter=shutil.disk_usage('/').free,vmFreeAfter=shutil.disk_usage('/vm').free)
(P/'logs/fixture-relocation-1911.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
