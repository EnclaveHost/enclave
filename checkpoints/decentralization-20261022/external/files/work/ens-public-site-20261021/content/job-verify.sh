#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/content
node verify-export.mjs site.car export > verify.json; rc=$?; echo rc=$rc; exit $rc
