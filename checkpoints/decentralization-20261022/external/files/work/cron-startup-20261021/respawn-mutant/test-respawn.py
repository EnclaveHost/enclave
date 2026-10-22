#!/usr/bin/env python3
"""Fixture tests of cron-respawn.ps1 on minipc's own PowerShell 5.1, against SYNTHETIC node-config files in a staging
directory (C:\\ProgramData\\Enclave\\hotfix\\cron-respawn-20261021\\fixtures\\<case>). The live node-config files are never
read or written here; node-restart.ps1 is only parsed and run in its read-only -Mode identify.
Cases: create/idempotence, append to another id keeping every other byte + ACL + rollback, delay conflicts (other id,
global), matching delay kept, CAS (apply and rollback), duplicate key, updater-file setting, malformed value, missing
final newline, case-insensitive keys, already-present noop, rollback of a created file."""
import base64, hashlib, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns); ps = ns['ps']
STAGE = r"C:\ProgramData\Enclave\hotfix\cron-respawn-20261021"; FIX = STAGE + r"\fixtures"
CRON = '0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c'
OTHER = '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
CFG = b"@echo off\r\nrem synthetic fixture\r\nset APPS=1\r\nset NODE_NAME=fixture\r\nif exist \"x\\node-config.local.cmd\" call \"x\\node-config.local.cmd\"\r\n"
HDR = b"@echo off\r\nrem This box's own node settings, read after node-config.cmd. Updates never write this file.\r\n"
sha = lambda b: hashlib.sha256(b).hexdigest()
R, fails = {}, []
def check(label, cond, detail=None):
    R[label] = bool(cond)
    if not cond: fails.append(label); print('FAIL', label, json.dumps(detail)[:600] if detail is not None else '')

# upload both scripts to the staging dir (SFTP), verify their hashes there; parse node-restart.ps1
up = ps(f"$null=New-Item -ItemType Directory -Force -Path '{FIX}';Remove-Item -Recurse -Force -LiteralPath '{FIX}' -ErrorAction SilentlyContinue;"
        f"$null=New-Item -ItemType Directory -Force -Path '{FIX}';'{{\"ok\":true}}'", 60)
for f in ('cron-respawn.ps1', 'node-restart.ps1'):
    r = subprocess.run(['timeout', '120', 'scp', '-q', os.path.join(HERE, f), 'minipc:/' + STAGE.replace('\\', '/') + '/' + f], capture_output=True, text=True)
    check(f'upload {f}', r.returncode == 0, r.stderr[-200:])
want = {f: sha(open(os.path.join(HERE, f), 'rb').read()) for f in ('cron-respawn.ps1', 'node-restart.ps1')}
got = ps("$o=[ordered]@{};foreach($f in @('cron-respawn.ps1','node-restart.ps1')){$p=Join-Path '%s' $f;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e);"
         "$o[$f]=[ordered]@{sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower();parseErrors=@($e).Count}};$o|ConvertTo-Json -Compress" % STAGE, 60)
for f in want:
    check(f'{f} on minipc = local bytes', got.get(f, {}).get('sha') == want[f], got)
    check(f'{f} parses (0 errors)', got.get(f, {}).get('parseErrors') == 0, got)

def fixture(case, local=None, cfg=CFG):
    d = FIX + '\\' + case
    s = f"$null=New-Item -ItemType Directory -Force -Path '{d}';[IO.File]::WriteAllBytes('{d}\\node-config.cmd',[Convert]::FromBase64String('{base64.b64encode(cfg).decode()}'));"
    if local is not None: s += f"[IO.File]::WriteAllBytes('{d}\\node-config.local.cmd',[Convert]::FromBase64String('{base64.b64encode(local).decode()}'));"
    ps(s + "'{\"ok\":true}'", 60); return d
def run(d, mode, **kw):
    args = ' '.join(f"-{k} '{v}'" for k, v in kw.items())
    return ps(f"Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;& '{STAGE}\\cron-respawn.ps1' -Mode {mode} -Dir '{d}' {args}", 90)
def files(d):
    return ps(f"$o=[ordered]@{{}};foreach($f in @(Get-ChildItem -LiteralPath '{d}' -Force -File)){{$o[$f.Name]=(Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLower()}};"
              f"$o.acl=$(if(Test-Path -LiteralPath '{d}\\node-config.local.cmd'){{(Get-Acl -LiteralPath '{d}\\node-config.local.cmd').Sddl}}else{{''}});$o|ConvertTo-Json -Compress", 60)
def nonrespawn(b):     # the bytes the script must keep: every line that is not a respawn setting
    import re
    return b''.join(l for l in re.split(rb'(?<=\n)', b) if l and not re.match(rb'(?i)^\s*set\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=', l))
csha = sha(CFG)

# C1 absent -> create; idempotent
d = fixture('c1')
r = run(d, 'inspect', Id=CRON); check('C1 absent: inspect would apply', r.get('decision') == 'would apply', r)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal='absent')
want_c1 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={CRON}\r\n".encode()
check('C1 absent: created with exactly header + one ids line', r.get('decision') == 'applied' and r.get('after') == sha(want_c1) and r.get('backup') == 'none', r)
after1 = r.get('after')
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=after1); check('C1 apply again: noop (idempotent)', r.get('decision') == 'noop: already configured', r)
check('C1 no stray temp files', sorted(files(d).keys()) == ['acl', 'node-config.cmd', 'node-config.local.cmd'], files(d))
r = run(d, 'rollback', ExpectLocal=after1, ExpectBackup='none')
check('C1 rollback of a created file: set aside, local absent', r.get('decision', '').startswith('rolled back') and r.get('after') == 'absent', r)

