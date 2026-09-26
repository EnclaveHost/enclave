wasmtime 48.0.1 (the guests' runtime: ~/enclave-prod/release-4cdd5169/template/rt, run through its own ld-linux) under
isolation/m2/app-seccomp.h's FULL filter, by enclave-b4 on warden-host, 2026-09-26 (time in measurement.txt), unprivileged,
inside `unshare -rn` (a user + network namespace with its own loopback). NOT a guest result.

launch.c sets PR_SET_NO_NEW_PRIVS, installs app_seccomp_install() from the header (the same code dominit and domexec
run), and execs the rest of its argv. measure.sh runs, through it:
  SERVE: wasmtime serve -S cli -C cache=n --addr 127.0.0.1:8080 <a wasi:http component (m2-regress app-A.wasm)>
  RUN:   wasmtime run -S cli -S tcp -S udp -S inherit-network -S allow-ip-name-lookup -C cache=n --dir <data>::/data
         --env ENCLAVE_PORTS=http:8000=8000 <the sentinel's component (canary-v41 sentinel-SNTLa67d9469ffe1.bundle)>
each answering 3 GETs, then checks it is still alive and reads its Seccomp mode and thread count from /proc.
Result: 3 x 200 in each mode, both alive after, Seccomp 2, 65 threads each (so glibc's pthread_create, refused clone3
with ENOSYS, fell back to clone and the runtime's thread pools came up). CONTROL: the same launcher running a program
that opens an AF_VSOCK socket gets EPERM. Together with enclave-5d's earlier measurement (io_uring, setns and
CLONE_NEWUSER killed), the full list does not stop wasmtime in either mode.
