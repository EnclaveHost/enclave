# Can a Pixel 10 pVM payload JIT? No. (2026-09-23)

`payload/jit_probe.c` (build.sh jit_probe), run as a protected VM with `vm run-app --protected --debug full --mem 256` on
the Pixel 10 Pro XL (Android 17, CP2A.260805.005). The debug level does not change the payload's SELinux domain; the
product VM runs DEBUG_LEVEL_NONE in the same domain.

| test | result |
|---|---|
| payload SELinux domain | `u:r:microdroid_app:s0` |
| CPU | hwcap 0xefffffff, hwcap2 0x2f3ff; asimd, asimddp (dotprod), sve, sve2, sveaes, i8mm-class features, sha3/sha512, atomics, lrcpc, pac, dit, sb |
| anonymous RWX mapping | refused: Permission denied (`avc: denied { execmem }`, enforcing) |
| W^X: anonymous RW -> write ARM64 code -> mprotect R+X | refused: Permission denied (`execmem`) |
| memfd: write code through a RW mapping, unmap, map R+X | refused before that: the payload may not write its memfd (`avc: denied { write } ... tmpfs`) |
| a file under /data | refused (`shell_data_file` search denied) |
| the encrypted store | mounted `noexec` (anchor STORAGE2 line: `/mnt/encryptedstore ext4 rw,...,noexec`) |
| writable+executable mappings in the process | 0 |

So the only executable code a stock Microdroid payload can run is what its measured APK (and the Microdroid image) carry.
Runtime code generation to ARM64 -- a JIT, in any W^X arrangement -- is forbidden by the platform's SELinux policy inside
the pVM image, which Google signs and which cannot be changed without modifying the platform (not authorised). This is the
same shape as a Windows VBS enclave (VTL1 refuses executable pages).
