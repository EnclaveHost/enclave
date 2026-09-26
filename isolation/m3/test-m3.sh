#!/bin/sh
# Milestone 3a tests (isolation/m3/PLAN.md): SEVERAL app domains inside ONE measured guest, each
# serving its own port with TLS ending inside it, and each attested by name — where the name comes from
# the MONITOR rather than from the launch measurement.
#
# The point of M3a is the identity change that a VMPL design forces (PLAN.md section 3): the app is no
# longer in the launch digest, so a verifier learns which app it is talking to because VMPL0 code — in
# the digest — hashed the app it loaded and wrote that hash into report_data. Check 2 is the one that
# shows the old property is gone and the new one has replaced it.
#
# What separates domains HERE is the guest kernel (namespaces, uid, cgroup): WEAKER than the VMPL
# separation M3b would give, and the checks say so in their own names. SNP still excludes the host.
#
# Three boots of the same monitor image: s1 (SNP, two domains), s2 (SNP, one domain, second launch),
# t1 (plain KVM, two domains).
#
# usage: test-m3.sh [workdir]      RECHECK=1 re-scores a workdir's saved outputs without booting anything
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$here/../m2
W=${1:-$(mktemp -d)}; mkdir -p "$W"; W=$(cd "$W" && pwd)
res() { tr -d '\r' < "$1" 2>/dev/null | grep -a "^RESULT $2=" | head -1 | sed "s/^RESULT $2=//"; }
verdict() { tr -d '\r' < "$1" 2>/dev/null | grep -a '^VERDICT ' | head -1 | cut -d' ' -f2; }
ser() { tr -d '\r' < "$W/$1.serial" 2>/dev/null; }

