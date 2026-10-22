#!/usr/bin/env bash
# Harmless: no key, no ?path=, empty body. 0.5.5 checks the key first (403 "bad key"); an unkeyed adapter would answer
# 400 "bad or missing ?path=". Neither writes anything. Also the adapter's status version.
H=7ae476a3.app.enclave.host
echo "POST /api/upload (no key): $(curl -sS --max-time 20 -X POST -H 'content-length: 0' -w ' -> %{http_code}' https://$H/api/upload)"
echo "status version: $(curl -sS --max-time 20 https://$H/api/status | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("app"),d.get("state"),d.get("files"))')"
