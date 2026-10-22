#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5
timeout 30 node read-authority.mjs > authority.json.tmp 2> authority.err && mv authority.json.tmp authority.json; rc=$?; cat authority.err; exit $rc
