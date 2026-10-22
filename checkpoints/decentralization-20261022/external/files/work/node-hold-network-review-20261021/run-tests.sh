#!/bin/bash
# usage: run-tests.sh <tree dir> <out file>   (one focused file: the review cases)
cd "$(dirname "$0")/$1" && node --test --test-concurrency=1 test/hold-review.test.mjs > "../$2" 2>&1; echo "exit=$?" >> "../$2"
