#!/usr/bin/env bash
# native, isolated v2 checks on minipc + read-only VM facts. No apply, no account, no sshd restart, no task registration.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ
echo "== cleanup of this helper's own leftovers first"; timeout 120 python3 cleanup-cand.py
echo "== pin (public key + host key, read-only)"; timeout 120 python3 tunnel_install.py pin || exit 1
echo "== vm-preflight"; timeout 120 python3 tunnel_install.py vm-preflight
echo "== minipc-preflight"; timeout 120 python3 tunnel_install.py minipc-preflight
echo "== minipc-candidate-check"; timeout 240 python3 tunnel_install.py minipc-candidate-check 2>&1 | tail -60
echo "== minipc-sandbox-test"; timeout 420 python3 tunnel_install.py minipc-sandbox-test 2>&1 | tail -150
echo "== leftovers (read-only)"; timeout 120 python3 -c "
import importlib.util,json
s=importlib.util.spec_from_file_location('t','tunnel_install.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.ps(r\"\$o=[ordered]@{staging=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\staging' -Directory -Filter 'tunnel-*'|ForEach-Object{\$_.Name});user=[bool](Get-LocalUser -Name '\" + m.WINUSER + r\"' -ErrorAction SilentlyContinue);tasks=@(Get-ScheduledTask -TaskName 'EnclaveTunnel*' -ErrorAction SilentlyContinue|ForEach-Object{\$_.TaskName});configSha=(Get-FileHash -Algorithm SHA256 'C:\ProgramData\ssh\sshd_config').Hash.ToLower();keys=(Test-Path ('C:\ProgramData\ssh\' + '\" + m.WINUSER + r\"' + '_authorized_keys'));sshd=[string](Get-Service sshd).Status}\")))"
date -u +%FT%TZ
