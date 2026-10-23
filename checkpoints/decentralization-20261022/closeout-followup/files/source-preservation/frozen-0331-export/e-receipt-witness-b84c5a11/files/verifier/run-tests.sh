#!/bin/bash
# Offline build + tests of the receipt-witness verifier, inside a private network namespace (no network: modules come
# from the local Go module cache, verified by go.sum). Run through the shared queue at 1024 MiB.
set -u
cd "$(dirname "$0")" || exit 2
sha256sum go.mod go.sum verifier.go verifier_test.go cmd/witness-verify/main.go ../probe/fixture-1.json.gz
export GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY=off GOMAXPROCS=2 CGO_ENABLED=0
exec timeout -k 10 "${JOB_SEC:-580}" unshare -rn sh -c 'go vet ./... && go build -p 1 -trimpath -o witness-verify ./cmd/witness-verify && go test -p 1 -count=1 -v ./... 2>&1 && A=$(zcat ../probe/fixture-1.json.gz | python3 -c "import json,sys;print(json.load(sys.stdin)[\"headers\"][-1][\"hash\"])") && ./witness-verify ../probe/fixture-1.json.gz $A > cli-ok.json && echo CLI-ACCEPTED-ANCHOR && { truncate -s 2M big-sparse.json; WITNESS_MAX_FIXTURE_BYTES=1048576 ./witness-verify big-sparse.json 0x01; c=$?; rm -f big-sparse.json; test $c -eq 2 && echo CLI-REFUSED-OVERSIZE; } && { ./witness-verify ../probe/fixture-1.json.gz 0x01; test $? -eq 1 && echo CLI-REFUSED-WRONG-ANCHOR; }'
