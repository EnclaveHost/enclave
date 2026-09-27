#!/bin/sh
# Hardware integration canary, NOT a production app release. Boot the exact
# per-app domain init with an additional fail-closed gate: both untrusted GPU
# workers must pass the production Shield probe before its attested TLS front
# can start. The caller verifies the predicted SNP measurement independently.
# The probes use public synthetic inputs. No CUDA device or plaintext inference
# service is attached to the guest; masking and verification run in the guest.
# Usage: build-shielded-canary.sh <base-template> <app.bundle> <output-dir>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
base=${1:?base template}; bundle=${2:?app bundle}; out=${3:?output directory}
[ ! -e "$out" ] || { echo "output already exists" >&2; exit 2; }
mkdir -p "$out/template"
cp -a "$base/." "$out/template/"
repo=$(cd "$here/../.." && pwd)
make -C "$repo/wasm/ggml-shielded" -j2 shielded-probe > "$out/probe-build.log" 2>&1
cp "$repo/wasm/ggml-shielded/shielded-probe" "$out/template/rt/shielded-probe"
# The probe shares libc/libm with the runtime. Refuse a build-host ABI mismatch
# rather than accidentally substituting libraries in the pinned base template.
ldd "$out/template/rt/shielded-probe" | awk '/=>/ {print $3}' | while read -r lib; do
  cmp "$lib" "$out/template/rt/$(basename "$lib")" || exit 1
done
python3 - "$here/../m2/dominit.c" "$out/canary-init.c" <<'PY'
import sys
from pathlib import Path
source=Path(sys.argv[1]).read_text()
needle='    lo_up();\n'
assert source.count(needle)==1
gate=r'''
    /* CANARY ONLY: attested TLS is unreachable unless BOTH masked probes pass.
     * This is not a wasi-nn capability marker and grants no app GPU admission. */
    for (int card = 0; card < 2; card++) {
        char *probe[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt",
                         "/rt/shielded-probe", "--host", "vsock:2", "--port",
                         card ? "9502" : "9501", NULL};
        pid_t p = fork();
        if (p == 0) {
            char *env[] = {"PATH=/rt", NULL};
            execve(probe[0], probe, env);
            _exit(127);
        }
        int status = 0;
        if (p < 0 || waitpid(p, &status, 0) != p || !WIFEXITED(status) || WEXITSTATUS(status)) {
            printf("DOM ERROR Shield canary card %d failed; refusing to serve\n", card);
            fflush(stdout); reboot(RB_POWER_OFF); _exit(1);
        }
        printf("DOM Shield canary card %d passed\n", card);
        fflush(stdout);
    }
'''
Path(sys.argv[2]).write_text(source.replace(needle,needle+gate))
PY
musl=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
env -u CPATH -u C_INCLUDE_PATH -u LIBRARY_PATH -u GCC_EXEC_PREFIX -u COMPILER_PATH \
  /usr/bin/gcc -specs "$musl/lib/musl-gcc.specs" -static -O2 -I "$here/../m2" \
  -o "$out/template/init" "$out/canary-init.c"
"$here/assemble-app-image.sh" "$out/template" "$bundle" "$out/canary.cpio.gz"
. "$here/../m1/domain.env"
"$HOME/.local/bin/sev-snp-measure" --mode snp --vcpus 1 \
  --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU \
  --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$out/canary.cpio.gz" --append "$APPEND" \
  > "$out/measurement.txt"
sha256sum "$out/template/init" "$out/template/rt/shielded-probe" "$out/canary.cpio.gz" > "$out/hashes.txt"
echo "Built hardware canary; measurement $(cat "$out/measurement.txt")"
