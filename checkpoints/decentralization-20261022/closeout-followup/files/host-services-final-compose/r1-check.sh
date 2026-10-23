#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose
git -C candidate rev-parse HEAD 'HEAD^{tree}' HEAD^1 HEAD^2
(cd release && sha256sum -c --quiet ../release.sha256) && echo RELEASE_OK
sha256sum -c --quiet <(sed 's|  |  candidate/|' node-deploy-files.sha256) && echo CLOSURE_OK
