#!/bin/bash
# Package tests (no root, no PostgreSQL server, no production): reproducible build, manifest, units, preflight rules,
# credential rendering, encrypted backup/restore pipeline, descriptor. Prints PASS/FAIL per test; exit 1 on any FAIL.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1${2:+: $2}"; fail=$((fail+1)); }
t() { if eval "$2" >"$T/out" 2>&1; then ok "$1"; else no "$1" "$(tail -3 "$T/out" | tr '\n' ' ')"; fi; }
tn() { if eval "$2" >"$T/out" 2>&1; then no "$1" "unexpected success"; else grep -q -- "$3" "$T/out" && ok "$1" || no "$1" "missing '$3': $(tail -2 "$T/out" | tr '\n' ' ')"; fi; }

# 1. syntax of every script
for f in "$here"/libexec/* "$here"/build.sh; do t "bash -n $(basename "$f")" "bash -n '$f'"; done
# 2. reproducible build
t "build A" "'$here/build.sh' '$T/a'"
t "build B" "'$here/build.sh' '$T/b'"
t "two builds are byte-identical" "cmp '$T/a/enclave-storage-indexer-1.0.0-rc2.tar.zst' '$T/b/enclave-storage-indexer-1.0.0-rc2.tar.zst'"
sha256sum "$T/a/enclave-storage-indexer-1.0.0-rc2.tar.zst" | tee "$T/pkg.sha"
mkdir -p "$T/x" && zstd -q -d -c "$T/a/enclave-storage-indexer-1.0.0-rc2.tar.zst" | tar -C "$T/x" -xf -
P=$T/x/enclave-storage-indexer
t "manifest verifies after unpack" "cd '$P' && sha256sum -c --quiet MANIFEST.sha256"
t "bundled indexd is the pinned G-C2 release" "echo 'e6e812fd625de0cd7c5956c5c5bffc5f3d1822784d65125cdc704ba793ec2955  $P/bin/indexd' | sha256sum -c --quiet"
t "bundled indexd reports its version" "'$P/bin/indexd' version | grep -q 'v0.6.0-fence.2'"
# 3. the ONE unit runs the host software's gated supervisor; nothing in the package starts PostgreSQL or indexd itself
U=$P/units/enclave-storage-indexer-host@.service
t "exactly one unit: enclave-storage-indexer-host@.service" "[ \$(ls '$P'/units | wc -l) = 1 ] && [ -f '$U' ]"
t "the unit runs the supervisor (platform host policy gate) and nothing else" "grep -q '^ExecStart=/usr/bin/node \${ENCLAVE_HOST_SOFTWARE}/network/host-services/storage-indexer-host.mjs run ' '$U' && [ \$(grep -c '^ExecStart=' '$U') = 1 ]"
t "no file in the package starts a PostgreSQL server or indexd itself (preflight only asks postgres --version)" "! grep -rlE '(postgres[^ ]* +-D|pg_ctl|bin/indexd)' '$P'/units '$P'/libexec"
t "secrets only as encrypted credentials; memory capped; no swap" "grep -q '^LoadCredentialEncrypted=recovery-phrase:' '$U' && grep -q '^LoadCredentialEncrypted=admin-password:' '$U' && grep -q '^MemoryMax=2304M' '$U' && grep -q '^MemorySwapMax=0' '$U'"
mkdir -p "$T/u"; sed -e "s|/opt/enclave-storage-indexer/current|$P|g" -e "s|^ExecStart=.*|ExecStart=$P/bin/indexd|" "$U" > "$T/u/enclave-storage-indexer-host@r1.service"
t "systemd-analyze verify (instance r1)" "cd '$T/u' && SYSTEMD_LOG_LEVEL=err systemd-analyze verify --man=no ./*.service 2>&1 | grep -v 'No such file or directory\|LoadCredentialEncrypted\|EnvironmentFile' | (! grep -qi 'error\|unknown\|invalid')"
t "host.json template is strict JSON with platformHostPolicy production" "python3 -c 'import json; d=json.load(open(\"$P/templates/host.json.template\")); assert d[\"platformHostPolicy\"]==\"production\" and d[\"format\"]==\"enclave-storage-indexer-host/v1\"'"
# 4. preflight
R=$T/root; mkdir -p "$R/etc/enclave-storage-indexer/r1" "$T/dmi-do" "$T/dmi-ok" "$T/pg"
printf 'DigitalOcean\n' > "$T/dmi-do/sys_vendor"; printf 'ASUSTeK COMPUTER INC.\n' > "$T/dmi-ok/sys_vendor"
printf '#!/bin/sh\necho "postgres (PostgreSQL) 18.6"\n' > "$T/pg/postgres"; chmod +x "$T/pg/postgres"
printf 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\n' > "$T/meminfo"; printf 'MemTotal: 1000000 kB\nMemAvailable: 300000 kB\n' > "$T/meminfo-small"
cat > "$R/etc/enclave-storage-indexer/r1/replica.env" <<ENV
REPLICA=r1
ADVERTISE_URL=https://r1.indexer.example
ENCLAVE_HOST_ID=0x$(printf 'ab%.0s' $(seq 1 32))
FAILURE_DOMAIN_SITE=site-a
FAILURE_DOMAIN_PROVIDER=owner-premises
FAILURE_DOMAIN_POWER=grid-a
PG_BIN=$T/pg
ENCLAVE_HOST_SOFTWARE=$T/hostsw
ENV
mkdir -p "$T/hostsw/network/host-services"; touch "$T/hostsw/network/host-services/storage-indexer-host.mjs" "$T/hostsw/network/host-service-gate.mjs"
E="ESI_TEST_ROOT='$R' ESI_TEST_MEMINFO='$T/meminfo'"
t "preflight passes on a non-DigitalOcean Enclave host" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1"
tn "preflight REFUSES a DigitalOcean machine" "$E ESI_TEST_DMI='$T/dmi-do' '$P/libexec/preflight' r1" "DigitalOcean machines are transport-only"
tn "preflight refuses too little memory" "ESI_TEST_ROOT='$R' ESI_TEST_MEMINFO='$T/meminfo-small' ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "MemAvailable"
cp "$R/etc/enclave-storage-indexer/r1/replica.env" "$T/env.bak"
sed -i 's/^FAILURE_DOMAIN_PROVIDER=.*/FAILURE_DOMAIN_PROVIDER=DigitalOcean/' "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "preflight refuses a DigitalOcean failure-domain provider" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "names DigitalOcean"
cp "$T/env.bak" "$R/etc/enclave-storage-indexer/r1/replica.env"; echo 'EVIL=$(id)' >> "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "replica.env rejects unknown keys and shell syntax" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "unexpected line"
cp "$T/env.bak" "$R/etc/enclave-storage-indexer/r1/replica.env"; sed -i 's|^ENCLAVE_HOST_SOFTWARE=.*|ENCLAVE_HOST_SOFTWARE=/nonexistent|' "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "preflight refuses without the Enclave host software's supervisor and gate" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "ENCLAVE_HOST_SOFTWARE must point"
cp "$T/env.bak" "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "replica names are validated" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' '../etc'" "replica name must match"
# 5-7. credential rendering, backup/restore and the descriptor moved into the supervisor; they are exercised against
#      a real PostgreSQL 18 + indexd by test/storage-indexer-host.test.mjs (work/storage-host-role/tree)
echo "package tests: $pass passed, $fail failed"
[ $fail -eq 0 ]
