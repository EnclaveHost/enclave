#!/bin/bash
# local logic check of kill-canary.mjs against mock-firewall.mjs: MOCK_JOB=1 must PASS, MOCK_JOB=0 must FAIL the property
cd "$(dirname "$0")/canary" || exit 9
for job in 1 0; do
  s=$(mktemp -d /tmp/kill-canary-mock-XXXXXX)
  MOCK_JOB=$job timeout 180 node kill-canary.mjs --mock --k2 2 --firewall "$PWD/mock-firewall.mjs" --scratch-parent "$s" > "../mock-job$job.out" 2>&1; echo "rc=$?" >> "../mock-job$job.out"
  ls -A "$s" >> "../mock-job$job.out"; rm -rf "$s"; rm -f ./*.locator.txt
done
