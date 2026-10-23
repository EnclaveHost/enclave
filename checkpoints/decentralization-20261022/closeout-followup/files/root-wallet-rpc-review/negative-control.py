import subprocess,pathlib
p=pathlib.Path(__file__).resolve().parent
r=subprocess.run(['node','--experimental-vm-modules','--test',str(p/'negative/test/walletconnect-independent-rpc.test.mjs')],capture_output=True,text=True)
(p/'negative.out').write_text(r.stdout+r.stderr)
assert r.returncode==1,(r.returncode,r.stdout,r.stderr)
assert '# pass 1' in r.stdout and '# fail 5' in r.stdout,r.stdout
print('Old source negative control: five of six tests fail; hosted-mode compatibility test passes. Expected exit1 confirmed.')
