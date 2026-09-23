#!/bin/bash
# Wait (max 60 min) until no foreign process is above 50% CPU. Same filter as run2/run3.
for i in $(seq 1 240); do
  I=$(ps -eo pcpu,comm --sort=-pcpu --no-headers | grep -vE '^\s*[0-9.]+\s+(bench-spec2|shielded-worker|ps|grep|awk|sed|comm|pgrep|head|tail|sort|cut)$' | awk '$1>50' | head -1)
  [ -z "$I" ] && exit 0
  sleep 15
done
echo "waitquiet: still busy after 60 min: $I"
