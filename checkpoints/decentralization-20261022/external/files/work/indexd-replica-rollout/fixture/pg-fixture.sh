#!/bin/bash
# Disposable PostgreSQL for the rollout fixture: the PRODUCTION image digest and flags of
# work/storage-vm/enclave-indexd-postgres.service, except: bridge network published on 127.0.0.1:55433 (production:
# host network, listen 127.0.0.1:5432), a docker volume instead of /var/lib/enclave-indexd/postgres, and
# --memory 256m. Credentials come from fixture/secrets/postgres.env (0600, generated, disposable).
#   pg-fixture.sh up | kill | start | down
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=enclave-rollout-fixture-pg vol=enclave-rollout-fixture-pgdata
img=postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336
case "${1:?up|kill|start|down}" in
  up)   docker volume create $vol >/dev/null
        docker run -d --name $name -p 127.0.0.1:55433:5432 --read-only --memory 256m --memory-swap 256m \
          --env-file "$here/secrets/postgres.env" --mount type=volume,source=$vol,target=/var/lib/postgresql \
          --tmpfs /var/run/postgresql:rw,size=16m --tmpfs /tmp:rw,size=64m \
          $img postgres -c listen_addresses='*' -c shared_buffers=128MB -c max_connections=50 >/dev/null ;;
  kill) docker kill --signal KILL $name >/dev/null ;;          # crash: no shutdown checkpoint
  start) docker start $name >/dev/null ;;
  down) docker rm -f $name >/dev/null 2>&1 || true; docker volume rm $vol >/dev/null 2>&1 || true ;;
esac
if [ "$1" = up ] || [ "$1" = start ]; then
  for i in $(seq 1 60); do docker exec $name pg_isready -q -h 127.0.0.1 && { echo "$name ready"; exit 0; }; sleep 1; done
  echo "$name not ready"; exit 1
fi
