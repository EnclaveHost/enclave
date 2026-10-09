# pVM marketplace host: device check (2026-10-09 02:03Z, Pixel 10 Pro XL, release build 51aa6f5e)

The release APK (host.enclave.pvmcpu, code hash 51aa6f5e35aa9e29e0154b90e227f90d3cb647ca9a755bf0c318b2c9096f6ecc) served
cpu-probe (3577d216…) with `--ei app_tls 2` (APP serve=https-p256), with no relay reachable (the VM serves anyway). From
warden-host, over `adb forward tcp:17786` and `tcp:17787`:

| check | result |
|---|---|
| TLS GET /ping on the app port | 200 `{"ok":true}` |
| GET /.well-known/enclave-attestation?nonce=N over the same TLS | 200, `enclave-pvm-app-evidence/v4`, nonce N, 5-certificate AVF chain (5646 bytes; kept as a relay test fixture, not here) |
| the TLS key a client sees | sha256(SPKI) 8f71a265…, equal to the VM's `APP tls key` line and to the CSR's key |
| GET /.well-known/enclave-ready | 200 `{"ok":true}` |
| evidence bridge without AUTH, or with a wrong token | `{"error":"bridge: AUTH <token> first"}` |
| `CSR 0a1b2c3d.app.enclave.host` | PKCS#10, self-signature OK, CN = the one SAN = the name, the TLS key (req.der) |
| `CERT` with a test CA's chain for that request | `{"ok":true,"certs":2}`; curl with only the test CA trusted: 200; another name: refused |
| a second CERT within 10 s | `at most one CERT every 10 s` |
| a valid chain for another key | `the leaf certificate is not for this server's key`; the installed chain still serves |
| a 24-step CPU request (8.4 s) and a /ping started 1.5 s later | the ping answered in 69 ms |

vm-capture.log is the host app's capture (the bridge token is never logged; it is in the app's external files dir).
