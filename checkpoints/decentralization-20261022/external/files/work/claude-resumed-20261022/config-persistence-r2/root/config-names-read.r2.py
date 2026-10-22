#!/usr/bin/env python3
"""ROOT-ONLY, NAMES-AND-HASHES-ONLY read of the five ProgramData\\Enclave launch/config files a release install REGENERATES
(run-node.cmd, node-config.cmd, run-network.cmd, shield-config.cmd, run-card.cmd) plus node-config.local.cmd (kept). Prepared by
Claude; never run by it. DEFAULT = PLAN ONLY (no network).
  config-names-read.py --execute --root-reviewed <planSha>  -> live-config-names.json (never overwritten)
For each file it returns only: present, sha256, and per `set NAME=...` line the NAME and the sha256 of its value; other lines
only as a count and the sha256 of each. NO value, path, URL, key or secret text leaves the host. No write, no process/task call.
Then: compare-config.py live-config-names.json -> which live-only settings node-config.local.cmd can carry and which have no hook."""
import argparse, base64, hashlib, importlib.util, json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent; W = next(p for p in HERE.parents if p.name == 'work')
TRANSPORT = W / 'nucbox-tls-20261021/root-activate-reviewed.py'; TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
FILES = ['run-node.cmd', 'node-config.cmd', 'node-config.local.cmd', 'run-network.cmd', 'shield-config.cmd', 'run-card.cmd',
         'run-shield.cmd', 'shield-config.local.cmd']   # r2: the Shield launcher and its new local hook (installer r6)
OUT = HERE / 'live-config-names.r2.json'; LIMIT = 7900
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
TEXT = (r"function TS($t){-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$t))|%{$_.ToString('x2')})};"
        r"$o=[ordered]@{};foreach($f in 'FILESX'.Split('|')){$p='C:\ProgramData\Enclave\'+$f;$e=[ordered]@{present=(Test-Path -LiteralPath $p)};"
        r"if($e.present){$e.sha256=FileSha $p;$sets=@();$other=@();foreach($l in [IO.File]::ReadAllLines($p)){"
        r"""$m=[regex]::Match($l,'(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$');"""
        r"if($m.Success){$sets+=,[ordered]@{name=$m.Groups[1].Value;valueSha256=(TS $m.Groups[2].Value)}}else{$other+=(TS $l)}};"
        r"$e.sets=$sets;$e.otherLines=$other.Count;$e.otherLineSha256=$other};$o[$f]=$e};$o|ConvertTo-Json -Depth 5 -Compress")
def load():
    if sha(TRANSPORT) != TRANSPORT_SHA: raise SystemExit('transport is not c50aac8e')
    s = importlib.util.spec_from_file_location('t', TRANSPORT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
def text():
    pattern = r'''(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$'''
    # Exercise the emitted .NET regex on the target before reading any live file.
    check = ("$pat='" + pattern + "';foreach($l in @('set TEST_NAME=value','set \"TEST_NAME=value\"','if not defined TEST_NAME set \"TEST_NAME=value\"')){"
             "$m=[regex]::Match($l,$pat);if(-not $m.Success -or $m.Groups[1].Value -cne 'TEST_NAME' -or $m.Groups[2].Value -cne 'value'){throw 'config name parser fixture failed'}};")
    assert pattern in TEXT
    return check + TEXT.replace('FILESX', '|'.join(FILES))
def plan_sha(): return hashlib.sha256(text().encode()).hexdigest()
def main(argv):
    a = argparse.ArgumentParser(); a.add_argument('--execute', action='store_true'); a.add_argument('--root-reviewed'); o = a.parse_args(argv)
    m = load(); n = len(base64.b64encode((m.HEAD.replace('SECS', '60') + text()).encode('utf-16-le')))
    if not o.execute:
        print(json.dumps({'mode': 'PLAN ONLY (no network)', 'files': FILES, 'encodedSize': n, 'limit': LIMIT, 'planSha': plan_sha(), 'text': text(),
                          'execute': f'python3 {pathlib.Path(__file__).name} --execute --root-reviewed {plan_sha()}'}, indent=1)); return 0 if n < LIMIT else 2
    if o.root_reviewed != plan_sha(): print(json.dumps({'refused': 'missing or wrong --root-reviewed'})); return 2
    if OUT.exists(): print(json.dumps({'refused': f'{OUT.name} exists (never overwritten)'})); return 2
    r = m.ps(text(), 60)
    if not isinstance(r, dict) or 'error' in r: print(json.dumps({'failed': r})); return 1
    with OUT.open('x') as f: json.dump(r, f, indent=1)
    print(json.dumps({'written': str(OUT)})); return 0
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
