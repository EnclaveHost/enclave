#!/bin/sh
# Model volumes in a partition domain (m3/monitor/modelvol.go verifies and binds them; domexec gives them to the
# runtime): domexec, built static, runs as PID 1 in an unprivileged user namespace (--map-auto), chrooted into an
# m3-shaped domain root holding the monitor's read-only binds as plain directories, the measured table and the
# monitor's root-owned, read-only /model.volumes, with m3/modelvol-probe.c standing in for both workloads. Checked:
#   - the runtime's argv: -S nn and each preloaded graph (when the runtime carries wasi-nn with ggml), one read-only
#     preopen per volume and the env NAMES, all before /app.wasm; its environment: the values, the CPU backend dir;
#   - the graph staged as wasm_manager stages it (/tmp/nn-graph/<volume>/model.gguf -> the volume's file);
#   - preloads budgeted against the domain's memory: over budget, mounted and listed but not preloaded;
#   - a runtime without wasi-nn: preopens and ENCLAVE_MODELS only; no marker: nothing changes, as before;
#   - a secret domain: secretrun receives the same argv and the values (it carries them, secretrun/models.go);
#   - the front gets none of it;
#   - refused before anything runs: a writable marker, a name the measured table lacks, a volume not bound.
# Mutants of domexec.c, each of which must fail: the argv not extended; the env not given; the marker's mode not
# checked; the binds not checked.
#
# usage: test-domexec-modelvol.sh   (needs gcc and unshare --map-auto with a subuid range; else SKIPPED)
set -e
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d)
trap 'reclaim; rm -rf "$d"' EXIT
reclaim() { [ -d "$d/root" ] && unshare --map-root-user --map-auto sh -c "chown -R 0:0 '$d/root'; chmod -R u+rwx '$d/root'" 2>/dev/null; rm -rf "$d/root"; }
chmod 0755 "$d"
if ! command -v unshare >/dev/null 2>&1 || ! unshare --map-root-user --map-auto -U true 2>/dev/null; then
  echo "domexec modelvol: SKIPPED, no unshare --map-auto here"; exit 0
fi
gcc -static -O2 -o "$d/probe" "$here/modelvol-probe.c"
pin=$(printf '%064d' 1 | tr 0 1)
root_a=a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff
root_b=0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0
printf 'qwen-a %s 00ff 4096 4096 10 11 49152 ggml model.gguf %s\ndata-b %s 00ff 4096 4096 10 11 49152 none - %s\n' \
  "$root_a" "$pin" "$root_b" "$pin" > "$d/table"