# C2 other id + other settings, delay keep -> append; bytes/ACL; rollback restores exact bytes
loc2 = HDR + b"set ENCLAVE_FIXTURE_TOKEN=synthetic-not-a-secret\r\n" + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode() + b"rem tail comment\r\n"
d = fixture('c2', loc2); acl0 = files(d)['acl']
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc2))
want2 = loc2.replace(f"={OTHER}\r\n".encode(), f"={OTHER},{CRON}\r\n".encode())
check('C2 appended to the existing ids line, delay untouched', r.get('decision') == 'applied' and r.get('after') == sha(want2) and r.get('want', {}).get('delayMs') == 0, r)
check('C2 every non-respawn byte kept', r.get('otherBytesSha') == sha(nonrespawn(loc2)), r)
check('C2 ACL kept; backup beside it with the original bytes', r.get('aclKept') is True and files(d).get('node-config.local.cmd.pre-cron-respawn-' + sha(loc2)[:12]) == sha(loc2) and files(d)['acl'] == acl0, files(d))
r2 = run(d, 'rollback', ExpectLocal=sha(want2), ExpectBackup=sha(loc2))
check('C2 rollback restores the exact original bytes and ACL', r2.get('after') == sha(loc2) and r2.get('aclKept') is True, r2)
r3 = run(d, 'rollback', ExpectLocal=sha(want2), ExpectBackup=sha(loc2))
check('C2 rollback again: CAS refused (already restored)', r3.get('decision', '').startswith('refused: CAS'), r3)

# C3/C4 delay change refused when it would affect another id / the global switch
loc3 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c3', loc3)
r = run(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc3))
check('C3 delay 0->600000 with another id listed: refused, unchanged', r.get('decision', '').startswith('refused: changing the delay') and files(d)['node-config.local.cmd'] == sha(loc3), r)
loc4 = HDR + b"set ENCLAVE_ISOLATION_RESPAWN=1\r\n"; d = fixture('c4', loc4)
r = run(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc4))
check('C4 delay change with the global respawn on: refused', r.get('decision', '').startswith('refused: changing the delay') and files(d)['node-config.local.cmd'] == sha(loc4), r)
# C5 matching delay kept
loc5 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\nset ENCLAVE_ISOLATION_RESPAWN_DELAY_MS=600000\r\n".encode(); d = fixture('c5', loc5)
r = run(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc5))
check('C5 the same delay requested: id added, the delay line untouched', r.get('decision') == 'applied' and r.get('after') == sha(loc5.replace(f"={OTHER}\r\n".encode(), f"={OTHER},{CRON}\r\n".encode())), r)
# C6 CAS
d = fixture('c6', loc3)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal='0' * 64)
check('C6 apply with a stale local hash: refused, unchanged', r.get('decision', '').startswith('refused: CAS') and files(d)['node-config.local.cmd'] == sha(loc3), r)
r = run(d, 'apply', Id=CRON, ExpectConfig='0' * 64, ExpectLocal=sha(loc3))
check('C6 apply with a stale node-config.cmd hash: refused', r.get('decision', '').startswith('refused: CAS'), r)
# C7 duplicate key, C8 updater file, C9 malformed
loc7 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\nset ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c7', loc7)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc7)); check('C7 ids set twice: refused', r.get('decision', '').startswith('refused: a respawn key is set more than once'), r)
cfg8 = CFG + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c8', None, cfg8)
r = run(d, 'apply', Id=CRON, ExpectConfig=sha(cfg8), ExpectLocal='absent'); check('C8 setting in the updater-owned file: refused', r.get('decision', '').startswith('refused: respawn settings in the updater-owned'), r)
loc9 = HDR + b"set ENCLAVE_ISOLATION_RESPAWN_IDS=0xnothex\r\n"; d = fixture('c9', loc9)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc9)); check('C9 malformed value: refused, value never echoed', r.get('decision', '').startswith('refused: a respawn setting is malformed') and '0xnothex' not in json.dumps(r), r)
# C10 no final newline; C11 case-insensitive key + already present
loc10 = HDR + b"set ENCLAVE_FIXTURE_X=1"; d = fixture('c10', loc10)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc10))
check('C10 missing final newline: one CRLF added, then the ids line', r.get('decision') == 'applied' and r.get('addedFinalNewline') is True
      and r.get('after') == sha(loc10 + b"\r\n" + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={CRON}\r\n".encode()), r)
loc11 = HDR + f"SET Enclave_Isolation_Respawn_Ids={OTHER},{CRON.upper().replace('0X', '0x')}\r\n".encode(); d = fixture('c11', loc11)
r = run(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc11)); check('C11 case-insensitive key, id already present: noop', r.get('decision') == 'noop: already configured', r)
# C12 bad -Id
r = run(d, 'inspect', Id='0x1234'); check('C12 a malformed -Id: refused', r.get('decision', '').startswith('refused: -Id'), r)
ident = ps(f"Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;& '{STAGE}\\node-restart.ps1' -Mode identify", 120)
check('node-restart identify (read-only, live): exact action, one cmd + one agent, manager found', ident.get('actionExact') is True and len(ident.get('before', {}).get('cmd', [])) == 1
      and len(ident.get('before', {}).get('agent', [])) == 1 and ident.get('manager', {}).get('pid', 0) > 0 and ident.get('decision') == 'identified', ident)
print(json.dumps({'results': R, 'identify': ident, 'scripts': want}, indent=1))
print(f"{len(R) - len(fails)}/{len(R)} PASS" + (f"; FAILED {fails}" if fails else ''))
sys.exit(1 if fails else 0)
