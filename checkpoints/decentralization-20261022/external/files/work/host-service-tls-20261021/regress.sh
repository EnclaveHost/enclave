#!/usr/bin/env bash
# Regression of the modified roles.mjs/runner.mjs (+ the new role) in the isolated scratch copy of main.
# 1 package --check before the build (expect: the new role's package is missing)  2 build  3 --check after
# 4 runner `check` on a host config that includes service-tls (verifies the built package; starts nothing)
# 5 the existing host-services suites, one file at a time.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/scratch
SERVICE_TLS_TMP=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/logs node --test --test-timeout=120000 test/service-tls.test.mjs > ../logs/final-suite.out 2>&1; echo "service-tls suite rc=$? $(grep -E '^# (pass|fail|skipped)' ../logs/final-suite.out | tr '\n' ' ')"
../mutants.sh
S=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/scratch
L=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/logs
cd "$S"
node scripts/build-host-service-packages.mjs --check > "$L/build-check-before.out" 2>&1; echo "check-before rc=$?"
node scripts/build-host-service-packages.mjs > "$L/build.out" 2>&1; echo "build rc=$?"
node scripts/build-host-service-packages.mjs --check > "$L/build-check-after.out" 2>&1; echo "check-after rc=$?"
sha256sum network/host-services/packages/*.json network/host-services/packages/*.mjs > "$L/packages.sha256"
node --input-type=module -e "
import fs from 'node:fs'; import { createHash } from 'node:crypto';
const pin = (r) => 'sha256:' + createHash('sha256').update(fs.readFileSync('network/host-services/packages/' + r + '.package.json')).digest('hex');
const cfg = { format: 'enclave-host-services/v1', host: { endpoint: 'https://host-a.example' }, platformHostPolicy: 'production', packagesDir: process.cwd() + '/network/host-services/packages', stateRoot: '/nonexistent/state',
  services: [ { role: 'bootstrap-replica', package: pin('bootstrap-replica'), config: { port: 18189, bind: '127.0.0.1', directory: '/nonexistent/a', manifest: '/nonexistent/m.json' } },
    { role: 'service-tls', package: pin('service-tls'), heapMiB: 128, config: { hostId: '0x12f3f2b102945550083e9246c98cb2a3404f76a51cb8bf8d94b4642505bdace0', zone: 'app.enclave.host', httpPort: 18280, tlsPorts: { 'bootstrap-replica': 18289 }, ca: 'letsencrypt' } } ] };
fs.writeFileSync('$L/hs-check.json', JSON.stringify(cfg));
" ; node network/host-services/runner.mjs check "$L/hs-check.json" > "$L/runner-check.out" 2>&1; echo "runner-check rc=$?"
for t in hosted-services-appstatic hosted-service-placement hosted-policy-cold-start credit-vault-submitter-runner; do
  SERVICE_TLS_TMP=$L node --test --test-timeout=600000 "test/$t.test.mjs" > "$L/reg-$t.out" 2>&1; rc=$?
  echo "$t rc=$rc $(grep -E '^# (pass|fail|skipped)' "$L/reg-$t.out" | tr '\n' ' ')"
done
