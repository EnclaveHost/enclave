#!/bin/bash
# the storage ORIGIN named in the public config override (hostname only), probed once: unauthenticated GET / (an S3
# origin answers 403/400 quickly when alive); nothing signed, no bucket or key touched
cd "$(dirname "$0")"
H=$(timeout 60 python3 -c "
import json,urllib.request,hashlib,urllib.parse
b=urllib.request.urlopen('https://ipfs.enclave.host/ipfs/bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey?format=raw',timeout=40).read()
assert hashlib.sha256(b).hexdigest()==json.load(open('deploy-config-shape.json'))['sha256']
print(urllib.parse.urlparse(json.loads(b)['storage']['endpoint']).hostname)")
echo "storage host: $H"
for i in 1 2; do curl -sS --max-time 40 -o /dev/null -w "GET / -> %{http_code} in %{time_total}s\n" "https://$H/"; done
