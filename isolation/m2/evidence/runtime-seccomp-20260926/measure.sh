#!/bin/sh
# wasmtime 48.0.1 (the guest's runtime) under app-seccomp.h's FULL filter, serve and run mode; inside a user+net namespace
ip link set lo up
W="~/enclave-prod/release-4cdd5169/template/rt/ld-linux-x86-64.so.2 --library-path ~/enclave-prod/release-4cdd5169/template/rt ~/enclave-prod/release-4cdd5169/template/rt/wasmtime"
wait_port() { for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 0.1; done; return 1; }
seccomp_of() { grep -E '^Seccomp:' /proc/$1/status | tr -d '\t ' ; }
echo "== SERVE (wasi:http, ~/.cache/enclave-isolation/m2-regress/app-A.wasm)"
<scratch>/launch ~/enclave-prod/release-4cdd5169/template/rt/ld-linux-x86-64.so.2 --library-path ~/enclave-prod/release-4cdd5169/template/rt ~/enclave-prod/release-4cdd5169/template/rt/wasmtime serve -S cli -C cache=n --addr 127.0.0.1:8080 ~/.cache/enclave-isolation/m2-regress/app-A.wasm > <scratch>/serve.out 2>&1 &
P=$!; wait_port 8080 && echo "listening"; echo "pid $P $(seccomp_of $P) threads=$(ls /proc/$P/task | wc -l)"
for i in 1 2 3; do printf 'GET / -> %s\n' "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:8080/)"; done
kill -0 $P && echo "alive after 3 requests ($(seccomp_of $P), threads=$(ls /proc/$P/task | wc -l))"; kill $P; wait $P 2>/dev/null
echo "== RUN (wasi:cli socket server, sentinel)"
<scratch>/launch ~/enclave-prod/release-4cdd5169/template/rt/ld-linux-x86-64.so.2 --library-path ~/enclave-prod/release-4cdd5169/template/rt ~/enclave-prod/release-4cdd5169/template/rt/wasmtime run -S cli -S tcp -S udp -S inherit-network -S allow-ip-name-lookup -C cache=n --dir <scratch>/data::/data --env ENCLAVE_PORTS=http:8000=8000 <scratch>/sentinel.wasm > <scratch>/run.out 2>&1 &
P=$!; wait_port 8000 && echo "listening"; echo "pid $P $(seccomp_of $P) threads=$(ls /proc/$P/task | wc -l)"
for i in 1 2 3; do printf 'GET /r%s -> %s\n' $i "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:8000/r$i)"; done
kill -0 $P && echo "alive after 3 requests ($(seccomp_of $P), threads=$(ls /proc/$P/task | wc -l))"; kill $P; wait $P 2>/dev/null
echo "== CONTROL: the same launcher, a program that tries AF_VSOCK"
<scratch>/launch /usr/bin/python3 -c 'import socket
try:
    socket.socket(40, socket.SOCK_STREAM)
    print("AF_VSOCK socket OPENED")
except OSError as e:
    print("AF_VSOCK refused:", e.errno, e.strerror)'
