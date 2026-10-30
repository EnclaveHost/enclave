# Opt-in integration fixture: creates short-lived user systemd services and
# reserves at most 1 GiB of scratch. Does not launch QEMU or use a GPU.
import sys
if __name__ != '__main__' or sys.argv[1:] != ['--run']:
    raise SystemExit('Run explicitly with --run; requires a user systemd manager and >2 GiB free.')
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

source = Path(__file__).resolve().parent
results = []
with tempfile.TemporaryDirectory(prefix='launcher-') as tmp:
    root = Path(tmp).resolve()
    m2, m1 = root/'m2', root/'m1'
    m2.mkdir(); m1.mkdir()
    (m1/'domain.env').write_text('OVMF=/unused\nKERNEL=/unused\nAPPEND=test\n')
    shutil.copyfile(source/'pad-bank.py', m2/'pad-bank.py')
    fake = root/'fake-qemu'
    fake.write_text('''#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path
a=sys.argv[1:]
for item in a:
 if 'id=padbank,' in item:
  p=Path(item.split(',')[0].removeprefix('file='))
  assert p.stat().st_size==1024**3 and p.stat().st_blocks*512>=1024**3
serial=next(x.removeprefix('file:') for x in a if x.startswith('file:'))
Path(serial).write_text(json.dumps(a))
time.sleep(60)
''')
    fake.chmod(0o700)
    launcher = (source/'run-domain.sh').read_text()
    assert launcher.count('set -- qemu-system-x86_64 ') == 1
    launcher = launcher.replace('set -- qemu-system-x86_64 ', 'set -- "'+str(fake)+'" ')
    (m2/'run-domain.sh').write_text(launcher)
    (m2/'pin-shield-cpus.py').write_text('import sys\n# No QMP: fixture substitutes QEMU with a sleeping process.\n')
    rings = root/'rings'; rings.mkdir()
    for card in (0,1):
        with (rings/f'card-{card}').open('wb') as f:
            f.truncate(67108864)
    model = root/'model'; model.touch()
    img = root/'guest.cpio.gz'; img.touch()
    bank = root/'pads'
    env = dict(os.environ, SHIELDED_PAD_BANK_DIR=str(bank), SHIELDED_PAD_BANK_GIB='1',
               SHIELDED_PAD_BANK_GIB_SD='1', SHIELDED_PAD_BANK_MAX_GIB='1',
               SHIELDED_PAD_BANK_RESERVE_GIB='1', SHIELDED_SHM_DIR=str(rings),
               SHIELDED_MODEL_FILE=str(model))
    for i, kind in enumerate(('qwen3.8-27b-mtp-q4-vl-gguf','z-image-turbo-q4km-sd',None)):
        tag = f'padlaunch{os.getpid()}x{i}'
        if kind:
            Path(str(img)+'.shield').write_text(kind)
        else:
            Path(str(img)+'.shield').unlink()
        host = root/(tag+'.host')
        try:
            p = subprocess.run(['sh',str(m2/'run-domain.sh'),'start',str(img),'plain',tag,str(root)],
                               env=env,text=True,capture_output=True,timeout=30)
            host.write_text(p.stdout)
            assert p.returncode == 0, p.stderr
            deadline = time.monotonic()+5
            while not (root/(tag+'.serial')).exists():
                assert time.monotonic()<deadline, 'fake QEMU did not start'
                time.sleep(.05)
            args = json.loads((root/(tag+'.serial')).read_text())
            assert any('id=padbank,' in a for a in args) == bool(kind)
        finally:
            subprocess.run(['sh',str(m2/'run-domain.sh'),'stop',tag,str(root)],env=env,
                           check=True,text=True,capture_output=True,timeout=30)
        assert not list(bank.glob('*.padbank*'))
        results.append(dict(model=kind or 'cpu-only', full_launcher_start_stop=True))
print(json.dumps(results,indent=2))
