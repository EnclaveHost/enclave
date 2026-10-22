#!/usr/bin/env bash
cd "$(dirname "$0")" && node --test test/oneoff.test.mjs 2>&1 | grep -vE "^\s*(duration_ms|type:|\.\.\.|---)" | head -80
