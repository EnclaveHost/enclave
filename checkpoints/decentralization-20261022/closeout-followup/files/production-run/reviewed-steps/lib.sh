# lib.sh - sourced by every step script. Pins and small helpers ONLY; sourcing it runs nothing on the VM.
# ROOT ONLY. Each step is run separately, after root has read it:  MRID=<id> bash <step>.sh [args]
set -euo pipefail
set -o noclobber
umask 077
cd /home/steven/Documents/Codex/2026-10-18/wo

P=work/resume-after-checkpoint-20261022/production-run/reviewed-steps
C=work/resume-after-checkpoint-20261022/production-migration-closeout
V=work/resume-after-checkpoint-20261022/controller-bounds-validation
I=work/resume-after-checkpoint-20261022/postgres-init-stage
M=work/claude-resumed-20261022/control-package/storage-migration/controller-profile/migration
B=work/claude-resumed-20261022/storage-enclave-build/out
PF=work/claude-resumed-20261022/control-package/storage-migration-r4/preflight
VMSSH=(ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts
       -i /home/steven/.ssh/minipc storageadmin@127.0.0.1)

# ---- exact pins (sha256)
H_STOCK=2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc     # v26, live /opt/enclave-indexd/indexd
H_FENCE=c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568     # v27
H_C2=2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7        # v28
H_CTL=1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83       # FINAL controller (restore fix + bounds)
H_PROFILE=abcd361224f0ed55e693084e557da5df23bc27ebe6bd127e212daa733de7af3a
H_VMSTATE=5ac71122e2c13bffd53443f040bbc19e6b3dd622162882d19567e5a90efbb616
H_DROPIN=f1597cc26c1a5ad1e86ce9e7c53210792ca2580980d3c9dc537489128f6c9fbb
H_PREFLIGHT=ee359b5775f5fdfee2a09d2540d9654e31e8d61a8b6c285a187576e4daa1e45b
H_EVALUATE=8a827258754a466026c3432951a3f73f3b03be05406005a8c71424fd77a6edde
H_UNIT_OLD=e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012  # live enclave-indexd-postgres.service
H_UNIT_NEW=59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183  # the same + --init
H_PROBE=78db5755fa212b710a1b74199d702fe3378a26bcb928ea20c1697b170a561f61
H_COMPARE=2e56c3a5f0f67951eedd235be4f4bd10c133a71e18c6eeca8a49ef6f327cb2e3
MIGRATION_FILES="digest.sql:7f4b137f7049753df1cc414e89e0fa2da563b84c290cf533d8d2f11765104247
down-27-to-26.sql:2127a7e2fb9f4ccb7d3e9944a913a51fd9eaf8275119a5d683843930e227485c
down-28-to-27.sql:629f186e28a7f48a36e9bd9ac94139e6a3d24c40784fc26c6190075d212cc873
up-26-to-27.sql:8d66b19b542b9b81146250418a5e1521c2fc1fbd7ea687c6ffe20e21d59029e5
up-27-to-28.sql:1043b6452c0279258214ee3527d80d9d2962fea7f3202505acb02b81fc35a225"
IMAGE=postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336

die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
pin() { [ "$(sha256sum "$1" | cut -c1-64)" = "$2" ] || die "local pin mismatch: $1 (want $2)"; }
vm() { local t=$1; shift; timeout -k 10 "$t" "${VMSSH[@]}" "$@"; }     # vm <host-side bound seconds> <remote command>
kv() { python3 -B "$P/check_kv.py" "$@"; }                              # kv <file> key=value ... (exit 1 on any mismatch)

# ---- run identity: ONE id for the whole window, chosen by root (also names the VM directories)
[[ "${MRID:-}" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] ||
  die 'set MRID once for the window: export MRID=$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c "import secrets;print(secrets.token_hex(4))")'
D=/root/indexd-migration/$MRID           # controller, profile and binaries on the VM
VD=/root/pg-init-$MRID                   # the two PostgreSQL units on the VM
CTL=$D/replicactl.py PROF=$D/live-primary.profile.json
RC="sudo /usr/bin/python3 $CTL --profile $PROF"
OUT=$P/runs/$MRID                        # local evidence (no secrets); files are never overwritten
mkdir -p -m 0700 "$P/runs" "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ev() { printf '%s/%s.%s' "$OUT" "$STAMP" "$1"; }                         # a new evidence path for this invocation
marker() { ls "$OUT"/*."$1" >/dev/null 2>&1 || die "missing evidence: no $1 in $OUT (run that step first and read it)"; }

# integration r4 (root, manifest b7d2aae0) is the TESTED gate for controller 1543577f: every result there must have passed
r4_passed() {
  python3 -B - "$V/integration-r4/runs" <<'PY' || die "controller 1543577f is not integration-tested yet (r4 result missing or not passed); see README"
import json, sys
from pathlib import Path
rs = sorted(Path(sys.argv[1]).glob("*.result.json"))
ok = bool(rs) and all((lambda r: r.get("passed") is True and r.get("exit") == 0 and r.get("outcome") == "stages-and-checks-passed"
                       and r.get("cleanup", {}).get("certain") is True)(json.loads(p.read_text())) for p in rs)
print("integration r4:", [p.name for p in rs], "PASS" if ok else "NOT PASSED")
sys.exit(0 if ok else 1)
PY
}

# jl <file> <python expression over r = the LAST JSON object line of the file>  (the expressions are fixed in the steps)
jl() {
  python3 -B -c 'import json, sys
lines = [l for l in open(sys.argv[1], errors="replace") if l.lstrip().startswith("{")]
r = json.loads(lines[-1]) if lines else {}
ok = bool(eval(sys.argv[2], {}, {"r": r}))
print(("  ok   " if ok else "  FAIL ") + sys.argv[2])
sys.exit(0 if ok else 1)' "$@"
}
