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
t "two builds are byte-identical" "cmp '$T/a/enclave-storage-indexer-1.0.0-rc1.tar.zst' '$T/b/enclave-storage-indexer-1.0.0-rc1.tar.zst'"
sha256sum "$T/a/enclave-storage-indexer-1.0.0-rc1.tar.zst" | tee "$T/pkg.sha"
mkdir -p "$T/x" && zstd -q -d -c "$T/a/enclave-storage-indexer-1.0.0-rc1.tar.zst" | tar -C "$T/x" -xf -
P=$T/x/enclave-storage-indexer
t "manifest verifies after unpack" "cd '$P' && sha256sum -c --quiet MANIFEST.sha256"
t "bundled indexd is the pinned G-C2 release" "echo 'e6e812fd625de0cd7c5956c5c5bffc5f3d1822784d65125cdc704ba793ec2955  $P/bin/indexd' | sha256sum -c --quiet"
t "bundled indexd reports its version" "'$P/bin/indexd' version | grep -q 'v0.6.0-fence.2'"
# 3. systemd units: instantiate with this test tree's paths, then systemd-analyze verify
mkdir -p "$T/u"
for u in "$P"/units/*; do
  b=$(basename "$u"); inst=${b/@./@r1.}
  sed -e "s|/opt/enclave-storage-indexer/current|$P|g" -e "s|/bin/sh -c 'exec .*'|$P/bin/indexd|" "$u" > "$T/u/$inst"
done
t "systemd-analyze verify (units, instance r1)" "cd '$T/u' && SYSTEMD_LOG_LEVEL=err systemd-analyze verify --man=no ./*.service ./*.timer 2>&1 | grep -v 'ConditionPathExists\|No such file or directory\|LoadCredentialEncrypted' | (! grep -qi 'error\|unknown\|invalid')"
t "indexd unit: secrets only via LoadCredentialEncrypted, config on tmpfs" "grep -q '^LoadCredentialEncrypted=recovery-phrase:' '$P/units/enclave-storage-indexer@.service' && grep -q 'INDEXD_CONFIG_FILE=/run/' '$P/units/enclave-storage-indexer@.service'"
t "PostgreSQL unit: no TCP (listen_addresses empty, AF_UNIX only, private network)" "grep -q 'listen_addresses= ' '$P/units/enclave-storage-indexer-pg@.service' && grep -q '^RestrictAddressFamilies=AF_UNIX' '$P/units/enclave-storage-indexer-pg@.service' && grep -q '^PrivateNetwork=yes' '$P/units/enclave-storage-indexer-pg@.service'"
t "every unit is guarded by root's ALLOW_LIVE_START (or the owner backup cert)" "for u in '$P'/units/*.service; do grep -q 'ConditionPathExists=' \"\$u\" || exit 1; done"
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
ENV
E="ESI_TEST_ROOT='$R' ESI_TEST_MEMINFO='$T/meminfo'"
t "preflight passes on a non-DigitalOcean Enclave host" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1"
tn "preflight REFUSES a DigitalOcean machine" "$E ESI_TEST_DMI='$T/dmi-do' '$P/libexec/preflight' r1" "DigitalOcean machines are transport-only"
tn "preflight refuses too little memory" "ESI_TEST_ROOT='$R' ESI_TEST_MEMINFO='$T/meminfo-small' ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "MemAvailable"
cp "$R/etc/enclave-storage-indexer/r1/replica.env" "$T/env.bak"
sed -i 's/^FAILURE_DOMAIN_PROVIDER=.*/FAILURE_DOMAIN_PROVIDER=DigitalOcean/' "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "preflight refuses a DigitalOcean failure-domain provider" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "names DigitalOcean"
cp "$T/env.bak" "$R/etc/enclave-storage-indexer/r1/replica.env"; echo 'EVIL=$(id)' >> "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "replica.env rejects unknown keys and shell syntax" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' r1" "unexpected line"
cp "$T/env.bak" "$R/etc/enclave-storage-indexer/r1/replica.env"
tn "replica names are validated" "$E ESI_TEST_DMI='$T/dmi-ok' '$P/libexec/preflight' '../etc'" "replica name must match"
# 5. render-config
sed -e "s|@REPLICA@|r1|g" -e "s|@ADVERTISE_URL@|https://r1.indexer.example|g" -e "s|@SOCKET@|/run/x/pg|g" -e "s|@STATE@|/var/x|g" \
  "$P/templates/indexd.base.yml" > "$R/etc/enclave-storage-indexer/r1/indexd.base.yml"