# --- run context: what this workdir was produced with ------------------------------------------------
# A saved workdir has to describe itself. RECHECK=1 used to re-score whatever it found using whatever
# happened to be in the environment, so a bare `RECHECK=1 test-m3.sh <igvm-workdir>` silently fell back to
# the non-IGVM prediction and VMPL0 while reading VMPL2 evidence, and reported checks 1 and 3e as failures
# that were really missing context. Silence there is worse than refusing: it invents a verdict.
#
# A live run therefore records the launch context and the identity of every tool that decided a digest, and
# RECHECK recovers it and VERIFIES it. Anything missing, altered or contradicted is a refusal, never a
# quiet change of mode.
sha_of() { [ -r "$1" ] && sha256sum "$1" 2>/dev/null | cut -c1-64 || echo absent; }
CTXF=$W/run-context
# What the caller explicitly asked for, kept apart from the defaults so a conflict can be spotted.
cli_VMPL=${VMPL-}; cli_PLANE=${PLANE-}; cli_IGVM=${IGVM-}
cli_IGVMMEASURE=${IGVMMEASURE-}; cli_EXPECT_MEAS=${EXPECT_MEAS-}
ctx_bad=""
if [ "${RECHECK:-0}" = 1 ]; then
  [ -r "$CTXF" ] || { echo "RECHECK: $CTXF is missing, so this workdir does not say what produced it."; \
    echo "  Re-scoring it would guess the launch context and could invent passes or failures. Refusing."; exit 2; }
  # shellcheck disable=SC1090
  . "$CTXF"
  VMPL=${CTX_VMPL}; PLANE=${CTX_PLANE}; IGVM=${CTX_IGVM}; IGVMMEASURE=${CTX_IGVMMEASURE}
  EXPECT_MEAS=${CTX_EXPECT_MEAS}
  echo "RECHECK: recovered context v${CTX_VERSION:-?} from $CTXF"
  printf '  %-14s %s\n' vmpl "$VMPL" plane "${PLANE:-none}" igvm "${IGVM:-none}"
  # Every tool that decided a digest must still be the tool that decided it.
  for pair in "igvm:$IGVM:$CTX_IGVM_SHA" "igvmmeasure:$IGVMMEASURE:$CTX_IGVMMEASURE_SHA" "qemu:$CTX_QEMU:$CTX_QEMU_SHA"; do
    what=${pair%%:*}; rest=${pair#*:}; path=${rest%:*}; wantsha=${rest##*:}
    [ -n "$path" ] || continue
    [ -n "$wantsha" ] || { echo "  MALFORMED $what: $path recorded with no hash"; ctx_bad="$ctx_bad $what"; continue; }
    now=$(sha_of "$path")
    if [ "$now" != "$wantsha" ]; then
      echo "  MISMATCH $what: $path is $now, the run used $wantsha"; ctx_bad="$ctx_bad $what"
    else
      printf '  %-14s %s  %s\n' "$what ok" "$(echo "$wantsha" | cut -c1-16)" "$path"
    fi
  done
  # A caller may still name values, but disagreeing with the record is a refusal rather than an override.
  for pair in "VMPL:$cli_VMPL:$CTX_VMPL" "PLANE:$cli_PLANE:$CTX_PLANE" "IGVM:$cli_IGVM:$CTX_IGVM" "EXPECT_MEAS:$cli_EXPECT_MEAS:$CTX_EXPECT_MEAS"; do
    what=${pair%%:*}; rest=${pair#*:}; given=${rest%:*}; rec=${rest##*:}
    [ -n "$given" ] && [ "$given" != "$rec" ] && { echo "  CONFLICT $what: you passed '$given', the run recorded '$rec'"; ctx_bad="$ctx_bad $what"; }
  done
  [ -n "$ctx_bad" ] && { echo "RECHECK refusing: context is not the one this workdir was produced with:$ctx_bad"; exit 2; }
fi
# VMPL: the privilege level the guest is expected to run at, and the level every trusted client
# then DEMANDS of its reports. 0 is a plain SNP guest (M3a). Under COCONUT-SVSM at VMPL0 (M3b) it
# is the guest's own level, and run-domain.sh is given IGVM/QEMU/PLANE to launch that way.
VMPL=${VMPL:-0}
VCPUS=2                      # the guest's vCPU count is part of its identity: predict and boot with the same
BIGMEM=${BIGMEM:-1024}       # the guest size earlier runs used, kept for comparable cost figures
SMALLMEM=${SMALLMEM:-512}    # a right-sized guest: how little does one need for two domains?
fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

fwdport() {
  for _ in $(seq 100); do
    p=$(sed -n 's/^FWD listening 127.0.0.1:\([0-9]*\).*/\1/p' "$1" 2>/dev/null)
    [ -n "$p" ] && { echo "$p"; return; }
    sleep 0.05
  done
  echo 0
}
client() {   # client <out> <fwd log> [args]: one M2 client run against a domain, exit status recorded
  o=$1; f=$2; shift 2; rc=0
  timeout 300 node "$m2/client.mjs" "https://127.0.0.1:$(fwdport "$f")" --measurement "$want_meas" "$@" > "$o" 2>&1 || rc=$?
  echo "RESULT exit=$rc" >> "$o"
}
boot() {     # boot <tag> <snp|plain> [memMiB]: start the guest and wait for the monitor
  "$here/run-domain.sh" start "$W/mon.cpio.gz" "$2" "$1" "$W" "$VCPUS" "${3:-$BIGMEM}" > "$W/$1.host"
  cid=$(sed -n 's/.* cid=\([0-9]*\).*/\1/p' "$W/$1.host")
  for _ in $(seq 600); do grep -aq 'MON ready' "$W/$1.serial" 2>/dev/null && return 0; sleep 0.1; done
  echo "FAIL $1: the monitor never came up"; fails=$((fails + 1)); return 1
}
load() {     # load <tag> <app> <label> <cpu%> [memMiB] -> writes <tag>-<label>.load with the answer
  t=$(date +%s%3N)
  "$W/m3ctl" -cid "$cid" -label "$3" -cpu "$4" -mem "${5:-256}" load "$2" > "$W/$1-$3.load" 2>&1 || true
  echo "load_ms=$(( $(date +%s%3N) - t ))" > "$W/$1-$3.load_ms"
}
dport() { sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$W/$1-$2.load"; }
dsha()  { sed -n 's/.*"appSha256":"\([0-9a-f]*\)".*/\1/p' "$W/$1-$2.load"; }
fwd() {      # fwd <tag> <label> [tee]: forward a host TCP port to that domain's vsock port
  if [ -n "$3" ]; then
    "$W/fwd" -cid "$cid" -port "$(dport "$1" "$2")" -tee "$W/$1-$2.tee" > "$W/$1-$2.fwd" 2>&1 &
  else
    "$W/fwd" -cid "$cid" -port "$(dport "$1" "$2")" > "$W/$1-$2.fwd" 2>&1 &
  fi
  echo $! >> "$W/$1.pids"
}

if [ "${RECHECK:-0}" != 1 ]; then
  # two apps that differ only in their label, so they differ in bytes and so in hash
  for L in AAAAA BBBBB; do
    M2_LABEL=$L cargo build --release --locked --target wasm32-wasip2 \
      --manifest-path "$m2/app/Cargo.toml" --target-dir "$W/target-$L" 2>"$W/cargo-$L.txt"
    cp "$W/target-$L/wasm32-wasip2/release/m2_app.wasm" "$W/app-$L.wasm"
  done
  "$here/build-domain.sh" "$W/mon.cpio.gz" "$VCPUS" > "$W/build.txt"
  "$here/build-domain.sh" "$W/mon2.cpio.gz" "$VCPUS" > "$W/build2.txt"
  (cd "$m2" && CGO_ENABLED=0 go build -trimpath -o "$W/fwd" ./fwd)
  (cd "$here" && CGO_ENABLED=0 go build -trimpath -o "$W/m3ctl" ./m3ctl)
fi
pred=$(sed -n 's/^predicted measurement: //p' "$W/build.txt")
# Under IGVM the prediction above does NOT apply: the firmware is the IGVM's rather than the OVMF that
# sev-snp-measure was given, and on the legacy VMSA path the kernel synthesises the VMSA itself, so its
# contribution differs from anything we computed. Measured on warden-host 2026-09-23: predicted 91d5b628...,
# igvmmeasure's IGVM digest E0C43562..., live ed343d15... - three different values, and the live one is
# stable across separate runs.
#
# EXPECT_MEAS supplies the digest the clients must demand, so the REST of the suite can run at VMPL2 instead
# of every trusted client failing on the allowlist. Be clear what that is worth: it is TRUST-ON-FIRST-USE.
# It establishes that every guest reported the same measurement, NOT that we can derive what they ought to
# report. Check 1 says so out loud when it is used.
# Under IGVM the launch measurement IS derivable, but not by sev-snp-measure: the authority is igvmmeasure
# reading the very IGVM being launched. That is the whole difference between acceptance and trust-on-first-use,
# so it is computed here rather than supplied. The kit's own (unpatched) igvmmeasure computes it correctly with
# `measure -b`; only --check-kvm needed the PR-1209 change, and this does not pass it.
IGVMMEASURE=${IGVMMEASURE:-$HOME/.cache/enclave-isolation/svsmkit/svsm/bin/igvmmeasure}
EXPECT_MEAS=${EXPECT_MEAS:-}
derived_meas=""
if [ -z "$EXPECT_MEAS" ] && [ -n "$IGVM" ] && [ -x "$IGVMMEASURE" ]; then
  # lower-cased: igvmmeasure prints upper-case hex, the client reports the report's bytes in lower case
  derived_meas=$("$IGVMMEASURE" "$IGVM" measure -b 2>/dev/null | tr -d ' \r\n' | tr 'A-F' 'a-f')
  case "$derived_meas" in
    [0-9a-f]*) : ;;
    *) echo "WARN could not derive a digest from $IGVM with $IGVMMEASURE" >&2; derived_meas="" ;;
  esac
fi
want_meas=${EXPECT_MEAS:-${derived_meas:-$pred}}

if [ "${RECHECK:-0}" = 1 ]; then
  # The digest is re-derived from the recorded IGVM with the recorded tool and must reproduce what the run
  # recorded. This is what makes the workdir tamper-evident rather than merely self-describing: swap the
  # IGVM and the hashes above catch it; swap its contents and this catches it.
  if [ "$derived_meas" != "${CTX_DERIVED_MEAS}" ]; then
    echo "RECHECK refusing: re-deriving the digest gives '${derived_meas:-none}', the run recorded '${CTX_DERIVED_MEAS:-none}'"
    exit 2
  fi
  [ "$want_meas" = "${CTX_WANT_MEAS}" ] || { echo "RECHECK refusing: expected digest is '$want_meas', the run recorded '${CTX_WANT_MEAS}'"; exit 2; }
  [ -n "$derived_meas" ] && echo "  re-derived digest matches the record: $derived_meas"
else
  # Record it, so a later recheck neither guesses nor needs the environment reconstructed by hand.
  {
    echo "# written by test-m3.sh; RECHECK=1 reads and VERIFIES this. Do not hand-edit."
    echo "CTX_VERSION=1"
    echo "CTX_WHEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "CTX_VMPL=$VMPL"
    echo "CTX_PLANE=${PLANE:-}"
    echo "CTX_IGVM=${IGVM:-}"
    echo "CTX_IGVM_SHA=$([ -n "${IGVM:-}" ] && sha_of "$IGVM" || echo '')"
    echo "CTX_IGVMMEASURE=${IGVMMEASURE:-}"
    # A recorded path always carries its hash. Recording the tool without one made the verify loop read
    # "path set, hash empty" as a mismatch and wrongly refuse a non-IGVM workdir.
    echo "CTX_IGVMMEASURE_SHA=$([ -r "${IGVMMEASURE:-}" ] && sha_of "$IGVMMEASURE" || echo '')"
    echo "CTX_QEMU=${QEMU:-}"
    echo "CTX_QEMU_SHA=$([ -n "${QEMU:-}" ] && sha_of "$QEMU" || echo '')"
    echo "CTX_EXPECT_MEAS=${EXPECT_MEAS:-}"
    echo "CTX_DERIVED_MEAS=${derived_meas:-}"
    echo "CTX_PRED=${pred:-}"
    echo "CTX_WANT_MEAS=${want_meas:-}"
    echo "CTX_GUEST_KREL=$( . "$here/../m1/domain.env" >/dev/null 2>&1 && echo "$GUEST_KREL" )"
  } > "$CTXF"
  echo "evidence: run context recorded in $CTXF (RECHECK=1 verifies it)"
fi
shaA=$(sha256sum "$W/app-AAAAA.wasm" | cut -c1-64)
shaB=$(sha256sum "$W/app-BBBBB.wasm" | cut -c1-64)

if [ "${RECHECK:-0}" != 1 ]; then
  # --- s1: one guest, two domains, different apps and different CPU shares -----------------------
  : > "$W/s1.pids"
  boot s1 snp
  load s1 "$W/app-AAAAA.wasm" AAAAA 100
  load s1 "$W/app-BBBBB.wasm" BBBBB 25
  fwd s1 AAAAA tee
  fwd s1 BBBBB
  # the chip's VCEK once per batch, then every trusted client runs offline (KDS answers 429 quickly)
  client "$W/s1-A.probe" "$W/s1-AAAAA.fwd" --app-sha "$shaA" --no-kds --save "$W/s1.doc.json"
  [ -f "$W/vcek.der" ] || node "$m2/vcek-prep.mjs" "$W/s1.doc.json" "$W" > "$W/vcek-prep.txt" 2>&1 || true
  product=$(sed -n 's/^product //p' "$W/vcek-prep.txt")
  TR="--no-kds --vcek $W/vcek.der --amd-chain $product=$here/../../test/fixtures/amd/$product-cert_chain.pem --min-tcb @$W/min-tcb.json"
  [ "$VMPL" != 0 ] && TR="$TR --vmpl $VMPL"
  # shellcheck disable=SC2086
  {
    client "$W/s1-A.client" "$W/s1-AAAAA.fwd" --app-sha "$shaA" $TR --perf
    client "$W/s1-B.client" "$W/s1-BBBBB.fwd" --app-sha "$shaB" $TR
    # each domain must name ITS app: A's evidence must not satisfy a client expecting B
    client "$W/s1-A-as-B.client" "$W/s1-AAAAA.fwd" --app-sha "$shaB" $TR
  }
  # the CPU share: the same work in domain A (100%) and domain B (25%)
  for d in A:AAAAA B:BBBBB; do
    lbl=${d#*:}; tag=${d%%:*}
    p=$(fwdport "$W/s1-$lbl.fwd")
    s=$(date +%s%3N)
    curl -sk --max-time 300 "https://127.0.0.1:$p/burn?n=1500" > "$W/s1-$tag.burn" 2>&1 || true
    echo "ms=$(( $(date +%s%3N) - s ))" >> "$W/s1-$tag.burn"
  done
  # --- lifecycle: a domain whose workload dies must leave NOTHING behind -------------------------
  # A deliberately invalid app is a real crash path with no test-only hook in the guest: the runtime
  # fails to start it, domexec exits, and the monitor has to reclaim the whole domain.
  "$W/m3ctl" -cid "$cid" state > "$W/s1.state-before" 2>&1 || true
  printf 'this is not a wasm module' > "$W/bad.wasm"
  for i in 1 2 3 4 5; do load s1 "$W/bad.wasm" "BAD$i" 100; done
  sleep 3
  "$W/m3ctl" -cid "$cid" state > "$W/s1.state-after-crashes" 2>&1 || true
  "$W/m3ctl" -cid "$cid" list > "$W/s1.list-after-crashes" 2>&1 || true
  # ...and the guest still works afterwards: a good app loads and serves
  load s1 "$W/app-AAAAA.wasm" AGAIN 100
  fwd s1 AGAIN
  # shellcheck disable=SC2086
  client "$W/s1-AGAIN.client" "$W/s1-AGAIN.fwd" --app-sha "$shaA" $TR

  # --- the adversary: a domain whose runtime is compromised ---------------------------------------
  # /plat/domprobe is measured and runs as the domain's uid in its namespaces. It gets its own distinct
  # app bytes so the report it obtains can be checked against ITS OWN hash and no other domain's.
  head -c 4096 /dev/urandom > "$W/probe-app.bin"
  shaP=$(sha256sum "$W/probe-app.bin" | cut -c1-64)
  # a 64 MiB share, which its last probe then deliberately tries to exceed
  "$W/m3ctl" -cid "$cid" -label PROBE -cpu 50 -mem 64 -probe load "$W/probe-app.bin" > "$W/s1-PROBE.load" 2>&1 || true
  sleep 25
  # ...and the real domains must be untouched by any of it
  client "$W/s1-A.after-probe" "$W/s1-AAAAA.fwd" --app-sha "$shaA" $TR
  pid=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$W/s1-PROBE.load" | head -1)
  pboot=$(sed -n 's/.*"boot":"\([0-9a-f]*\)".*/\1/p' "$W/s1-PROBE.load" | head -1)
  "$W/m3ctl" -cid "$cid" list > "$W/s1.list-after-probe" 2>&1 || true
  "$W/m3ctl" -cid "$cid" -id "${pid:-0}" -boot "${pboot:-}" destroy > "$W/s1.probe-destroy" 2>&1 || true

  # --- graceful stop: signal the front and let the domain wind down -------------------------------
  agid=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$W/s1-AGAIN.load" | head -1)
  agboot=$(sed -n 's/.*"boot":"\([0-9a-f]*\)".*/\1/p' "$W/s1-AGAIN.load" | head -1)
  "$W/m3ctl" -cid "$cid" -id "${agid:-0}" -boot "${agboot:-}" stop > "$W/s1.stop" 2>&1 || true
  sleep 2
  "$W/m3ctl" -cid "$cid" state > "$W/s1.state-after-stop" 2>&1 || true

  "$W/m3ctl" -cid "$cid" list > "$W/s1.list-before" 2>&1 || true
  idB=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$W/s1-BBBBB.load" | head -1)
  bootB=$(sed -n 's/.*"boot":"\([0-9a-f]*\)".*/\1/p' "$W/s1-BBBBB.load" | head -1)
  "$W/m3ctl" -cid "$cid" -id "${idB:-2}" -boot "${bootB:-}" destroy > "$W/s1.destroy" 2>&1 || true
  sleep 1
  # a short probe, not the client: the client is built to WAIT for a domain to come up, which is the
  # opposite of what this checks
  curl -sk --max-time 10 "https://127.0.0.1:$(fwdport "$W/s1-BBBBB.fwd")/hello" > "$W/s1-B.after-destroy" 2>&1 \
    && echo "ANSWERED" >> "$W/s1-B.after-destroy" || echo "NO ANSWER" >> "$W/s1-B.after-destroy"
  "$W/m3ctl" -cid "$cid" list > "$W/s1.list-after" 2>&1 || true
  xargs -r kill < "$W/s1.pids" 2>/dev/null || true
  "$here/run-domain.sh" stop s1 "$W" >> "$W/s1.host"

  # --- s2: a second launch of the SAME image, one domain, app B --------------------------------
  : > "$W/s2.pids"
  boot s2 snp
  load s2 "$W/app-BBBBB.wasm" BBBBB 100
  fwd s2 BBBBB
  # shellcheck disable=SC2086
  client "$W/s2-B.client" "$W/s2-BBBBB.fwd" --app-sha "$shaB" $TR
  xargs -r kill < "$W/s2.pids" 2>/dev/null || true
  "$here/run-domain.sh" stop s2 "$W" >> "$W/s2.host"

  # --- s3: the same image in a RIGHT-SIZED guest, to price the density claim --------------------
  : > "$W/s3.pids"
  boot s3 snp "$SMALLMEM"
  "$W/m3ctl" -cid "$cid" state > "$W/s3.state-empty" 2>&1 || true
  load s3 "$W/app-AAAAA.wasm" AAAAA 100
  load s3 "$W/app-BBBBB.wasm" BBBBB 100
  fwd s3 AAAAA
  fwd s3 BBBBB
  # shellcheck disable=SC2086
  {
    client "$W/s3-A.client" "$W/s3-AAAAA.fwd" --app-sha "$shaA" $TR
    client "$W/s3-B.client" "$W/s3-BBBBB.fwd" --app-sha "$shaB" $TR
  }
  "$W/m3ctl" -cid "$cid" state > "$W/s3.state-loaded" 2>&1 || true
  xargs -r kill < "$W/s3.pids" 2>/dev/null || true
  "$here/run-domain.sh" stop s3 "$W" >> "$W/s3.host"

  # --- t1: the same image as a plain KVM guest -------------------------------------------------
  : > "$W/t1.pids"
  boot t1 plain
  load t1 "$W/app-AAAAA.wasm" AAAAA 100
  load t1 "$W/app-BBBBB.wasm" BBBBB 100
  fwd t1 AAAAA
  fwd t1 BBBBB
  client "$W/t1-A.trusted" "$W/t1-AAAAA.fwd" --app-sha "$shaA" --no-kds
  client "$W/t1-A.client" "$W/t1-AAAAA.fwd" --app-sha "$shaA" --t0-diagnostic
  client "$W/t1-B.client" "$W/t1-BBBBB.fwd" --app-sha "$shaB" --t0-diagnostic
  xargs -r kill < "$W/t1.pids" 2>/dev/null || true
  "$here/run-domain.sh" stop t1 "$W" >> "$W/t1.host"
fi

echo "evidence: app A $shaA"
echo "evidence: app B $shaB"
echo "evidence: predicted (monitor image, no app inside) $pred"
echo "evidence: s1 domains: $(cat "$W/s1-AAAAA.load" "$W/s1-BBBBB.load" 2>/dev/null | tr -d '\n')"

cmp -s "$W/mon.cpio.gz" "$W/mon2.cpio.gz" && r=ok || r=no
check "0 build reproducible: two builds of the monitor image are byte-identical" $r

# 0b the VMPL0-refusal gate's OWN failure modes, before trusting its verdict below. A gate nobody has
# watched fail is not a gate, and the check this replaced (grep for "vmpl=$VMPL") would have passed most
# of these logs, including one that also said vmpl0=GRANTED.
if fx=$("$here/boundary-gate-fixtures.sh" "$W/bgate" 2>&1); then r=ok; else r=no; fi
echo "evidence: $(printf '%s' "$fx" | tail -1)"
check "0b the boundary gate rejects every crafted bad log: GRANTED, a probe that never ran, mismatched levels, the downward-claim shape, missing and repeated fields, and zero or duplicate records" $r

mA=$(res "$W/s1-A.client" measurement); mB=$(res "$W/s1-B.client" measurement); m2m=$(res "$W/s2-B.client" measurement)
echo "evidence: measurement seen by domain A $mA"
echo "evidence: measurement seen by domain B $mB"
echo "evidence: measurement of the second launch (app B only) $m2m"
if [ -n "$EXPECT_MEAS" ]; then
  echo "evidence: the expected digest was SUPPLIED, not derived: $EXPECT_MEAS (sev-snp-measure predicted $pred, which does not apply under IGVM)"
  [ "$mA" = "$EXPECT_MEAS" ] && [ "$m2m" = "$EXPECT_MEAS" ] && r=ok || r=no
  check "1 measurement matches the SUPPLIED digest in both launches -- TRUST-ON-FIRST-USE, not an independently derived expectation, so it does NOT show this image could be recognised from its inputs" $r
elif [ -n "$derived_meas" ]; then
  echo "evidence: the expected digest was DERIVED by igvmmeasure from the launched IGVM $IGVM: $derived_meas"
  echo "evidence: derived with $IGVMMEASURE (sev-snp-measure predicted $pred, which does not apply under IGVM)"
  [ "$mA" = "$derived_meas" ] && [ "$m2m" = "$derived_meas" ] && r=ok || r=no
  check "1 measurement DERIVED from the shipped IGVM by igvmmeasure equals the live signed report in both launches -- launch identity, not trust-on-first-use" $r
else
  [ -n "$pred" ] && [ "$mA" = "$pred" ] && [ "$m2m" = "$pred" ] && r=ok || r=no
  check "1 measurement reproducible: live == predicted, both launches" $r
fi
[ -n "$mA" ] && [ "$mA" = "$mB" ] && [ "$mA" = "$m2m" ] && r=ok || r=no
check "2 the app is NOT in the measurement: two different apps in one guest, and a different mix in another launch, all report the SAME digest (M1 gave different digests per app)" $r

rdA=$(res "$W/s1-A.client" report_data); rdB=$(res "$W/s1-B.client" report_data)
echo "evidence: A report_data[32:64] $(echo "$rdA" | cut -c65-128) (want $shaA)"
echo "evidence: B report_data[32:64] $(echo "$rdB" | cut -c65-128) (want $shaB)"
[ "$(echo "$rdA" | cut -c65-128)" = "$shaA" ] && [ "$(echo "$rdB" | cut -c65-128)" = "$shaB" ] && r=ok || r=no
check "3 the MONITOR names each app: every domain's report carries the hash the monitor took when it loaded that domain" $r
[ "$(verdict "$W/s1-A.client")" = attested ] && [ "$(verdict "$W/s1-B.client")" = attested ] \
  && [ "$(verdict "$W/s2-B.client")" = attested ] && r=ok || r=no
check "3b both domains and the second launch are ATTESTED: AMD chain to the pinned root, VCEK names this chip and TCB, TCB meets the supplied floor, key+nonce bound" $r
# 3e is the VMPL0-REFUSAL gate, and it is deliberately not "the log mentions vmpl=$VMPL". A signed report
# naming VMPL$VMPL does not show confinement: a guest at VMPL0 holds every VMPCK and can request a report
# naming a LOWER level, so that string matches a guest that is not confined at all. What distinguishes them
# is being REFUSED a report at level 0. Three things therefore have to agree, and any one of them failing
# fails the check:
#   (i)   the guest's own console carries EXACTLY ONE coherent boundary record (boundary-gate.sh, whose own
#         failure modes are pinned by boundary-gate-fixtures.sh);
#   (ii)  every trusted client demanded level $VMPL and the SIGNED report carried it;
#   (iii) the same tuple reached each client inside the attestation document, over the domain's attested
#         TLS - not merely on the serial console, which belongs to the host.
r=ok
for tag in s1 s2 s3; do
  [ -f "$W/$tag.serial" ] || continue
  if g=$("$here/boundary-gate.sh" "$W/$tag.serial" "$VMPL" 2>&1); then
    echo "evidence: boundary($tag): $g"
  else
    echo "evidence: boundary($tag): REFUSED: $g"; r=no
  fi
done
for c in s1-A s1-B s2-B; do
  got=$(res "$W/$c.client" report_vmpl); wnt=$(res "$W/$c.client" expected_vmpl); b=$(res "$W/$c.client" boundary)
  echo "evidence: boundary($c): signed report_vmpl=${got:-none}, demanded=${wnt:-none}, document tuple=${b:-none}"
  [ "$got" = "$VMPL" ] && [ "$wnt" = "$VMPL" ] || r=no
  # the document must carry the tuple, and it must agree with the level the signed report named
  case "$b" in
    *"vmpl=$VMPL"*"vmpl_floor=$VMPL"*) ;;
    *) r=no ;;
  esac
  [ "$VMPL" = 0 ] || case "$b" in *vmpl0=refused*) ;; *) r=no ;; esac
  case "$b" in *GRANTED*) r=no ;; esac
