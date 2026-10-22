#!/bin/bash
set -euo pipefail
umask 077
out=/var/lib/indexd-migration/final-20261019
exec 9>/run/enclave-indexd-migration.lock
flock -n 9
[ ! -e "$out" ]
[ ! -e /etc/indexd/ALLOW_NAN_WRITER ]
systemctl is-active --quiet indexd
[ "$(df -PB1 /var/lib/indexd | awk 'NR==2 {print $4}')" -gt 2147483648 ]
install -d -m 700 "$out"
cp /etc/systemd/system/indexd.service "$out/source-service.unit"
systemctl is-enabled indexd > "$out/source-enabled-state.txt"
install -d -m 755 /etc/systemd/system/indexd.service.d
fence=/etc/systemd/system/indexd.service.d/90-migration-write-fence.conf
[ ! -e "$fence" ]
printf '[Unit]\nConditionPathExists=/etc/indexd/ALLOW_NAN_WRITER\n' > "$fence"
systemctl daemon-reload
systemctl disable indexd >/dev/null
systemctl stop indexd
[ "$(systemctl show indexd --property=MainPID --value)" = 0 ]
if pgrep -u indexd -x indexd >/dev/null; then echo 'Source writer still exists' >&2; exit 2; fi
# This fence intentionally remains in place on errors. Never resume a stale writer automatically.
runuser -u postgres -- pg_dump --format=custom --no-owner --no-acl indexd > "$out/indexd.pgdump"
cp --reflink=auto /var/lib/indexd/consensus.db "$out/consensus.db"
cp /etc/indexd/indexd.yml "$out/indexd.yml"
cp /opt/indexd/current/indexd "$out/indexd"
cp /var/lib/indexd/GeoLite2-City.mmdb "$out/GeoLite2-City.mmdb"
runuser -u postgres -- psql --dbname=indexd --tuples-only --no-align --quiet -c "SELECT json_build_object('objects',(SELECT count(*) FROM objects),'slabs',(SELECT count(*) FROM slabs),'contracts',(SELECT count(*) FROM contracts),'accounts',(SELECT count(*) FROM accounts));" > "$out/counts.json"
python3 - "$out" <<'PY'
from pathlib import Path
import sys,json,hashlib,datetime
p=Path(sys.argv[1]);files={}
for name in ['indexd.pgdump','consensus.db','indexd.yml','indexd','GeoLite2-City.mmdb','counts.json']:
 f=p/name
 with f.open('rb') as stream:h=hashlib.file_digest(stream,'sha256').hexdigest()
 files[name]={'sha256':h,'bytes':f.stat().st_size}
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFenced':True,'sourceResumed':False,'files':files,'counts':json.loads((p/'counts.json').read_text())}
(p/'manifest.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
PY
