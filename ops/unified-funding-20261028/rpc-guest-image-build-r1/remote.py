from pathlib import Path
import hashlib,time,sys,json,os
assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
assert 0<=time.time()-1793439615.6557317<=300
p=Path('/home/controladmin/rpc-guest-image-20261031-r1')
assert hashlib.sha256((p/'inject_image.py').read_bytes()).hexdigest()=='ef130ca34e4e6df3efd445a39f7e08c740d5dcb0fd1b15620078908bdf595378'
sys.argv=['inject_image.py','--config',str(p/'config.json')]
exec(compile((p/'inject_image.py').read_bytes(),str(p/'inject_image.py'),'exec'))
