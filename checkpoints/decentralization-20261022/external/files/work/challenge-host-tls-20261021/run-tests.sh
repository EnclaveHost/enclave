#!/bin/bash
# usage: run-tests.sh <out> <test files...>   (from tree/, serial)
out=$1; shift
cd "$(dirname "$0")/tree" && node --test --test-concurrency=1 "$@" > "../$out" 2>&1; echo "exit=$?" >> "../$out"
