#!/bin/bash
# READ-ONLY guest check (root runs it on the RPC guest; changes nothing): the runtime identities the patched capture module accepts,
# the own L1 endpoints, the reserved Helios listen port, and (after install) the Helios binary's loader closure. Prints names/hashes only.
set -u; ok=1
chk() { local got; got=$(sha256sum "$(readlink -f "$1")" | cut -c1-64); if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "BAD  $1 $got"; ok=0; fi; }
chk /usr/bin/node f3f93db342d5ac5bb61656d0599a603a73779e98befd9342171e550002725f4d
chk /usr/lib/x86_64-linux-gnu/libnode.so.109 ce7cb9cd408c412090c86dada332aaa82650679ed1b32527768c8dbd8c4028d0
chk /usr/bin/python3.12 e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f
[ "$(getconf GNU_LIBC_VERSION)" = "glibc 2.39" ] && echo "ok   glibc 2.39" || { echo "BAD  $(getconf GNU_LIBC_VERSION)"; ok=0; }
[ "$(/usr/bin/python3.12 -I -c 'import pathlib;print(sum("libpython" in l for l in pathlib.Path("/proc/self/maps").read_text().splitlines()))')" = 0 ] && echo "ok   python3.12 maps no libpython (static)" || { echo "BAD  python3.12 maps a libpython"; ok=0; }
[ "$(/usr/bin/node -e 'process.stdout.write(JSON.stringify(process.report.getReport().sharedObjects.filter((s)=>/libnode\.so/.test(s)).map((s)=>require("fs").realpathSync(s))))')" = '["/usr/lib/x86_64-linux-gnu/libnode.so.109"]' ] && echo "ok   node maps exactly the accepted libnode" || { echo "BAD  node libnode mapping"; ok=0; }
for p in 15052 18645; do ss -ltnH "sport = :$p" | grep -q "127.0.0.1:$p" && echo "ok   own L1 listener 127.0.0.1:$p" || { echo "BAD  no 127.0.0.1:$p listener"; ok=0; }; done
ss -ltnH "sport = :18550" | grep -q . && { echo "BAD  18550 (Helios listen) is taken"; ok=0; } || echo "ok   18550 free for Helios"
H=/opt/enclave-rpc/a1-capture/bin/helios-eeffcc9
if [ -e "$H" ]; then chk "$H" cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0; ldd "$H" | grep -q "not found" && { echo "BAD  helios loader closure"; ok=0; } || echo "ok   helios loads with the guest libc"; else echo "info helios not installed yet"; fi
echo "## guest-runtime ok=$ok"; [ $ok = 1 ]