done
check "3e the VMPL0-REFUSAL gate at level $VMPL: exactly one coherent boundary record on the console, the same tuple delivered to every client over attested TLS, and the signed report agreeing - a lower-level report alone is NOT accepted as confinement" $r
[ "$(verdict "$W/s1-A-as-B.client")" = reject ] && [ "$(res "$W/s1-A-as-B.client" app_requests_sent)" = 0 ] && r=ok || r=no
check "3c a client expecting app B is REJECTED by the domain running app A, and sends it nothing" $r
roots=$(ser s1 | grep -ac 'report_as_root=refused' || true)
echo "evidence: credential gate: $(ser s1 | grep -ao 'report_as_root=[a-z-]*' | tr '\n' ' ')($(ser s1 | grep -ac 'MON refused report request' || true) refusals logged by the monitor)"
[ "${roots:-0}" -ge 2 ] && ! ser s1 | grep -aq 'report_as_root=GRANTED' && r=ok || r=no
check "3d the monitor refuses a report to a caller that is not a domain, even as root in the guest (kernel credentials, not the request)" $r

bodyA=$(res "$W/s1-A.client" app_body); bodyB=$(res "$W/s1-B.client" app_body)
echo "evidence: domain A serves $bodyA / domain B serves $bodyB"
[ "$bodyA" = '"APP AAAAA path=/hello?from=client"' ] && [ "$bodyB" = '"APP BBBBB path=/hello?from=client"' ] \
  && [ "$(res "$W/s1-A.client" app_on_pinned_key)" = 1 ] && [ "$(res "$W/s1-B.client" app_on_pinned_key)" = 1 ] && r=ok || r=no
