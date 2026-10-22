#!/usr/bin/env bash
cd "$(dirname "$0")"; S=../same-route
for t in tree variants/base; do echo "=== TREE $t"; TREE=$S/$t timeout 120 node --test --test-concurrency=1 admission-ban.test.mjs 2>&1 | grep -E "^# in-flight|^(not )?ok|^# (pass|fail)|error:|platform|AssertionError" ; done
