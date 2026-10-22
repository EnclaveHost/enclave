#!/bin/bash
# G-C2 fixture, end to end, inside ONE shared-queue allocation (768 MiB; the PostgreSQL container is bounded by docker
# --memory 256m, no swap):
#   python3 work/claude-test-queue.py --mib 768 --log <log> -- package/fixture/run-c2-fixture.sh
# Prerequisites: release/indexd-v0.6.0-fence.2-c2-linux-amd64 and fixture/c2client are built.
# Creates GENERATED disposable secrets (0600, never printed), a disposable PostgreSQL (pg-fixture.sh), seeds a v27
# database through the indexd-fence RELEASE store code (rollout_seed_test.go in a scratch copy of the release source),
# creates the node, runs run_c2_fixture_test.py, and ALWAYS removes the container, volume, secrets, node and scratch
# tree afterwards. No production, SSH, chain, download or key material beyond the disposable fixture.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
release_src=/home/steven/Documents/Codex/2026-10-18/wo/work/indexd-replica-rollout/src
cleanup() {
  python3 "$here/../controller/replicactl.py" --profile "$here/fixture-profile.json" stop >/dev/null 2>&1 || true
  "$here/pg-fixture.sh" down
  rm -rf "$here/secrets" "$here/node" "$here/seed-tree"
  echo "cleanup done"
}
trap cleanup EXIT
trap 'exit 143' TERM INT # run the cleanup on a queue stop too (if SIGKILLed first: pg-fixture.sh down; rm -rf secrets node seed-tree)
[ -e "$here/secrets" ] && { echo "stale secrets dir: refusing"; exit 2; }
for f in "$here/../release/indexd-v0.6.0-fence.2-c2-linux-amd64" "$here/c2client"; do
  [ -x "$f" ] || { echo "missing $f"; exit 2; }
done
umask 077
mkdir -m 0700 "$here/secrets"
printf 'POSTGRES_USER=indexd\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=indexd\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$here/secrets/postgres.env"
"$here/pg-fixture.sh" up || exit 1

# seed at v27 through the RELEASE store (a scratch copy; the release source itself is never written)
rsync -a --exclude GeoLite2-City.mmdb "$release_src/" "$here/seed-tree/"
cp "$here/rollout_seed_test.go" "$here/seed-tree/persist/postgres/"
( set -a; . "$here/secrets/postgres.env"; set +a
  cd "$here/seed-tree" && ROLLOUT_SEED=1 ROLLOUT_PG_PORT=55434 ROLLOUT_DB=indexd ROLLOUT_KEY_FILE="$here/secrets/app-key.hex" \
    GOPROXY=off GOFLAGS=-mod=mod GOMAXPROCS=2 GOMEMLIMIT=400MiB taskset -c 0-1 go test -p 1 -count=1 -run '^TestRolloutSeed$' -v ./persist/postgres/ 2>&1 \
    | grep -E "^(--- |ok|FAIL|PASS)|seeded:" ) || exit 1
[ -s "$here/secrets/app-key.hex" ] || { echo "seed key missing"; exit 1; }

python3 "$here/make-fixture-node.py" || exit 1
python3 "$here/run_c2_fixture_test.py"