check "4 two domains serve their own apps on their own ports, each on its own attested key" $r
kA=$(res "$W/s1-A.client" spki_sha256); kB=$(res "$W/s1-B.client" spki_sha256); k2=$(res "$W/s2-B.client" spki_sha256)
[ -n "$kA" ] && [ "$kA" != "$kB" ] && [ "$kB" != "$k2" ] && r=ok || r=no
check "4b one TLS key per domain per launch: A, B and the second launch's B all differ" $r
[ "$(res "$W/s1-A.client" echo_intact)" = 1 ] && r=ok || r=no
check "4c 4 x 16 MiB echoed intact through a domain in a shared guest" $r
teeb=$(stat -c %s "$W/s1-AAAAA.tee" 2>/dev/null || echo 0)
hits=$(grep -a -c -E 'APP AAAAA|/hello|from=client|enclave-attestation' "$W/s1-AAAAA.tee" 2>/dev/null || true)
echo "evidence: the host relayed $teeb bytes for domain A; plaintext markers: ${hits:-0}"
[ "$teeb" -gt 1000 ] && [ "${hits:-0}" = 0 ] && r=ok || r=no
check "4d the host relays ciphertext only, and so does the monitor: TLS ends inside each domain" $r

echo "evidence: domain probes: $(ser s1 | grep -a 'probe workload_uid=' | tr '\n' ' ')"
probes=$(ser s1 | grep -ac 'probe workload_uid=5[0-9]* sys=0 configfs=0 domains_dir=0 own_app=1' || true)
setuid_errors=$(ser s1 | grep -ac 'ERROR setuid' || true)
[ "${probes:-0}" -ge 2 ] && [ "${setuid_errors:-0}" = 0 ] && r=ok || r=no
check "5 each domain runs unprivileged and sees no /sys, no configfs and no other domain's tree (guest-kernel separation, WEAKER than VMPL)" $r
pids=$(ser s1 | sed -n 's/.*visible_pids=\([0-9]*\).*/\1/p' | sort -n | tail -1)
echo "evidence: most processes any domain could see: ${pids:-?} (its own domexec, runtime and front; the guest as a whole runs far more)"
[ -n "$pids" ] && [ "$pids" -ge 2 ] && [ "$pids" -le 5 ] && r=ok || r=no
check "5b a domain sees only its own processes (its own PID namespace)" $r
# domexec gives every domain the same internal address, so serving different apps at once is the evidence
[ -n "$bodyA" ] && [ -n "$bodyB" ] && [ "$bodyA" != "$bodyB" ] && r=ok || r=no
check "5c both domains serve on the same internal address 127.0.0.1:8080 at once, without colliding or reaching each other (one network namespace each)" $r
msA=$(sed -n 's/^ms=//p' "$W/s1-A.burn"); msB=$(sed -n 's/^ms=//p' "$W/s1-B.burn")
ratio=$(awk -v a="$msB" -v b="$msA" 'BEGIN { if (b > 0) printf "%.2f", a / b; else print 0 }')
echo "evidence: the same 1.5G rounds took ${msA}ms in domain A (cpu.max 100%) and ${msB}ms in domain B (25%), ratio $ratio"
awk -v r="$ratio" 'BEGIN { exit !(r >= 3.0 && r <= 5.5) }' && r=ok || r=no
check "6 each domain gets its own CPU share: 25% is about 4x slower for the same work" $r

