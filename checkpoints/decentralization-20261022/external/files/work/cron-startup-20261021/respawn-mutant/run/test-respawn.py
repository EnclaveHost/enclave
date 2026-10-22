#!/usr/bin/env python3
"""Fixture tests on minipc's own PowerShell 5.1, through the SAME hash-verified ScriptBlock runner activate.py uses,
against SYNTHETIC files under C:\\ProgramData\\Enclave\\hotfix\\cron-respawn-20261021\\fixtures. The live node-config files
and the live bundle are never read or written here; node-restart.ps1 runs only in its read-only -Mode identify.
  respawn  C1-C12 decisions/CAS/idempotence/rollback (as before) + A1 parent with an INHERITABLE Users-read ACL: every
           content file private, the destination ACL unchanged + A2 a pre-existing NON-private work dir: refused before
           any content write + J1 an unfinished journal blocks apply; CAS rollback resolves it
  runner   X1 a staged script whose bytes are not the pin is never executed
  bundle   B1-B6 CAS swap, node --check on the exact bytes, private backup, ACL kept, idempotence, rollback, journal"""
import base64, hashlib, importlib.util, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('activate', os.path.join(HERE, 'activate.py'))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
ps, STAGE = A.ps, A.STAGE; FIX = STAGE + r"\fixtures"
CRON = A.CRON; OTHER = '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
CFG = b"@echo off\r\nrem synthetic fixture\r\nset APPS=1\r\nset NODE_NAME=fixture\r\nif exist \"x\\node-config.local.cmd\" call \"x\\node-config.local.cmd\"\r\n"
HDR = b"@echo off\r\nrem This box's own node settings, read after node-config.cmd. Updates never write this file.\r\n"
sha = lambda b: hashlib.sha256(b).hexdigest()
R, fails = {}, []
def check(label, cond, detail=None):
    R[label] = bool(cond)
    if not cond: fails.append(label); print('FAIL', label, json.dumps(detail)[:700] if detail is not None else '')

# stage the three public scripts (SFTP), verify bytes and parse there
ps(f"$null=New-Item -ItemType Directory -Force -Path '{FIX}';Remove-Item -Recurse -Force -LiteralPath '{FIX}' -ErrorAction SilentlyContinue;$null=New-Item -ItemType Directory -Force -Path '{FIX}';'{{}}'", 60)
for f in A.NAMES:
    r = subprocess.run(['timeout', '120', 'scp', '-q', os.path.join(HERE, f), 'minipc:/' + STAGE.replace('\\', '/') + '/' + f], capture_output=True, text=True)
    check(f'staged {f}', r.returncode == 0, r.stderr[-200:])
got = ps("$o=[ordered]@{};foreach($f in @(%s)){$p=Join-Path '%s' $f;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e);"
         "$o[$f]=[ordered]@{sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower();parseErrors=@($e).Count}};$o|ConvertTo-Json -Compress" % (','.join(f"'{n}'" for n in A.NAMES), STAGE), 60)
for f in A.NAMES:
    check(f'{f}: staged bytes == pin, 0 parse errors', got.get(f, {}).get('sha') == A.SCRIPTS[f] and got.get(f, {}).get('parseErrors') == 0, got)

def put(d, name, b): return f"[IO.File]::WriteAllBytes('{d}\\{name}',[Convert]::FromBase64String('{base64.b64encode(b).decode()}'));"
def fixture(case, local=None, cfg=CFG, wide=False):
    d = FIX + '\\' + case
    s = f"$null=New-Item -ItemType Directory -Force -Path '{d}';"
    if wide: s += f"$null=& icacls.exe '{d}' /grant '*S-1-5-32-545:(OI)(CI)RX';"     # Users read, INHERITABLE: the hostile parent
    s += put(d, 'node-config.cmd', cfg) + (put(d, 'node-config.local.cmd', local) if local is not None else '')
    ps(s + "'{}'", 60); return d
def cr(d, mode, **kw): return A.run_script('cron-respawn.ps1', {'Mode': mode, 'Dir': d, **kw}, 120)['result']
def acls(d, sub=''):   # name -> {sha, private (only SY/BA allow rules), protected}
    p = d + ('\\' + sub if sub else '')
    return ps("$o=[ordered]@{};if(Test-Path -LiteralPath '%s'){foreach($f in @(Get-ChildItem -LiteralPath '%s' -Force -File)){$a=Get-Acl -LiteralPath $f.FullName;"
              "$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$o[$f.Name]=[ordered]@{sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLower();"
              "private=(-not @($r|Where-Object{$_.AccessControlType -ne 'Allow' -or @('S-1-5-18','S-1-5-32-544') -notcontains $_.IdentityReference.Value}).Count);sddl=$a.Sddl}};"
              "$a=Get-Acl -LiteralPath '%s';$o['.dir']=[ordered]@{protected=$a.AreAccessRulesProtected;sddl=$a.Sddl}};$o|ConvertTo-Json -Compress -Depth 4" % (p, p, p), 60)
