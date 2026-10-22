#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021
cd "$H/compose"
SERVICE_TLS_TMP=$H/logs node --test --test-timeout=120000 test/service-tls.test.mjs > "$H/logs/c-service-tls-final.out" 2>&1; echo "service-tls rc=$? $(grep -E '^# (pass|fail|skipped)' "$H/logs/c-service-tls-final.out" | tr '\n' ' ')"
cd "$H" && python3 - <<'PY'
import importlib.util, pathlib, subprocess, sys
H = pathlib.Path('.').resolve(); R = H.parent / 'resume-20261021/hs2-activation-prep/review-fix'
sys.path.insert(0, str(R)); spec = importlib.util.spec_from_file_location('h', R / 'root-hs2-activate.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
acl = subprocess.run(['node','--input-type=module','-e',"import { ACL_PS } from './network/host-services/service-tls.mjs'; process.stdout.write(ACL_PS)"], cwd=H/'compose', capture_output=True, text=True, check=True).stdout
script = "$env:ENCLAVE_KEY_DIR='C:\\ProgramData\\Enclave\\host-services\\hs2\\state';$aclLine=(& {" + acl + "});" + "x"*600
print('acl-proof encoded chars (upper bound) =', len(m.encoded(script, 60)), 'limit', 7800)
PY
