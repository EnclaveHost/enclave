#!/bin/sh
# mverity.h restates the device-mapper ioctl ABI (the per-app init is musl-linked and has no kernel headers). This
# checks every size, field offset, flag and ioctl number against the kernel's own <linux/dm-ioctl.h>, then compiles
# the header under the musl toolchain the image uses (when present) and the metal helper that now includes it.
#
# usage: test-mverity-abi.sh   (needs gcc and kernel UAPI headers)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
cat > "$d/abi.c" <<'C'
#include <stddef.h>
#include <linux/dm-ioctl.h>
#include "mverity.h"
#define SAME(a, b) _Static_assert((a) == (b), #a " == " #b)
SAME(sizeof(struct dm_ioctl), sizeof(struct mv_dm_ioctl));
SAME(sizeof(struct dm_target_spec), sizeof(struct mv_dm_target_spec));
#define OFF(f) SAME(offsetof(struct dm_ioctl, f), offsetof(struct mv_dm_ioctl, f))
OFF(version); OFF(data_size); OFF(data_start); OFF(target_count); OFF(open_count); OFF(flags); OFF(event_nr); OFF(padding);
OFF(dev); OFF(name); OFF(uuid); OFF(data);
#define TOFF(f) SAME(offsetof(struct dm_target_spec, f), offsetof(struct mv_dm_target_spec, f))
TOFF(sector_start); TOFF(length); TOFF(status); TOFF(next); TOFF(target_type);
SAME(DM_DEV_CREATE, MV_DM_DEV_CREATE); SAME(DM_DEV_SUSPEND, MV_DM_DEV_SUSPEND); SAME(DM_TABLE_LOAD, MV_DM_TABLE_LOAD);
SAME(DM_READONLY_FLAG, MV_DM_READONLY_FLAG); SAME(DM_VERSION_MAJOR, MV_DM_VERSION_MAJOR);
SAME(DM_NAME_LEN, MV_DM_NAME_LEN); SAME(DM_UUID_LEN, MV_DM_UUID_LEN); SAME(DM_MAX_TYPE_NAME, MV_DM_MAX_TYPE_NAME);
int main(void) { (void)mverity_setup; return 0; }   /* referenced, so -Werror sees the shared function used */
C
gcc -Wall -Wextra -Werror -I "$here" -o "$d/abi" "$d/abi.c" && "$d/abi" && echo "ok   mverity.h matches <linux/dm-ioctl.h>: sizes, every field offset, flags, ioctl numbers"
gcc -Wall -Wextra -Werror -static -Os -o "$d/mverity" "$here/../../metal/guest/mverity.c" && echo "ok   metal/guest/mverity.c builds on the shared header"
rc=0; "$d/mverity" a b 0 4096 1 2 sha256 00 00 2>"$d/err" || rc=$?
[ $rc = 2 ] && grep -q "bad geometry" "$d/err" && echo "ok   the metal helper keeps its usage and geometry refusal (exit 2)" || { echo "FAIL metal helper refusal: rc=$rc $(cat "$d/err")"; exit 1; }
MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
if [ -r "$MUSL/lib/musl-gcc.specs" ]; then
  printf '#include "mverity.h"\nint main(void){char n[64];return mverity_setup("x","/nonexistent",4096,4096,1,2,"sha256","00","00",n,sizeof n)?0:1;}\n' > "$d/m.c"
  env -u CPATH -u C_INCLUDE_PATH /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static -Wall -Werror -I "$here" -o "$d/m" "$d/m.c" && "$d/m" \
    && echo "ok   mverity.h builds under musl (no kernel headers) and refuses a non-device"
else
  echo "ok   (musl toolchain absent at $MUSL: the musl build is checked by the image build itself)"
fi
echo "mverity abi: PASS"