echo "evidence: destroy: $(cat "$W/s1.destroy" 2>/dev/null | tr -d '\n') / after: $(cat "$W/s1.list-after" 2>/dev/null | tr -d '\n')"
grep -aq 'NO ANSWER' "$W/s1-B.after-destroy" && grep -aq '"destroyed"' "$W/s1.destroy" \
  && grep -aq 'BBBBB' "$W/s1.list-before" && ! grep -aq 'BBBBB' "$W/s1.list-after" && r=ok || r=no
check "7 lease end: destroying a domain stops its port answering and removes it from the monitor's table" $r

bt=$(res "$W/t1-A.client" app_body)
echo "evidence: T0 domain A serves $bt, verdict $(verdict "$W/t1-A.client") (trusted default: $(verdict "$W/t1-A.trusted"))"
[ "$bt" = "$bodyA" ] && [ "$(verdict "$W/t1-A.client")" = not-attested ] && [ "$(verdict "$W/t1-B.client")" = not-attested ] && r=ok || r=no
check "8 tier parity: the same monitor image runs on plain KVM and serves the same apps, saying it is not attested" $r
[ "$(verdict "$W/t1-A.trusted")" = not-attested ] && [ "$(res "$W/t1-A.trusted" gate)" = closed ] \
  && [ "$(res "$W/t1-A.trusted" app_requests_sent)" = 0 ] && r=ok || r=no