def nonrespawn(b): return b''.join(l for l in re.split(rb'(?<=\n)', b) if l and not re.match(rb'(?i)^\s*set\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=', l))
csha = sha(CFG)

# ---- respawn decisions (C1-C12)
d = fixture('c1')
check('C1 absent: inspect would apply', cr(d, 'inspect', Id=CRON).get('decision') == 'would apply')
r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal='absent'); want1 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={CRON}\r\n".encode()
check('C1 created: header + one ids line, private, temp private before write', r.get('decision') == 'applied' and r.get('after') == sha(want1) and r.get('localPrivate') is True and r.get('tempPrivateBeforeWrite') is True, r)
check('C1 work dir protected, only private files in it', acls(d, '.cron-respawn').get('.dir', {}).get('protected') is True and all(v.get('private') for k, v in acls(d, '.cron-respawn').items() if k != '.dir'), acls(d, '.cron-respawn'))
check('C1 apply again: noop', cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=r.get('after')).get('decision') == 'noop: already configured')
rb = cr(d, 'rollback', ExpectLocal=r.get('after'), ExpectBackup='none')
check('C1 rollback of a created file: local absent, set aside INSIDE the private dir', rb.get('decision') == 'rolled back' and rb.get('after') == 'absent'
      and any(k.startswith('rolledback-') for k in acls(d, '.cron-respawn')), rb)
loc2 = HDR + b"set ENCLAVE_FIXTURE_TOKEN=synthetic-not-a-secret\r\n" + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode() + b"rem tail\r\n"
d = fixture('c2', loc2); a0 = acls(d)['node-config.local.cmd']['sddl']
r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc2)); want2 = loc2.replace(f"={OTHER}\r\n".encode(), f"={OTHER},{CRON}\r\n".encode())
check('C2 appended to the ids line, delay kept (0)', r.get('decision') == 'applied' and r.get('after') == sha(want2) and r.get('want', {}).get('delayMs') == 0, r)
check('C2 every non-respawn byte kept; destination ACL unchanged', r.get('otherBytesSha') == sha(nonrespawn(loc2)) and r.get('aclKept') is True and acls(d)['node-config.local.cmd']['sddl'] == a0, r)
pv = acls(d, '.cron-respawn')
check('C2 backup = original bytes, private; temp private before write', pv.get('backup-' + sha(loc2)[:12], {}).get('sha') == sha(loc2) and pv['backup-' + sha(loc2)[:12]]['private'] is True
      and r.get('backupPrivate') is True and r.get('tempPrivateBeforeWrite') is True, pv)
