#!/bin/bash
# usage: one.sh <test file> <out>   (one existing suite, from tree/)
cd "$(dirname "$0")/tree" && node --test --test-concurrency=1 "$1" > "../$2" 2>&1; echo "exit=$?" >> "../$2"
