#!/bin/bash
cd "$(dirname "$0")"
curl -sS --max-time 25 -D public.hdr -o public.body https://38f368d6.app.enclave.host/ ; echo rc=$?
curl -sS --max-time 25 -o api-dep.body -w '%{http_code}\n' https://api.enclave.host/v1/deployments/0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c ; echo rc=$?
