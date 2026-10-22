#!/usr/bin/env bash
# READ-ONLY pin of each front's enclave-public-directory: unit properties, drop-in hashes/owners, runtime bundle hashes,
# config HASH only (never its content), node version, local /health and route count. No writes, no locks, no secrets.
for h in us-west eu-central ap-southeast ca-east; do
 echo "=== $h"
 timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=10 $h 'set -u
  u=enclave-public-directory
  systemctl show $u -p FragmentPath -p DropInPaths -p User -p Group -p DynamicUser -p StateDirectory -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp -p ExecStart --no-pager | sed "s/ ; start_time=.*//" | cut -c1-300
  d=/etc/systemd/system/$u.service.d; echo "DROPINDIR"; stat -c "%U:%G %a %n" $d $d/* 2>/dev/null
  for f in $d/*; do sha256sum "$f"; done
  echo "FRAGMENT $(stat -c "%U:%G %a" $(systemctl show $u -p FragmentPath --value)) $(sha256sum $(systemctl show $u -p FragmentPath --value) | cut -c1-64)"
  echo "OPT"; stat -c "%U:%G %a %n" /opt/enclave-directory /opt/enclave-directory/* /opt/enclave-directory/*/* 2>/dev/null
  for f in /opt/enclave-directory/*/enclave-directory.mjs; do sha256sum "$f"; done
  echo "CONFIG $(stat -c "%U:%G %a" /etc/enclave-directory/config-f6959cb.json) $(sha256sum /etc/enclave-directory/config-f6959cb.json | cut -c1-64)"
  echo "NODE $(/usr/local/bin/node --version)"; echo "PYTHON $(python3 --version 2>&1)"
  pid=$(systemctl show $u -p MainPID --value); echo "CMDLINE $(tr "\0" " " < /proc/$pid/cmdline)"
  echo "HEALTH $(curl -s -m 8 http://127.0.0.1:8188/health)"
  curl -s -m 12 http://127.0.0.1:8188/v1/network/routes | python3 -c "import json,sys;d=json.load(sys.stdin);print(\"ROUTES labels\",len(d[\"labels\"]),\"deployments\",len(d[\"deployments\"]),\"pending\",len(d.get(\"pending\",[])),\"crit\",[l in d[\"labels\"] for l in (\"7ae476a3\",\"9eb4e600\")])"
  ls -la /var/log/enclave-directory-runtime.journal.jsonl* /run/lock/enclave-public-directory-runtime.lock 2>&1 | cut -c1-160
  tail -n 2 /var/log/enclave-directory-runtime.journal.jsonl 2>/dev/null | cut -c1-200'
done