check "8b the trusted default refuses a T0 domain and sends it no application request" $r

field() { sed -n "s/.*\"$2\":\([0-9]*\).*/\\1/p" "$1" | head -1; }
dirs_of() { sed -n 's/.*"dirs":\[\([^]]*\)\].*/\1/p' "$1" | head -1; }
echo "evidence: before the crashes: $(cat "$W/s1.state-before" 2>/dev/null | tr -d '\n')"
echo "evidence: after 5 crashed domains: $(cat "$W/s1.state-after-crashes" 2>/dev/null | tr -d '\n')"
echo "evidence: the monitor logged: $(ser s1 | grep -a 'MON domain .* ended' | sed 's/MON //' | tr '\n' '; ')"
same=yes
for f in domains cgroups mounts userspace_procs; do
  [ -n "$(field "$W/s1.state-before" $f)" ] && [ "$(field "$W/s1.state-before" $f)" = "$(field "$W/s1.state-after-crashes" $f)" ] || same=no
done
[ "$(dirs_of "$W/s1.state-before")" = "$(dirs_of "$W/s1.state-after-crashes")" ] || same=no
[ "$same" = yes ] && r=ok || r=no
check "9 a crashed domain leaves nothing behind: after 5 create-and-crash cycles the guest is byte-for-byte at its previous state -- same domains, directories, cgroups, mounts and processes" $r
crashed=$(ser s1 | grep -ac 'MON domain .* ended: its process tree exited' || true)
[ "${crashed:-0}" -ge 5 ] && ! grep -aq 'BAD' "$W/s1.list-after-crashes" && r=ok || r=no
check "9b each crash was noticed and retired exactly once, and none stayed in the monitor's table" $r
[ "$(verdict "$W/s1-AGAIN.client")" = attested ] && [ "$(res "$W/s1-AGAIN.client" app_body)" = '"APP AAAAA path=/hello?from=client"' ] && r=ok || r=no
check "9c the guest still serves after those cycles: a new domain loads, attests and answers" $r

