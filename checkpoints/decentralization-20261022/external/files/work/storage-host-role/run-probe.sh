#!/bin/bash
cd "$(dirname "$0")/tree" || exit 2
NODE_EXTRA_CA_CERTS= node --test test/scratch/gate-unban-probe.test.mjs