r2 = cr(d, 'rollback', ExpectLocal=sha(want2), ExpectBackup=sha(loc2))
check('C2 rollback: exact original bytes and ACL', r2.get('after') == sha(loc2) and r2.get('aclKept') is True and acls(d)['node-config.local.cmd']['sddl'] == a0, r2)
check('C2 rollback again: CAS refused', cr(d, 'rollback', ExpectLocal=sha(want2), ExpectBackup=sha(loc2)).get('decision', '').startswith('refused: CAS'))
loc3 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c3', loc3)
r = cr(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc3))
check('C3 delay 0->600000 with another id: refused, unchanged, no work dir', r.get('decision', '').startswith('refused: changing the delay') and acls(d)['node-config.local.cmd']['sha'] == sha(loc3) and acls(d, '.cron-respawn') == {}, r)
loc4 = HDR + b"set ENCLAVE_ISOLATION_RESPAWN=1\r\n"; d = fixture('c4', loc4)
check('C4 delay change with the global switch: refused', cr(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc4)).get('decision', '').startswith('refused: changing the delay'))
loc5 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\nset ENCLAVE_ISOLATION_RESPAWN_DELAY_MS=600000\r\n".encode(); d = fixture('c5', loc5)
r = cr(d, 'apply', Id=CRON, Delay='600000', ExpectConfig=csha, ExpectLocal=sha(loc5))
check('C5 matching delay: id added, delay line untouched', r.get('decision') == 'applied' and r.get('after') == sha(loc5.replace(f"={OTHER}\r\n".encode(), f"={OTHER},{CRON}\r\n".encode())), r)
d = fixture('c6', loc3)
check('C6 stale local hash: refused', cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal='0' * 64).get('decision', '').startswith('refused: CAS'))
check('C6 stale node-config.cmd hash: refused', cr(d, 'apply', Id=CRON, ExpectConfig='0' * 64, ExpectLocal=sha(loc3)).get('decision', '').startswith('refused: CAS'))
loc7 = HDR + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\nset ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c7', loc7)
check('C7 key set twice: refused', cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc7)).get('decision', '').startswith('refused: a respawn key is set more than once'))
cfg8 = CFG + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={OTHER}\r\n".encode(); d = fixture('c8', None, cfg8)
check('C8 setting in the updater-owned file: refused', cr(d, 'apply', Id=CRON, ExpectConfig=sha(cfg8), ExpectLocal='absent').get('decision', '').startswith('refused: respawn settings in the updater-owned'))
loc9 = HDR + b"set ENCLAVE_ISOLATION_RESPAWN_IDS=0xnothex\r\n"; d = fixture('c9', loc9); r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc9))
check('C9 malformed: refused, never echoed', r.get('decision', '').startswith('refused: a respawn setting is malformed') and '0xnothex' not in json.dumps(r), r)
loc10 = HDR + b"set ENCLAVE_FIXTURE_X=1"; d = fixture('c10', loc10); r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc10))
check('C10 missing final newline: one CRLF, then the ids line', r.get('decision') == 'applied' and r.get('addedFinalNewline') is True
      and r.get('after') == sha(loc10 + b"\r\n" + f"set ENCLAVE_ISOLATION_RESPAWN_IDS={CRON}\r\n".encode()), r)
loc11 = HDR + f"SET Enclave_Isolation_Respawn_Ids={OTHER},{CRON}\r\n".encode(); d = fixture('c11', loc11)
check('C11 case-insensitive key, id present: noop', cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc11)).get('decision') == 'noop: already configured')
check('C12 malformed -Id: refused', cr(d, 'inspect', Id='0x1234').get('decision', '').startswith('refused: -Id'))

# ---- root review 1: hostile (inheritable Users-read) parent; pre-existing non-private work dir
d = fixture('a1', loc2, wide=True); a0 = acls(d)['node-config.local.cmd']['sddl']
r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc2)); pv = acls(d, '.cron-respawn')
check('A1 Users-read parent: applied; work dir PROTECTED; every content file in it private', r.get('decision') == 'applied' and pv.get('.dir', {}).get('protected') is True
      and all(v.get('private') for k, v in pv.items() if k != '.dir') and r.get('tempPrivateBeforeWrite') is True and r.get('backupPrivate') is True, {'r': r, 'pv': pv})
check('A1 the destination keeps exactly its own ACL', r.get('aclKept') is True and acls(d)['node-config.local.cmd']['sddl'] == a0, acls(d))
d = fixture('a2', loc2, wide=True); ps(f"$null=New-Item -ItemType Directory -Force -Path '{d}\\.cron-respawn';'{{}}'", 60)     # inherits Users read
r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc2)); pv = acls(d, '.cron-respawn')
check('A2 a non-private work dir: refused BEFORE any content write (dir empty, local unchanged)', r.get('decision', '').startswith('refused: PRIVATE_DIR_NOT_PRIVATE')
      and [k for k in pv if k != '.dir'] == [] and acls(d)['node-config.local.cmd']['sha'] == sha(loc2), {'r': r, 'pv': pv})
# ---- root review 2: an unfinished journal blocks apply; CAS rollback resolves it
d = fixture('j1', loc3); r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc3)); new = r.get('after')
ps(f"$p='{d}\\.cron-respawn\\journal.json';$j=Get-Content -Raw -LiteralPath $p|ConvertFrom-Json;$j.state='started';[IO.File]::WriteAllText($p,($j|ConvertTo-Json -Compress));'{{}}'", 60)
r = cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=new)
check('J1 journal started: apply refused with the observed hashes', r.get('decision', '').startswith('refused: a previous mutation did not finish') and r.get('observed', {}).get('local') == new, r)
r = cr(d, 'rollback', ExpectLocal=new, ExpectBackup=sha(loc3))
check('J1 CAS rollback on the observed bytes resolves it', r.get('decision') == 'rolled back' and r.get('after') == sha(loc3), r)
check('J1 then apply proceeds again', cr(d, 'apply', Id=CRON, ExpectConfig=csha, ExpectLocal=sha(loc3)).get('decision') == 'applied')
# ---- runner: tampered bytes are never executed
real = A.SCRIPTS['cron-respawn.ps1']; A.SCRIPTS['cron-respawn.ps1'] = '0' * 64
r = A.run_script('cron-respawn.ps1', {'Mode': 'inspect', 'Dir': d, 'Id': CRON}, 60)['result']; A.SCRIPTS['cron-respawn.ps1'] = real
check('X1 a staged script that is not the pinned bytes is refused, not run', r.get('decision', '').startswith('refused: the staged cron-respawn.ps1 is not the pinned bytes'), r)