# RECHECK never entered the live-only block above, so shaP and pid would be unset from here on, and checks
# 8c and 10c would silently FAIL on a workdir whose live run passed them - a recheck that is quietly wrong is
# worse than one that refuses to run. Both are recoverable from files the run already saved. Idempotent, so a
# live run keeps the values it computed.
[ -n "${shaP:-}" ] || shaP=$(sha256sum "$W/probe-app.bin" 2>/dev/null | cut -c1-64)
[ -n "${pid:-}" ] || pid=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$W/s1-PROBE.load" 2>/dev/null | head -1)
echo "evidence: the compromised domain trying to exhaust memory: $(ser s1 | grep -aE 'PROBE[0-9]* (eating|memory_)' | tr '\n' ' ')"
echo "evidence: how that domain ended: $(ser s1 | grep -aE "DOM${pid:-0} ERROR|domain ${pid:-0} ended" | tr '\n' '; ')"
uncontained=$(ser s1 | grep -ac 'memory_UNCONTAINED' || true)
capped=$(ser s1 | grep -acE 'PROBE[0-9]* (memory_refused_at|memory_touched)' || true)
ended=$(ser s1 | grep -ac "domain ${pid:-0} ended" || true)
[ "${uncontained:-1}" = 0 ] && [ "${capped:-0}" -ge 1 ] && [ "${ended:-0}" -ge 1 ] && r=ok || r=no
check "8c a compromised domain cannot exhaust the guest: touching past its own memory share ends THAT domain and nothing else" $r
[ "$(verdict "$W/s1-A.after-probe")" = attested ] && r=ok || r=no
check "8c2 the other domains were serving and attesting after it was contained" $r

echo "evidence: right-sized guest ($SMALLMEM MiB): $(cat "$W/s3.state-empty" 2>/dev/null | tr -d '\n')"
echo "evidence:   with two domains loaded: $(cat "$W/s3.state-loaded" 2>/dev/null | tr -d '\n')"
[ "$(verdict "$W/s3-A.client")" = attested ] && [ "$(verdict "$W/s3-B.client")" = attested ] \
  && [ "$(res "$W/s3-A.client" app_body)" = '"APP AAAAA path=/hello?from=client"' ] && r=ok || r=no
check "8d two domains attest and serve in a ${SMALLMEM} MiB guest, so the density claim is priced at a guest size someone would actually run" $r

# --- the adversary's results ---------------------------------------------------------------------
echo "evidence: the compromised domain tried:"
ser s1 | grep -a '^PROBE' | sed 's/^/    /' || true
probe_lines=$(ser s1 | grep -ac '^PROBE' || true)
bad=0
# every one of these must have FAILED. A line that says READABLE or CONNECTED is a broken boundary.
for k in other_app_absolute other_app_relative other_app_escape other_front_socket configfs_tsm sysfs dev_tpm0 dev_tpmrm0 \
         vsock_local_domain1 vsock_local_domain2 vsock_own_control vsock_host_control host_gateway; do
  v=$(ser s1 | sed -n "s/^PROBE[0-9]* $k=//p" | head -1)
  case "$v" in
    *READABLE*|*CONNECTED*|*OPENED*) echo "    BROKEN: $k=$v"; bad=$((bad + 1)) ;;
    "") echo "    MISSING: $k never reported"; bad=$((bad + 1)) ;;
  esac
done
[ "$(ser s1 | sed -n 's/^PROBE[0-9]* create_tsm_entry=//p' | head -1)" = "CREATED" ] && bad=$((bad + 1))
# TWO LAYERS (domprobe.c): the vsock lines above are the layer BENEATH the runtime's seccomp filter, so each must have
# failed ON ITS OWN, never with EPERM (only the filter gives that); the probe then filters itself (seccomp=2) and each
# filtered_ line must fail WITH EPERM. Otherwise a filtered probe would pass the vsock lines on EPERM alone and measure
# nothing about the relay and port confinement beneath (enclave-5d, on enclave-b4's filter).
for k in vsock_local_domain1 vsock_local_domain2 vsock_own_control vsock_host_control; do
  b=$(ser s1 | sed -n "s/^PROBE[0-9]* $k=//p" | head -1)
  f=$(ser s1 | sed -n "s/^PROBE[0-9]* filtered_$k=//p" | head -1)
  # ...and it must be a refusal the relay and port confinement give (the values seen in real guests: reset, refused, a
  # timeout, unreachable), not one that means vsock was never there to measure (EAFNOSUPPORT) or the filter (EPERM):
  # enclave-bf's review of 80b3f0de. A new errno fails loudly here, to be looked at, never passed by default.
  case "$b" in
    "Connection reset by peer"|"Connection refused"|"timed out (no answer)"|"Connection timed out"|"Network is unreachable") ;;
    *) echo "    BASE LAYER UNMEASURED: $k=${b:-missing}"; bad=$((bad + 1)) ;;
  esac
  [ "$f" = "Operation not permitted" ] || { echo "    NOT REFUSED BY THE FILTER: filtered_$k=${f:-missing}"; bad=$((bad + 1)); }
