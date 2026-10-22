#!/bin/bash
# Root continuation after layout stopped at the local hash-key parser (hyphen was rejected).
# Only the four staging files exist; no release layout/service changes were attempted.
source "$(dirname "$0")/lib.sh"
f=$(ls "$OUT"/*.20.staged.out)
kv "$f" replicactl.py="$H_CTL" live-primary.profile.json="$H_PROFILE" fence.indexd="$H_FENCE" c2.indexd="$H_C2" || die "staged hashes differ"
say "L1. migration files (root:root 0644, dir 0755)"
vm 60 'sudo install -d -o root -g root -m 0755 /opt/enclave-indexd/migration' || die "mkdir migration"
while IFS=: read -r name h; do
  vm 60 "sudo sh -c 'set -C; umask 022; cat > /opt/enclave-indexd/migration/$name'" < "$M/$name" || die "staging $name failed"
done <<< "$MIGRATION_FILES"
f=$(ev 20.migration.out)
vm 60 "cd /opt/enclave-indexd/migration && sudo sha256sum * | awk '{print \$2\"=\"\$1}'" > "$f"
kv "$f" $(printf '%s\n' "$MIGRATION_FILES" | tr ':' '=') || die "migration file hashes differ"

say "L2. releases (umask 022): stock from the LIVE binary, then fence, then c2"
for spec in "/opt/enclave-indexd/indexd:$H_STOCK" "$D/fence.indexd:$H_FENCE" "$D/c2.indexd:$H_C2"; do
  f=$(ev "20.install-${spec##*:}.json")
  vm 120 "sudo sh -c 'umask 022; /usr/bin/python3 $CTL --profile $PROF install ${spec%%:*} --sha256 ${spec##*:} --confirm install'" > "$f" || true
  jl "$f" "r.get('ok') is True" || die "install ${spec##*:} failed: see $f"
done

say "L3. current -> stock (relative; ln refuses an existing name)"
vm 30 "sudo ln -s $H_STOCK /opt/enclave-indexd/releases/current" || die "ln current failed"

say "L4. access: dirs and binaries 755 root:root; the service user can execute current"
f=$(ev 20.access.out)
vm 60 'sudo stat -c "%a %U:%G %n" /opt/enclave-indexd/releases /opt/enclave-indexd/releases/*/ /opt/enclave-indexd/releases/*/indexd
  sudo -u enclave-indexd test -x /opt/enclave-indexd/releases/current/indexd && echo exec-ok' > "$f" || true
cat "$f"
grep -qx exec-ok "$f" && ! grep -v -e '^755 root:root ' -e '^exec-ok$' "$f" | grep -q . || die "release permissions not as required"

say "L5. drop-in (next start uses releases/current), daemon-reload only"
vm 30 'sudo install -d -m 0755 /etc/systemd/system/enclave-indexd.service.d' || die "mkdir drop-in dir"
vm 30 "sudo sh -c 'set -C; umask 022; cat > /etc/systemd/system/enclave-indexd.service.d/20-fence-release.conf'" < work/indexd-replica-rollout/systemd/primary-upgrade.conf || die "drop-in exists?"
f=$(ev 20.dropin.out)
vm 60 'sudo systemctl daemon-reload
  echo "dropin=$(sudo sha256sum /etc/systemd/system/enclave-indexd.service.d/20-fence-release.conf | cut -c1-64)"
  echo "execPath=$(systemctl show enclave-indexd -p ExecStart --value | grep -o "path=[^ ;]*")"
  for k in NeedDaemonReload ActiveState SubState; do echo "$k=$(systemctl show enclave-indexd -p $k --value)"; done' > "$f" || true
kv "$f" dropin="$H_DROPIN" execPath=path=/opt/enclave-indexd/releases/current/indexd NeedDaemonReload=no ActiveState=active SubState=running ||
  die "drop-in not effective or indexd disturbed"

say "L6. credential file (never printed), backup dir, controller preflight + readiness"
vm 30 "sudo python3 -c 'import yaml,os; c=yaml.safe_load(open(\"/etc/enclave-indexd/indexd.yml\")); fd=os.open(\"/root/indexd-migration/admin.pass\", os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600); os.write(fd, c[\"adminAPI\"][\"password\"].encode()); os.close(fd)'" ||
  die "admin.pass not created (exists already?)"
vm 30 'sudo install -d -o root -g root -m 0700 /var/lib/enclave-indexd/migration-backups' || die "backup dir"
f=$(ev 20.preflight.json); vm 120 "$RC preflight" > "$f" || true
jl "$f" "r.get('ok') is True and r['checks']['release'] == '$H_STOCK'" || die "controller preflight not ok: see $f"
f=$(ev 20.readiness.json); vm 120 "$RC readiness --expect-version 26" > "$f" || true
jl "$f" "r.get('ok') is True and r.get('dbVersion') == 26 and isinstance(r.get('fenceRoute'), int)" ||
  die "readiness not ok (a non-integer fenceRoute = wrong app_url): see $f"

say "L7. BASELINE (read-only): readiness, digest, unit restarts/warnings"
vm 120 "$RC readiness --expect-version 26" > "$(ev 20.baseline-readiness.json)" || die "baseline readiness"
vm 300 "$RC digest" > "$(ev 20.baseline-digest.json)" || die "baseline digest"
vm 60 'echo "NRestarts=$(systemctl show enclave-indexd -p NRestarts --value)"; echo "warnings30min=$(journalctl -u enclave-indexd --since -30min -p warning --no-pager -q | wc -l)"' > "$(ev 20.baseline-unit.out)"
cat "$OUT"/*.20.baseline-unit.out
echo "Record root's usual app smoke (sia-s3 signed /?sia-diag) now as the baseline, PASS or FAIL. It never gates a step."

date -u +%FT%TZ > "$(ev 20.PASS)"
say "LAYOUT PASS. indexd still serves stock 2d7a637e. Next (after reading): 30-upgrade-v27.sh"
