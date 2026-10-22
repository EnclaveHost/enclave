#!/bin/bash
# IN-CONTAINER (sdk_regression_runner.py `docker exec --user <host uid>`, under `timeout -k 10 <s>`). Runs ONE real
# harness + REAL SDK driver case group. Derived from indexd-c2-implementation/tools/run-sdk-case-c2.sh (ccba8896): the
# same harness flags (-indexers 3 -hosts 12), driver flags (--ignored --exact --test-threads=1 --nocapture), evidence,
# /exit?drop=1 and redaction targets. Differences:
#   - PostgreSQL is THIS container's own: 127.0.0.1:5432 inside --network none, with the run's generated dummy
#     credentials from the exec environment. They are written only to a 0600 file in scratch and removed after the group.
#     The shared 55432 fixture and its credentials are never used.
#   - CPU is the container's cpuset (2 CPUs) for harness and driver together.
# env: GROUP RUNID MODE HARNESS CASES READY_SECONDS HARNESS_GOMEMLIMIT POSTGRES_USER POSTGRES_PASSWORD
# exit: the driver's libtest rc (0 pass, 101 test failure) | 3 harness not ready | 4 harness exited before ready
set -u
dir=/scratch/runs/$GROUP; mkdir -p /scratch/runs
umask 077; pe=/scratch/runs/.pg-$GROUP.env
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" > "$pe"
GOMEMLIMIT=$HARNESS_GOMEMLIMIT GOMAXPROCS=2 "$HARNESS" -dir "$dir" -indexd /geoip -run "$RUNID" -indexers 3 -hosts 12 \
  -pg-host 127.0.0.1 -pg-port 5432 -pg-env "$pe" > "/scratch/runs/$GROUP.harness.log" 2>&1 &
h=$!
for _ in $(seq 1 "$READY_SECONDS"); do [ -f "$dir/ctl.url" ] && break; kill -0 $h 2>/dev/null || break; sleep 1; done
if [ ! -f "$dir/ctl.url" ]; then
  if kill -0 $h 2>/dev/null; then kill $h; wait $h; rm -f "$pe"; echo "GROUP-RESULT harness-not-ready"; exit 3; fi
  wait $h; hrc=$?; rm -f "$pe"; echo "GROUP-RESULT harness-exited rc=$hrc"; exit 4
fi
rm -f "$pe"                                  # the harness has read it; nothing else needs the credentials
ctl=$(cat "$dir/ctl.url"); hp=${ctl#http://}
post() { exec 3<>"/dev/tcp/${hp%:*}/${hp#*:}"; printf "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" "$1" "$hp" >&3; cat <&3; exec 3<&-; }
# shellcheck disable=SC2086  # CASES is a space-separated list of exact test names
SIAS3_REAL_CTL=$ctl SIAS3_REAL_INDEXD=$MODE /driver/sdk-driver $CASES --ignored --exact --test-threads=1 --nocapture > "$dir/driver.log" 2>&1
rc=$?
post /evidence | sed -n "/^{/,\$p" > "$dir/evidence.json" || true
du -sb "$dir/hosts" > "$dir/resources.txt" 2>&1 || true
post "/exit?drop=1" > /dev/null || true
wait $h; hrc=$?
rm -rf "$dir/hosts"
echo "GROUP-RESULT driver=$rc harness=$hrc"
exit $rc
