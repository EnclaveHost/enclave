#!/usr/bin/env bash
# ONE terminal job: the revision2 tree (all suites + the candidate bundle) and the live-baseline candidate tree
R="$(cd "$(dirname "$0")" && pwd)"
echo "######## revision2/tree"; "$R/run-all.sh"
echo "######## revision2/tree-live"; "$R/run-live.sh"
