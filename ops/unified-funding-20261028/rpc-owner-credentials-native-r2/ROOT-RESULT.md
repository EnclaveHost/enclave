# Owner-controlled credential and private seed qualification

The maintained credential module and optional private NoCloud seed integration
passed 15 actual tests in an isolated user/PID/mount/network namespace. Disposable
keys, TLS sockets and ISO contents existed only in private tmpfs, removed with the
namespace. No production keys, VM, chain client, storage export or data was touched.

Actual r2 invocation 74fc48382c3044b79a6948b142212f8e: terminal0/MainPID0,
15 PASS, 0.956s unittest / 1.126s bounded capture. 256MiB outer,220MiB RSS guard,
27648MiB host floor, CPU1,noSwap. Peak tree RSS57MiB,minimum host32074MiB.
All seven input pins and maintained source bytes matched after execution.

Tests cover actual generated certificate/key pairs, separate role authorities,
mutual TLS, cross-role and hostname refusal, key/receipt/guest substitutions,
symlink/mode refusal, exclusive attempts, guest-only client material, pinned SSH
identity, actual xorriso build/extraction comparison, private output permissions
and public-result omission of private keys. The ISO uses a tiny synthetic runtime
archive and no executable payload. No cloud-init initialization or target kernel
behavior was executed. The changed private config has not yet passed the target's
installed cloud-init schema/first-boot qualification.

Original r1 invocation9b4d32e73eab47d984811a2387b818c1 terminal1 is retained:
ssh-keygen exited255 before tests in a namespace without /etc/passwd. R2 adds
only a private synthetic root passwd/group fixture; unchanged product source then
passed. No host account database was exposed or altered. No completed unit replay.

Current public identity-only production candidate artifacts are unchanged. This
source integration does not enable attachment or clients and does not prove the
20GiB RPC stack fits or synchronizes. Storage-host admission remains short2040MiB
under the retained floor/pending accounting. No unrelated workload was terminated.
