#!/usr/bin/env python3
"""make-fixture-data.py -- LOCAL. Writes the scratch fixture's DUMMY launcher/hook files (stage/*.cmd), their pins (stage/pins-*.json,
exactly as root's reader hashes them) and the expected migration result (stage/expected.json), the latter computed by running the
UNCHANGED r3 script's plan on Linux (test/plan_linux.py). Dummy, non-secret values only (*.invalid hosts, 0x11.. addresses)."""
import hashlib, json, pathlib, re, sys
HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; S = PKG / 'stage'
ROOTSET = re.compile(r'(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$')
H = lambda b: hashlib.sha256(b).hexdigest()
def w(name, lines): (S / name).write_bytes(('\r\n'.join(lines) + '\r\n').encode('ascii'))
FILES = {
 # the hand-made launcher (as live run-node.cmd: generated lines + operator set lines), and the r6-style rewrite (no set line)
 'run-node.cmd': ['@echo off', 'call "%~dp0node-config.cmd"',
                  'set "ENCF_BASE_RPCS=https://rpc-a.invalid,https://rpc-b.invalid"',
                  'set ENCF_GATEWAYS=https://gw-one.invalid,https://gw-two.invalid',
                  'set "ENCF_PINS_FILE=C:\\dummy\\contract pins.json"',
                  'set ENCF_OWNERSHIP=0x1111111111111111111111111111111111111111',
                  'if not defined ENCF_STARTUP set "ENCF_STARTUP=https://s-a.invalid,https://s-b.invalid"',
                  'set "ENCF_SLOTS=3"', 'set ENCF_', 'exit /b 0'],
 'run-node.rewritten.cmd': ['@echo off', 'call "%~dp0node-config.cmd"', 'set ENCF_', 'exit /b 0'],
 'run-node.plain.cmd': ['@echo off', 'call "%~dp0node-config.cmd"', 'set ENCF_', 'exit /b 0'],
 'node-config.cmd': ['@echo off', 'rem dummy generated node configuration (config-native-fixture)', 'set ENCF_GEN_A=generated',
                     'set ENCF_SLOTS=16', 'set ENCF_GATEWAY=https://ipfs.invalid', 'if exist "%~dp0node-config.local.cmd" call "%~dp0node-config.local.cmd"'],
 'node-config.local.cmd': ['@echo off', 'rem dummy local hook (config-native-fixture)', 'set "ENCF_BASE_RPCS=https://rpc-a.invalid,https://rpc-b.invalid"',
                           'set ENCF_WALLET_HOLD=1', 'set "ENCF_PLATFORM_POLICY=production"', 'set ENCF_SLOTS=4', ''],
 'run-shield.cmd': ['@echo off', 'call "%~dp0shield-config.cmd"', 'set ENCF_SHIELD_DEBUG=1', 'set ENCF_', 'exit /b 0'],
 'run-shield.rewritten.cmd': ['@echo off', 'call "%~dp0shield-config.cmd"', 'set ENCF_', 'exit /b 0'],
 'run-shield.plain.cmd': ['@echo off', 'call "%~dp0shield-config.cmd"', 'set ENCF_', 'exit /b 0'],
 'shield-config.cmd': ['@echo off', 'rem dummy generated shield configuration (config-native-fixture)', 'set ENCF_SHIELD_GEN=generated',
                       'set ENCF_GATEWAY=https://ipfs.invalid', 'if exist "%~dp0shield-config.local.cmd" call "%~dp0shield-config.local.cmd"'],
 'link-target.cmd': ['@echo off', 'rem dummy symlink target (config-native-fixture)'],
}
def reader(lines): return [{'name': m.group(1), 'valueSha256': H(m.group(2).encode())} for m in (ROOTSET.match(l) for l in lines) if m]
def main():
    S.mkdir(exist_ok=True)
    for n, l in FILES.items(): w(n, l)
    sha = {n: H((S / n).read_bytes()) for n in FILES}
    main_p = {'format': 'enclave-local-config-pins/v1', 'files': {'run-node.cmd': sha['run-node.cmd'], 'run-shield.cmd': sha['run-shield.cmd'],
              'node-config.local.cmd': sha['node-config.local.cmd'], 'shield-config.local.cmd': 'absent'},
              'sources': {'run-node.cmd': reader(FILES['run-node.cmd']), 'run-shield.cmd': reader(FILES['run-shield.cmd'])}, 'extra': []}
    plain = json.loads(json.dumps(main_p)); plain['files']['run-node.cmd'] = sha['run-node.plain.cmd']; plain['files']['run-shield.cmd'] = sha['run-shield.plain.cmd']
    plain['sources'] = {'run-node.cmd': [], 'run-shield.cmd': []}
    bad = json.loads(json.dumps(main_p)); bad['sources']['run-node.cmd'][1]['valueSha256'] = '0' * 64
    for n, p in (('pins-main.json', main_p), ('pins-plain.json', plain), ('pins-badpin.json', bad)): (S / n).write_text(json.dumps(p, indent=1) + '\n')
    print(json.dumps({'files': sha}, indent=1))
if __name__ == '__main__': main()
