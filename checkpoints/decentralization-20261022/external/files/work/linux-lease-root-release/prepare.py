from pathlib import Path
import os, subprocess, shutil, hashlib, json

base = Path(__file__).resolve().parent
main = base.parent / 'enclave'
tree = base / 'tree'
assert not tree.exists(), 'Frozen candidate exists; inspect it rather than replacing it.'
tree.mkdir()
files = sorted(set(subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=main).decode().strip('\0').split('\0')))
rows = []
for rel in files:
    src, dst = main / rel, tree / rel
    if not src.exists() and not src.is_symlink():
        continue
    assert 'node_modules' not in Path(rel).parts
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        link = os.readlink(src)
        dst.symlink_to(link)
        rows.append({'path': rel, 'symlink': link})
    elif src.is_file():
        shutil.copy2(src, dst)
        rows.append({'path': rel, 'sha256': hashlib.file_digest(dst.open('rb'), 'sha256').hexdigest()})
    else:
        raise RuntimeError('Unexpected source type: '+rel)
(base / 'source-snapshot.json').write_text(json.dumps({'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=main,text=True).strip(), 'files': rows},indent=2)+'\n')
(tree / 'node_modules').symlink_to((main / 'node_modules').resolve(), target_is_directory=True)
stage = base / 'stage'
stage.mkdir()
for name in ['extract.py','import-check.mjs','launcher-check.mjs']:
    shutil.copy2(base.parent / 'linux-lease-activation/stage' / name, stage / name)
script = (base.parent / 'linux-lease-activation/job-stage.sh').read_text().replace('L=$W/linux-lease-activation;', 'L=$W/linux-lease-root-release;')
# The new root-owned release is immutable after its first build: remove automatic deletion of prior evidence.
script = script.replace('rm -rf $S/scratch.git $S/extract $S/dist-leasegas-*', '[ ! -e "$S/scratch.git" ] || { echo "staging already attempted; inspect before retry"; exit 2; }')
(base / 'job-stage.sh').write_text(script)
release = (base.parent / 'linux-lease-activation/job-release.sh').read_text().replace('/work/linux-lease-activation;', '/work/linux-lease-root-release;')
(base / 'job-release.sh').write_text(release)
print('Frozen',len(rows),'main source files; prepared root-owned release scripts.')
