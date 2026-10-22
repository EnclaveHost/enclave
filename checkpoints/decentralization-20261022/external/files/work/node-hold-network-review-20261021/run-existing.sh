#!/bin/bash
# existing suites importing the patched modules, against <tree>
cd "$(dirname "$0")/$1" && node --test --test-concurrency=1 $(grep -l -E "local-app-router|wg-manager|privacy-agent|wallet-admission|egress-map" test/*.mjs | grep -v hold-review) > "../$2" 2>&1; echo "exit=$?" >> "../$2"