run_one() {  # <domexec> <marker: none|ok|writable|unknown> <nn: yes|no> <secret: yes|no> <bound: both|one> <app MiB>
  reclaim; mkdir -p "$d/root/plat/rt" "$d/root/run" "$d/root/tmp" "$d/root/proc" "$d/root/probe-out" "$d/root/models/qwen-a"
  chmod 0755 "$d/root" "$d/root/plat" "$d/root/plat/rt"; chmod 1777 "$d/root/probe-out"
  cp "$1" "$d/root/plat/domexec"; chmod 0755 "$d/root/plat/domexec"
  for p in rt/ld-linux-x86-64.so.2 front secretrun; do cp "$d/probe" "$d/root/plat/$p"; chmod 0755 "$d/root/plat/$p"; done
  cp "$d/table" "$d/root/plat/rt/model-volumes.table"; chmod 0444 "$d/root/plat/rt/model-volumes.table"
  [ "$3" = yes ] && : > "$d/root/plat/rt/nn-ggml.enabled"
  head -c 2097152 /dev/zero > "$d/root/models/qwen-a/model.gguf"
  [ "$5" = both ] && mkdir -p "$d/root/models/data-b" && echo data > "$d/root/models/data-b/readme"
  if [ "$4" = yes ]; then printf '0x%064d' 0 > "$d/root/secret.id"; chmod 0444 "$d/root/secret.id"; fi
  case "$2" in ok) printf 'M1\nvol=qwen-a\nvol=data-b\n' > "$d/root/model.volumes"; chmod 0444 "$d/root/model.volumes" ;;
               writable) printf 'M1\nvol=qwen-a\nvol=data-b\n' > "$d/root/model.volumes"; chmod 0644 "$d/root/model.volumes" ;;
               unknown) printf 'M1\nvol=qwen-a\nvol=llama-70b\n' > "$d/root/model.volumes"; chmod 0444 "$d/root/model.volumes" ;; esac
  timeout 60 unshare --map-root-user --map-auto -mpfn -- sh -c "
    chown 1001:1001 '$d/root/run' && chmod 0700 '$d/root/run' && exec chroot '$d/root' /plat/domexec 7 1000:1001 app $6 3<>/dev/null" > "$d/console.txt" 2>&1 || true
}
argv() { tr '\n' ' ' < "$d/root/probe-out/$1.argv" 2>/dev/null; }
envof() { cat "$d/root/probe-out/$1.env" 2>/dev/null; }
check() {  # <label> <cond...>
  label="$1"; shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label (runtime argv: $(argv runtime | cut -c1-600) env: $(envof runtime | grep '^ENCLAVE' | tr '\n' ' ') console: $(tr '\n' ' ' < "$d/console.txt" | cut -c1-300))"; return 1; fi
}
has() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
want_tail="-S nn -S nn-graph=ggml::/tmp/nn-graph/qwen-a --dir /models/qwen-a::/models/qwen-a --dir /models/data-b::/models/data-b --env ENCLAVE_MODELS --env ENCLAVE_NN_PRELOADS --env ENCLAVE_NN_SERVE_BYTES --env ENCLAVE_NN_SERVE_KIND /app.wasm "
run_all() {  # <domexec.c>
  mkdir -p "$d/b/m3" "$d/b/m2" && cp "$1" "$d/b/m3/domexec.c" && cp "$here/../m2/app-seccomp.h" "$here/../m2/sha256-min.h" "$here/../m2/modelvol.h" "$d/b/m2/"
  gcc -static -O2 -o "$d/domexec" "$d/b/m3/domexec.c" 2>"$d/cc.log" || { echo "FAIL domexec did not build: $(head -3 "$d/cc.log")"; return 1; }
  rc=0
  run_one "$d/domexec" ok yes no both 1024
  check "the runtime's argv: wasi-nn, the graph preloaded, both read-only preopens and the env names, before the app" \
    has "$(argv runtime)" "127.0.0.1:8080 $want_tail" || rc=1
  check "the runtime's env: the names' values (768 MiB budget of 1024) and the ggml CPU backend" sh -c "
    e=\$(cat '$d/root/probe-out/runtime.env'); for v in ENCLAVE_MODELS=qwen-a,data-b ENCLAVE_NN_PRELOADS=qwen-a ENCLAVE_NN_SERVE_BYTES=805306368 \
      ENCLAVE_NN_SERVE_KIND=RAM ENCLAVE_GGML_BACKEND_DIR=/plat/rt/backends ENCLAVE_GGML_N_GPU_LAYERS=0; do
      printf '%s\n' \"\$e\" | grep -qx \"\$v\" || exit 1; done" || rc=1
  check "the graph staged as wasm_manager stages it" grep -qx "/tmp/nn-graph/qwen-a/model.gguf -> /models/qwen-a/model.gguf" "$d/root/probe-out/runtime.stage" || rc=1
  check "the front gets none of it" sh -c "! grep -q '^ENCLAVE_MODELS' '$d/root/probe-out/front.env' && ! grep -q '/models/' '$d/root/probe-out/front.argv'" || rc=1

  run_one "$d/domexec" ok yes no both 257
  check "over budget (1 MiB of a 257 MiB domain): wasi-nn, no preload, the volumes still mounted and listed" sh -c "
    a=\$(tr '\n' ' ' < '$d/root/probe-out/runtime.argv'); case \"\$a\" in *'-S nn --dir /models/qwen-a::/models/qwen-a'*) ;; *) exit 1 ;; esac
    grep -qx 'ENCLAVE_NN_PRELOADS=' '$d/root/probe-out/runtime.env' && grep -qx 'ENCLAVE_MODELS=qwen-a,data-b' '$d/root/probe-out/runtime.env'" || rc=1

  run_one "$d/domexec" ok no no both 1024
  check "a runtime without wasi-nn: the preopens and ENCLAVE_MODELS only" sh -c "
    a=\$(tr '\n' ' ' < '$d/root/probe-out/runtime.argv'); case \"\$a\" in *'-S nn'*) exit 1 ;; *'--dir /models/qwen-a::/models/qwen-a --dir /models/data-b::/models/data-b --env ENCLAVE_MODELS /app.wasm '*) ;; *) exit 1 ;; esac
    grep -qx 'ENCLAVE_MODELS=qwen-a,data-b' '$d/root/probe-out/runtime.env' && ! grep -q '^ENCLAVE_NN' '$d/root/probe-out/runtime.env'" || rc=1

  run_one "$d/domexec" none yes no both 1024
  check "no marker: nothing changes" sh -c "! grep -q '/models/' '$d/root/probe-out/runtime.argv' && ! grep -q '^ENCLAVE_MODELS' '$d/root/probe-out/runtime.env' && grep -qx /app.wasm '$d/root/probe-out/runtime.argv'" || rc=1

  run_one "$d/domexec" ok yes yes both 1024
  check "a secret domain: secretrun gets the same argv and the values to carry" sh -c "
    head -1 '$d/root/probe-out/runtime.argv' | grep -qx /plat/secretrun && tr '\n' ' ' < '$d/root/probe-out/runtime.argv' | grep -qF -- '$want_tail' &&
    grep -qx 'ENCLAVE_NN_PRELOADS=qwen-a' '$d/root/probe-out/runtime.env'" || rc=1

  run_one "$d/domexec" writable yes no both 1024
  check "a writable marker is refused before anything runs" sh -c "grep -q 'model volume marker' '$d/console.txt' && [ ! -s '$d/root/probe-out/runtime.argv' ]" || rc=1
  run_one "$d/domexec" unknown yes no both 1024
  check "a name the measured table lacks is refused" sh -c "grep -q 'measured table does not carry' '$d/console.txt' && [ ! -s '$d/root/probe-out/runtime.argv' ]" || rc=1
  run_one "$d/domexec" ok yes no one 1024
  check "a volume the monitor did not bind is refused" sh -c "grep -q 'not mounted in this domain' '$d/console.txt' && [ ! -s '$d/root/probe-out/runtime.argv' ]" || rc=1
  return $rc
}
set +e
run_all "$here/domexec.c"; g=$?
[ $g = 0 ] && echo "domexec modelvol: PASS" || echo "domexec modelvol: FAIL"
mut() {  # <label> <sed expression>
  sed "$2" "$here/domexec.c" > "$d/mutant.c"
  if cmp -s "$d/mutant.c" "$here/domexec.c"; then echo "FAIL mutant $1: the edit did not apply"; return 1; fi
  if run_all "$d/mutant.c" > "$d/mutant.log" 2>&1; then echo "FAIL mutant $1 SURVIVED"; return 1; fi
  echo "ok   mutant $1 killed: $(grep -m1 '^FAIL' "$d/mutant.log" | cut -c1-160)"
}
k=0
mut "the argv not extended" 's/model_arguments(rt); model_arguments(run);/(void)0;/' || k=1
mut "the env not given" 's/envp\[mv_env(envp, (int)n)\] = NULL;/(void)n;/' || k=1
mut "the marker's mode not checked" 's/ || (st.st_mode \& 0222) || st.st_size <= 0/ || st.st_size <= 0/' || k=1
mut "the binds not checked" 's/if (!why) why = mv_dirs();/if (!why) (void)mv_dirs();/' || k=1
[ $k = 0 ] && echo "domexec modelvol mutants: all killed" || echo "domexec modelvol mutants: FAIL"
[ $g = 0 ] && [ $k = 0 ]
