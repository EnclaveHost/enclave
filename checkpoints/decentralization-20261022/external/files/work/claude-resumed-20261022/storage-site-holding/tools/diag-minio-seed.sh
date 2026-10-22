#!/usr/bin/env bash
# diag-minio-seed.sh: which seeding request of real-adapter-proof r2 failed (exit 22)? MinIO alone, private user+mount+PID+net
# namespace, loopback only, bounded; prints HTTP codes and short S3 error bodies; removes its own data after MinIO has exited.
set -uo pipefail
if [ -z "${IN_DIAG_NS:-}" ]; then exec timeout --kill-after=10 120 unshare -Urnmfp --mount-proc --kill-child env IN_DIAG_NS=1 bash "$0"; fi
ip link set lo up; D=$(cd "$(dirname "$0")/.." && pwd)/diag-run; rm -rf "$D"; mkdir -p "$D"
AK=holdtest; SK=$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9); S3=http://127.0.0.1:19100
MINIO_ROOT_USER=$AK MINIO_ROOT_PASSWORD=$SK minio server --address 127.0.0.1:19100 "$D/minio" > "$D/minio.log" 2>&1 & M=$!
for i in $(seq 1 100); do curl -sf "$S3/minio/health/ready" >/dev/null && break; sleep 0.2; done
echo "secret length ${#SK}"
c() { local n="$1"; shift; local code; code=$(curl -s -o "$D/body" -w '%{http_code}' "$@"); echo "$n -> $code $(head -c 300 "$D/body" | tr '\n' ' ')"; }
c "create bucket"           -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" "$S3/holdbkt/"
printf 'pinned' > "$D/pin.txt"
c "PUT from stdin (-T -)"   -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" -T - "$S3/holdbkt/pins/x1" < "$D/pin.txt"
c "PUT from file (-T file)" -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" -T "$D/pin.txt" "$S3/holdbkt/pins/x2"
kill -TERM $M; for i in $(seq 1 50); do kill -0 $M 2>/dev/null || break; sleep 0.2; done; kill -KILL $M 2>/dev/null; wait $M 2>/dev/null
rm -rf "$D"; echo done
