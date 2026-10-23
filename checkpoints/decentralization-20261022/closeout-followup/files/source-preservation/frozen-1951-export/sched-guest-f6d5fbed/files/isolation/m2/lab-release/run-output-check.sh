#!/usr/bin/env bash
# Does anything an APP prints reach the host? On real SEV-SNP, with a positive control (Codex's decision on the release's
# app-output property, 2026-09-25).
#
#   the app      = sentinel-app (this dir): a wasi:cli command serving HTTP that prints sentinels on stdout and stderr at
#                  start and per request (with the request path), and panics on /panic… (the runtime prints the panic);
#                  every sentinel carries a tag random to this run
#   guest NEW    = THIS tree's image (dominit gives the app /dev/null): a non-deployment guest (no HOST_DATA, no release)
#   guest OLD    = 0181bce3's image (the app inherits the console): the POSITIVE CONTROL, a legacy deployment guest on the
#                  same -release guestd with a synthetic deployment id
#   PASS         = the OLD guest's serial shows the sentinels (the check can see a leak), and NOTHING from the NEW guest -
#                  its serial, its unit's journal, guestd's log lines and view for it - carries the tag, while its
#                  control lines (DOM serving, DOM started, DOM ERROR app exited) are all there
#
# SAFETY (enclave-d1's lab conditions, as run-legacy-check.sh): -instance-prefix lb, lab vsock ports (bind-probed),
# MemAvailable >= 44 GiB, the m2-gd* units recorded before and after (a change is FATAL), every process running from the
# run dir ended at cleanup. No config, secret, ticket or relay is involved.
#
# usage: bash isolation/m2/lab-release/run-output-check.sh
set -euo pipefail
# the releases the legacy tree (0181bce3) was installed from, DERIVED from their release.json (guestd refuses a pre-chain
# tree named any other way): 5c3561f9 and 6f14ce75
LEGACY_RELEASES=${LEGACY_RELEASES:-@$HOME/enclave-prod/release-0181bce3/release.json,@$HOME/enclave-prod/release-6757d139/release.json}
HERE=$(cd "$(dirname "$0")" && pwd)
ISO=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$ISO/.." && pwd)
L=${LAB_DIR:-$HOME/enclave-bench/lab-release/output-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$L"; chmod 700 "$L"
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$L/run.txt"; }
LEGACY_COMMIT=0181bce3aac5fa03dfaf2928d834ecd04d2a4a73
TAG=SNTL$(openssl rand -hex 6)
PIDS=(); VMS=()
lab_procs() { for d in /proc/[0-9]*; do case "$(readlink "$d/exe" 2>/dev/null)" in "$L"/*) echo "${d#/proc/}";; esac; done; }
cleanup() {
  set +e
  for vm in "${VMS[@]}"; do curl -s -m 30 -X DELETE "http://127.0.0.1:18095/vms/$vm" > /dev/null; done
  sleep 3
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  systemctl --user list-units --plain --no-legend --all 'm2-lb*' | awk '{print $1}' | while read -r u; do
    [ -n "$u" ] && systemctl --user stop "$u"; done
  for p in $(lab_procs); do kill "$p" 2>/dev/null; done
  sleep 1
  if [ -n "$(lab_procs)" ]; then say "FAIL: lab processes outlived cleanup: $(lab_procs | tr '\n' ' ')"; exit 1; fi
  systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-after.txt"
  if ! diff -q "$L/prod-units-before.txt" "$L/prod-units-after.txt" > /dev/null; then
    say "FAIL: the production m2-gd* units CHANGED during the lab (see prod-units-*.txt)"; exit 1
  fi
  say "cleanup done; production m2-gd* units unchanged"
}

# ---- 0. the shared host ----
case "$ISO" in "$HOME"/enclave-prod/*) echo "this is a production tree ($ISO): run the lab from a lab worktree" >&2; exit 1 ;; esac
if [ -n "$(systemctl --user list-units --plain --no-legend --all 'm2-lb*')" ]; then
  echo "m2-lb* units exist already: another lab is running; refusing" >&2; exit 1
fi
[ -z "$(ss -ltnH 'sport = :18095' 2>/dev/null)" ] || { echo "127.0.0.1:18095 is already held; refusing" >&2; exit 1; }
( cd "$ISO/m2" && go build -o "$L/portprobe" ./lab-release/portprobe )
"$L/portprobe" 19444 19445 || { echo "a lab vsock port is already held; refusing" >&2; exit 1; }
avail=$(awk '/^MemAvailable:/ {print int($2/1024/1024)}' /proc/meminfo)
[ "$avail" -ge 44 ] || { echo "MemAvailable ${avail} GiB: under the 40 GiB guard plus the lab's 4 GiB; refusing" >&2; exit 1; }
systemctl --user list-units --plain --no-legend --all 'm2-gd*' | awk '{print $1, $3, $4}' > "$L/prod-units-before.txt"
trap cleanup EXIT
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
say "app-output lab $L; tag $TAG; production units before: $(wc -l < "$L/prod-units-before.txt"); MemAvailable ${avail} GiB"
say "this tree: $(git -C "$REPO" rev-parse --short HEAD) (the NEW image); positive control: ${LEGACY_COMMIT:0:8}'s image"

# ---- 1. the sentinel app, tagged for this run, as a wasi:cli bundle serving HTTP on 8000 ----
( cd "$HERE/sentinel-app" && SENTINEL_TAG=$TAG CARGO_TARGET_DIR="$L/cargo" cargo build --release --target wasm32-wasip2 -q )
cp "$L/cargo/wasm32-wasip2/release/sentinel-app.wasm" "$L/app.wasm"
( cd "$ISO/contract" && go run ./cmd/bundle build -label sentinel -world wasi:cli -http 8000 -mem 128 "$L/app.wasm" "$L/app.bundle" ) | tee -a "$L/run.txt"
grep -q "$TAG" "$L/app.wasm" || { say "FAIL: the tag is not in the app"; exit 1; }

# ---- 2. the lab guestd: this tree, -release, the 0181bce3 archive as its legacy tree ----
mkdir -p "$L/legacy"
git -C "$REPO" archive "$LEGACY_COMMIT" isolation relay test/fixtures/amd | tar -x -C "$L/legacy"
( cd "$ISO/m4/guestd" && GOFLAGS= go build -trimpath -o "$L/guestd" . )
GUESTD_ENABLE=1 "$L/guestd" -isolation "$ISO" -root "$L/guestd-root" -listen 127.0.0.1:18095 \
  -release -isolation-release none -legacy-isolation "$L/legacy/isolation" -legacy-isolation-release "$LEGACY_RELEASES" -instance-prefix lb \
  -ticket-port 19444 -egress-port 19445 -guest-mem-mib 4096 -guest-cpus 2 > "$L/guestd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf -m 2 http://127.0.0.1:18095/health > /dev/null 2>&1 && break; sleep 1; done

# ---- 3. the two guests ----
create() {  # name -> vm id
  curl -sS -m 600 -X POST http://127.0.0.1:18095/vms -H 'content-type: application/json' \
    -d "{\"image\":\"file://$L/app.bundle\",\"name\":\"$1\"}" > "$L/create-$2.json" || true
  node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).id||"")}catch{console.log("")}' "$L/create-$2.json"
}
view() { curl -sf -m 5 "http://127.0.0.1:18095/vms/$1" > "$L/vm-$2.json" 2>/dev/null || true
         node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(o[process.argv[2]]??"")}catch{console.log("")}' "$L/vm-$2.json" "$3"; }
NEW=$(create "sentinel-new" new)
[ -n "$NEW" ] || { say "FAIL: the NEW guest was refused: $(head -c 300 "$L/create-new.json")"; exit 1; }
VMS+=("$NEW")
OLD_ID=0x$(printf 'enclave-5d app-output lab %s' "$TAG" | sha256sum | cut -c1-64)
OLD=$(create "$OLD_ID" old)
[ -n "$OLD" ] || { say "FAIL: the OLD (control) guest was refused: $(head -c 300 "$L/create-old.json")"; exit 1; }
VMS+=("$OLD")
for g in new old; do
  vm=$([ $g = new ] && echo "$NEW" || echo "$OLD")
  for _ in $(seq 1 300); do st=$(view "$vm" $g status); case "$st" in running|failed) break ;; esac; sleep 2; done
  say "guest $g $vm: status $st, legacyImage $(view "$vm" $g legacyImage), hostPort $(view "$vm" $g hostPort)"
  [ "$st" = running ] || { say "FAIL: guest $g did not run: $(view "$vm" $g error | head -c 300)"; exit 1; }
done

# ---- 4. requests carrying the tag (tenant data), then a panic, to each ----
for g in new old; do
  vm=$([ $g = new ] && echo "$NEW" || echo "$OLD"); port=$(view "$vm" $g hostPort)
  c1=$(curl -sk -m 20 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/req-$TAG-$g" || true)
  c2=$(curl -sk -m 20 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/panic-$TAG-$g" || true)
  say "guest $g: request HTTP $c1, panic request HTTP $c2"
  [ "$c1" = 200 ] || { say "FAIL: guest $g's app did not answer"; exit 1; }
done
# the panic ends each app, and init powers its domain off; wait for both to be gone
for g in new old; do
  vm=$([ $g = new ] && echo "$NEW" || echo "$OLD")
  for _ in $(seq 1 60); do st=$(view "$vm" $g status); [ "$st" = running ] || break; sleep 2; done
  say "guest $g after the panic: status ${st:-gone}"
done
sleep 3

# ---- 5. what reached the host ----
serial_of() { find "$L/guestd-root" -name '*.serial' -path "*$1*" 2>/dev/null | head -1; }
SN=$(serial_of "$NEW"); SO=$(serial_of "$OLD")
[ -n "$SN" ] && [ -n "$SO" ] || { say "FAIL: a serial file is missing (new=$SN old=$SO)"; exit 1; }
cp "$SN" "$L/serial-new.txt"; cp "$SO" "$L/serial-old.txt"
# each guest is its own unit (m2-<vm id>-<pid>): the NEW guest's journal is read alone, since both apps print the same
# start sentinels and a shared log could not say whose a line was
journalctl --user --since "$T0" -u "m2-$NEW-*" --no-pager -o cat > "$L/journal-new.txt" 2>/dev/null || true
journalctl --user --since "$T0" -u "m2-$OLD-*" --no-pager -o cat > "$L/journal-old.txt" 2>/dev/null || true
grep -h "$NEW" "$L/guestd.log" > "$L/guestd-new-lines.txt" || true
fail=0
# the positive control: the OLD image's app output reaches the serial file, so this check can see a leak
for s in "$TAG-STDOUT-START" "$TAG-STDERR-START" "$TAG-STDOUT-REQ /req-$TAG-old" "$TAG-PANIC /panic-$TAG-old"; do
  if grep -aq -- "$s" "$L/serial-old.txt"; then say "ok   control: the OLD image's serial shows \"$s\""; else say "FAIL control: \"$s\" is not in the OLD image's serial (the check would see nothing)"; fail=1; fi
done
# the NEW image: nothing tagged anywhere the host holds for it. The serial file is the channel the control PROVES; the
# journal and guestd's log are checked too, but on this host neither carries a guest's console at all (the control's
# sentinels are not there either), so a clean result there is reported as such, not as a pass of its own
for f in "$L/serial-new.txt" "$L/journal-new.txt" "$L/guestd-new-lines.txt" "$L/vm-new.json"; do
  if grep -aq -- "$TAG" "$f"; then say "FAIL the tag reached the host in $(basename "$f")"; fail=1
  elif [ "$f" != "$L/serial-new.txt" ] && [ "$f" != "$L/vm-new.json" ] && ! grep -aq -- "$TAG" "${f/new/old}" 2>/dev/null; then
    say "ok   no tag in $(basename "$f") (not a channel here: the control's output is absent from it too)"
  else say "ok   no tag in $(basename "$f")"; fi
done
# and the requests sent ONLY to the new guest appear nowhere the host keeps: the run dir or the whole user journal
if grep -rlaq --exclude=app.wasm --exclude=app.bundle --exclude-dir=cargo --exclude-dir=legacy -- "req-$TAG-new\|panic-$TAG-new" "$L" \
   || journalctl --user --since "$T0" --no-pager -o cat 2>/dev/null | grep -aq -- "req-$TAG-new\|panic-$TAG-new"; then
  say "FAIL a request sent only to the new guest reached the host"; fail=1
else say "ok   the new guest's requests appear nowhere on the host (run dir, whole user journal)"; fi
# ... while its control lines are intact
for s in "DOM serving" "DOM started app=" "DOM app config: none" "DOM ERROR app exited"; do
  if grep -aq -- "$s" "$L/serial-new.txt"; then say "ok   NEW serial keeps \"$s\""; else say "FAIL NEW serial lacks \"$s\""; fail=1; fi
done
grep -a '^DOM ' "$L/serial-new.txt" > "$L/serial-new-dom.txt" || true
if [ "$fail" = 0 ]; then say "OUTPUT CHECK PASS: the control leaks (old image), the new image leaks nothing tagged, and its control lines stand"; else say "OUTPUT CHECK FAIL"; exit 1; fi
