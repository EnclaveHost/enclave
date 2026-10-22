#!/bin/bash
set -euo pipefail
umask 077
out=/var/lib/enclave-indexd/recovery-final-20261019
exec 9>/run/enclave-indexd-snapshot.lock
flock -n 9
[ ! -e "$out" ]
systemctl is-active --quiet enclave-indexd
mkdir -m 700 "$out"
resume=0
cleanup(){ rc=$?; trap - EXIT; if [ "$resume" = 1 ]; then systemctl start enclave-indexd || rc=1; fi; exit "$rc"; }
trap cleanup EXIT
start=$(date +%s)
resume=1
systemctl stop enclave-indexd
[ "$(systemctl show enclave-indexd -p MainPID --value)" = 0 ]
! pgrep -u enclave-indexd -x indexd >/dev/null
docker exec enclave-indexd-postgres pg_dump -U postgres -d indexd --format=custom --no-owner --no-acl > "$out/indexd.pgdump"
cp --reflink=auto /var/lib/enclave-indexd/state/consensus.db "$out/consensus.db"
cp /etc/enclave-indexd/indexd.yml "$out/indexd.yml"
cp /opt/enclave-indexd/indexd "$out/indexd"
cp /var/lib/enclave-indexd/state/GeoLite2-City.mmdb "$out/GeoLite2-City.mmdb"
docker exec enclave-indexd-postgres psql -U postgres -d indexd -Atq -c "SELECT json_build_object('objects',(SELECT count(*) FROM objects),'slabs',(SELECT count(*) FROM slabs),'contracts',(SELECT count(*) FROM contracts),'accounts',(SELECT count(*) FROM accounts));" > "$out/counts.json"
systemctl start enclave-indexd
systemctl is-active --quiet enclave-indexd
resume=0
end=$(date +%s)
python3 - "$out" "$start" "$end" <<'PY'
from pathlib import Path
import json,hashlib,datetime,sys
p=Path(sys.argv[1]);files={}
for name in ['indexd.pgdump','consensus.db','indexd.yml','indexd','GeoLite2-City.mmdb','counts.json']:
 f=p/name
 with f.open('rb') as stream:h=hashlib.file_digest(stream,'sha256').hexdigest()
 files[name]={'bytes':f.stat().st_size,'sha256':h}
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'minipc / enclave-storage','quiesced':True,'sourceResumed':True,'stopThroughStartSeconds':int(sys.argv[3])-int(sys.argv[2]),'files':files,'counts':json.loads((p/'counts.json').read_text())}
(p/'manifest.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
PY
