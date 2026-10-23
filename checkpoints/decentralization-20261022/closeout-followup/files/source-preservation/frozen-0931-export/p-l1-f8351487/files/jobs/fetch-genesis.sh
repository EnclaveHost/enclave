#!/bin/bash
# Read-only: Lighthouse v8.3.2's embedded mainnet genesis state (repo file, 1.6 MB), pinned BY COMMIT; git blob sha checked.
set -u
LH=a376defa30470923556d91bdeb15a802e297f31f
cd "$(dirname "$0")/../evidence/sources" || exit 2
f=lighthouse-v8.3.2/common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip
curl -sS -L --proto =https --max-time 30 --max-filesize 4194304 -A enclave-l1-source-audit -o "$f" -w "%{http_code} %{size_download} genesis.ssz.zip\n" \
  "https://raw.githubusercontent.com/sigp/lighthouse/$LH/common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip" >> fetch.log 2>&1
python3 -I - "$f" <<'PY'
import hashlib, sys, zipfile
b = open(sys.argv[1], 'rb').read()
print('git-blob', hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest(), 'expect 28405c78f0daddee3e132ccb6976f71ea56fb28c')
z = zipfile.ZipFile(sys.argv[1]); n = z.namelist(); s = z.read(n[0])
print('members', n, 'stateBytes', len(s), 'sha256', hashlib.sha256(s).hexdigest())
print('genesis_time', int.from_bytes(s[0:8], 'little'), 'genesis_validators_root 0x' + s[8:40].hex(), 'slot', int.from_bytes(s[40:48], 'little'))
PY
find . -type f ! -name SHA256SUMS ! -name fetch.log -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