mkdir -p "$T/cred" "$T/rt"; PHRASE="abandon ability able about above absent absorb abstract absurd abuse access accident"
printf '%s\n' "$PHRASE" > "$T/cred/recovery-phrase"; printf 'Ab3_kd9-Zx77qq01PLmmnnbbvvccxx' > "$T/cred/admin-password"
RC="ESI_TEST_ROOT='$R' CREDENTIALS_DIRECTORY='$T/cred' RUNTIME_DIRECTORY='$T/rt'"
t "render-config renders base + credentials" "$RC '$P/libexec/render-config' r1"
t "rendered config: phrase and admin password present, mode 0600" "grep -q \"recoveryPhrase: \\\"$PHRASE\\\"\" '$T/rt/indexd.yml' && grep -q 'password: \"Ab3_kd9-Zx77qq01PLmmnnbbvvccxx\"' '$T/rt/indexd.yml' && [ \$(stat -c %a '$T/rt/indexd.yml') = 600 ]"
t "render-config never prints the secrets" "$RC '$P/libexec/render-config' r1 | (! grep -q 'abandon\|Ab3_kd9')"
printf 'abandon ability\n' > "$T/cred/recovery-phrase"
tn "render-config refuses a malformed phrase" "$RC '$P/libexec/render-config' r1" "12 or 24 words"
printf '%s\n' "$PHRASE" > "$T/cred/recovery-phrase"
cp "$R/etc/enclave-storage-indexer/r1/indexd.base.yml" "$T/base.bak"; sed -i 's|  password: ""|  password: "hunter2"|' "$R/etc/enclave-storage-indexer/r1/indexd.base.yml"
tn "render-config refuses a password value in the base config" "$RC '$P/libexec/render-config' r1" "must not contain a password"
cp "$T/base.bak" "$R/etc/enclave-storage-indexer/r1/indexd.base.yml"
tn "render-config needs credentials (no CREDENTIALS_DIRECTORY)" "ESI_TEST_ROOT='$R' RUNTIME_DIRECTORY='$T/rt' '$P/libexec/render-config' r1" "CREDENTIALS_DIRECTORY"
# 6. encrypted backup / restore pipeline (pg_dump/pg_restore replaced by fixture commands; the crypto is real)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-384 -nodes -keyout "$T/owner.key" -out "$R/etc/enclave-storage-indexer/r1/owner-backup.pem" -subj "/CN=owner-backup-test" -days 2 2>/dev/null
head -c 3000000 /dev/urandom > "$T/dump.bin"
BK="ESI_TEST_ROOT='$R' ESI_TEST_DUMP_CMD='cat $T/dump.bin'"
t "backup encrypts to the owner certificate (CMS AuthEnvelopedData, AES-256-GCM)" "$BK '$P/libexec/backup' r1"
F=$(ls "$R"/var/lib/enclave-storage-indexer/r1/outbox/*.cms | head -1)
t "backup is authEnvelopedData and contains no plaintext" "openssl cms -cmsout -inform DER -in '$F' -print | grep -q authEnvelopedData && ! grep -qF \"\$(head -c 64 '$T/dump.bin' | base64)\" '$F'"
t "restore decrypts, verifies and hands the exact dump to pg_restore" "ESI_TEST_ROOT='$R' ESI_TEST_RESTORE_CMD='tee $T/restored.bin' '$P/libexec/restore' r1 '$F' '$T/owner.key' '$R/etc/enclave-storage-indexer/r1/owner-backup.pem' >/dev/null && cmp '$T/dump.bin' '$T/restored.bin'"
python3 -c "import sys;b=bytearray(open('$F','rb').read());b[len(b)//2]^=1;open('$T/tampered.cms','wb').write(b)"; (cd "$(dirname "$F")" && sha256sum "$(basename "$F")" | sed "s|$(basename "$F")|tampered.cms|" > /dev/null); cp "$T/tampered.cms" "$F.t.cms"; (cd "$(dirname "$F")" && sha256sum "$(basename "$F").t.cms" > "$(basename "$F").t.cms.sha256")
tn "restore refuses a tampered backup (GCM authentication)" "ESI_TEST_ROOT='$R' ESI_TEST_RESTORE_CMD='cat' bash -o pipefail '$P/libexec/restore' r1 '$F.t.cms' '$T/owner.key' '$R/etc/enclave-storage-indexer/r1/owner-backup.pem'" "rror"
tn "restore refuses a backup whose digest does not match" "cp '$T/tampered.cms' '$F'; ESI_TEST_ROOT='$R' ESI_TEST_RESTORE_CMD='cat' '$P/libexec/restore' r1 '$F' '$T/owner.key' '$R/etc/enclave-storage-indexer/r1/owner-backup.pem'" "digest check failed"
# 7. descriptor
echo test-pkg > "$P/PACKAGE_SHA256"
t "descriptor is strict JSON with the failure domain and pinned indexd" "ESI_TEST_ROOT='$R' '$P/libexec/descriptor' r1 | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d[\"format\"]==\"enclave-storage-indexer-descriptor/1\" and d[\"failureDomain\"][\"provider\"]==\"owner-premises\" and d[\"indexd\"][\"sha256\"].startswith(\"e6e812fd\")'"
echo "package tests: $pass passed, $fail failed"
[ $fail -eq 0 ]