# ---- bundle swap (synthetic target + staged files)
OLD, NEW, BAD = b"export const v = 1;\n", b"export const v = 2;\n", b"export const = ;\n"
def bfix(case, target=OLD):
    d = FIX + '\\' + case; ps(f"$null=New-Item -ItemType Directory -Force -Path '{d}';" + put(d, 'target.mjs', target) + put(d, 'new.mjs', NEW) + put(d, 'bad.mjs', BAD) + "'{}'", 60); return d
def bs(d, mode, **kw): return A.run_script('bundle-swap.ps1', {'Mode': mode, 'WorkDir': d, 'Target': d + '\\target.mjs', 'OldSha': sha(OLD), **kw}, 120)['result']
d = bfix('b1'); t0 = acls(d)['target.mjs']['sddl']
check('B1 inspect: would apply (node --check 0)', bs(d, 'inspect', NewFile=d + '\\new.mjs', NewSha=sha(NEW)).get('decision') == 'would apply')
r = bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha=sha(NEW)); pv = acls(d, '.bundle-swap')
check('B1 apply: target == new, ACL kept, backup == old and private', r.get('after') == sha(NEW) and r.get('aclKept') is True and acls(d)['target.mjs']['sddl'] == t0
      and pv.get('backup-' + sha(OLD)[:12] + '.mjs', {}).get('sha') == sha(OLD) and all(v.get('private') for k, v in pv.items() if k != '.dir') and pv['.dir']['protected'] is True, {'r': r, 'pv': pv})
check('B1 apply again: noop', bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha=sha(NEW)).get('decision', '').startswith('noop'))
r = bs(d, 'rollback', ExpectCurrent=sha(NEW))
check('B2 rollback: old bytes, ACL kept', r.get('after') == sha(OLD) and r.get('aclKept') is True, r)
check('B2 rollback again: CAS refused', bs(d, 'rollback', ExpectCurrent=sha(NEW)).get('decision', '').startswith('refused: CAS'))
d = bfix('b3'); r = bs(d, 'apply', NewFile=d + '\\bad.mjs', NewSha=sha(BAD))
check('B3 node --check fails on the exact bytes: refused, target unchanged', r.get('decision', '').startswith('refused: node --check') and acls(d)['target.mjs']['sha'] == sha(OLD), r)
d = bfix('b4', target=b"export const v = 9;\n")
check('B4 target is not -OldSha: refused', bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha=sha(NEW)).get('decision', '').startswith('refused: CAS'))
d = bfix('b5')
check('B5 staged file is not -NewSha: refused', bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha='1' * 64).get('decision', '').startswith('refused: the staged file'))
d = bfix('b6'); bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha=sha(NEW))
ps(f"$p='{d}\\.bundle-swap\\journal.json';$j=Get-Content -Raw -LiteralPath $p|ConvertFrom-Json;$j.state='started';[IO.File]::WriteAllText($p,($j|ConvertTo-Json -Compress));'{{}}'", 60)
r = bs(d, 'apply', NewFile=d + '\\new.mjs', NewSha=sha(NEW))
check('B6 journal started: apply refused with observed hashes', r.get('decision', '').startswith('refused: a previous mutation') and r.get('observed', {}).get('target') == sha(NEW), r)
# ---- node-restart identify (read-only, live)
ident = A.identify()['result']
check('identify (live, read-only): exact action, one cmd + one agent with starts, manager PID+start, other tasks listed', ident.get('actionExact') is True
      and len(ident.get('before', {}).get('cmd', [])) == 1 and len(ident.get('before', {}).get('agent', [])) == 1 and ident['before']['agent'][0].get('start')
      and ident.get('manager', {}).get('start') and 'Shield=' in str(ident.get('others')) and ident.get('decision') == 'identified', ident)
print(json.dumps({'results': R, 'identify': ident, 'scripts': A.SCRIPTS}, indent=1))
print(f"{len(R) - len(fails)}/{len(R)} PASS" + (f"; FAILED {fails}" if fails else ''))
sys.exit(1 if fails else 0)
