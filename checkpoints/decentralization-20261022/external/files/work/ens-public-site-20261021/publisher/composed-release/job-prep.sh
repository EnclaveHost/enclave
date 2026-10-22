#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/composed-release
node release-prep.mjs ipns-publisher-ensrepair.wasm > release-prep.json; rc=$?; echo rc=$rc; exit $rc