done
[ "$(ser s1 | sed -n 's/^PROBE[0-9]* seccomp=//p' | head -1)" = 2 ] || { echo "    the probe did not filter itself (seccomp=2)"; bad=$((bad + 1)); }
[ "${probe_lines:-0}" -ge 22 ] && [ "$bad" = 0 ] && r=ok || r=no
check "10 a COMPROMISED domain (measured native code as the domain's uid) cannot read another domain's app or socket, cannot reach configfs, the report interface or the TPM devices (open only), cannot open another domain's vsock port or the host's, and cannot reach the host network" $r
sig=$(ser s1 | sed -n 's/^PROBE[0-9]* signalable_pids=//p' | head -1)
vis=$(ser s1 | sed -n 's/^PROBE[0-9]* visible_pids=//p' | head -1)
echo "evidence: it could see $vis processes and signal $sig of the first 400 pids"
[ -n "$sig" ] && [ "$sig" -le 2 ] && [ -n "$vis" ] && [ "$vis" -le 3 ] && r=ok || r=no
check "10b it can see and signal only its own processes, not the monitor's and not another domain's" $r
# the report it DID get must name its own app: a compromised domain can only ever speak for itself
prep=$(ser s1 | sed -n 's/^PROBE[0-9]* report_b64=//p' | head -1)
named=$(python3 -c "
import base64,sys
b=base64.b64decode(sys.argv[1]) if sys.argv[1] else b''
print(b[0x50+32:0x50+64].hex() if len(b)>=0x90 else '')" "$prep" 2>/dev/null)
echo "evidence: the app named in its report: ${named:-none} (its own $shaP; the other domains run $shaA / $shaB)"
[ -n "$named" ] && [ "$named" = "$shaP" ] && r=ok || r=no
check "10c the report it obtained names ITS OWN app, although its request also carried another app hash: naming is the monitor's, not the caller's" $r

# --- graceful stop ------------------------------------------------------------------------------
echo "evidence: stop: $(cat "$W/s1.stop" 2>/dev/null | tr -d '\n') / $(ser s1 | grep -aE 'stop:|stopped' | tr '\n' '; ')"
echo "evidence: after stop: $(cat "$W/s1.state-after-stop" 2>/dev/null | tr -d '\n')"
ser s1 | grep -aq "ERROR front exited" && grep -aq '"stopped"' "$W/s1.stop" && r=ok || r=no
check "11 a graceful stop signals the domain's FRONT, the domain's init notices that child is gone, and the domain winds down (the front-exit path, distinct from a crashed runtime)" $r
ser s1 | grep -aq "stopped gracefully" && r=ok || r=no
check "11b it wound down within the grace period rather than being killed" $r

echo "--- 10 cost (measured, no pass/fail) ---"
for t in s1 s2 s3 t1; do
  printf '%-3s kernel->monitor %sms, host CPU %ss, memory peak %s MB, domains %s\n' "$t" \
    "$(ser "$t" | grep -aoE 'boot_ms=[0-9]+' | head -1 | cut -d= -f2)" \
    "$(awk -v n="$(sed -n 's/^HOST CPUUsageNSec=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.1f", n / 1e9 }')" \
    "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/$t.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')" \
    "$(ser "$t" | grep -ac 'MON domain .* loaded' || true)"
done
printf 'domain A latency p50 %sms p99 %sms, echo %s MB/s (through the monitor relay, in a shared guest)\n' \
  "$(res "$W/s1-A.client" latency_p50_ms)" "$(res "$W/s1-A.client" latency_p99_ms)" "$(res "$W/s1-A.client" echo_mb_per_s)"
printf 'lease start (load -> serving): %s\n' "$(cat "$W"/s1-*.load_ms "$W"/s2-*.load_ms 2>/dev/null | tr '\n' ' ')"
printf 'host memory for the guest: %s MB with two domains, %s MB with one -- SNP pins the guest RAM at launch,\n' \
  "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/s1.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')" \
  "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/s2.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')"
printf '  so a second domain costs no extra host memory, where M2 needs another whole guest per app (586 MB each).\n'
printf 'right-sized: %s MB of host memory for a %s MiB guest serving TWO attested domains, against M2 needing\n' \
  "$(awk -v n="$(sed -n 's/^HOST MemoryPeak=//p' "$W/s3.host")" 'BEGIN { if (n != "") printf "%.0f", n / 1e6 }')" "$SMALLMEM"
printf '  586 MB for ONE app; the guest reported %s MiB available empty and %s MiB with both domains loaded.\n' \
  "$(sed -n 's/.*"mem_available_mib":\([0-9]*\).*/\1/p' "$W/s3.state-empty" | head -1)" \
  "$(sed -n 's/.*"mem_available_mib":\([0-9]*\).*/\1/p' "$W/s3.state-loaded" | head -1)"
echo "workdir $W"
if [ "$fails" -ne 0 ]; then
  echo "M3a: $fails FAILED"; exit 1
elif [ -n "$EXPECT_MEAS" ]; then
  # A pinned measurement must never be able to read as acceptance. The expected digest was handed to the
  # clients rather than derived from the image's inputs, so the run shows the guests AGREE about their launch
  # measurement, not that anyone could recognise this image without being told the answer. The marker is
  # deliberately NOT "ALL PASS", so a checker cannot grep its way to the wrong conclusion.
  echo "M3a: all checks pass, but NOT ACCEPTANCE: the launch measurement was SUPPLIED via EXPECT_MEAS"
  echo "  supplied: $EXPECT_MEAS"
  echo "  Trust-on-first-use. An allowlist built from this would only repeat a value it was given."
elif [ -n "$derived_meas" ]; then
  echo "M3a: ALL PASS"
  echo "  launch identity: the digest igvmmeasure DERIVED from $IGVM equals the live signed report"
  echo "  derived: $derived_meas"
else
  echo "M3a: ALL PASS"
fi
