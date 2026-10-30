# A pVM CPU host in production (2026-10-08)

The Pixel 10 Pro XL serves as a pVM CPU host on the production relay. It appears on `https://api.enclave.host/enclaves` as
`pixel10-pvm-cpu`, with mode `avf`, tier and lane `pvm-cpu`, and measurement `d2538636…`. That measurement is the release
build's code hash, which nan's relay pins (`live-enclaves-row.json`).

- **Build.** `host.enclave.pvmcpu`, signed with the release key (`~/.config/enclave/pvm-cpu/release.jks`, not in git). Its
  authority hash is `98ca749a…`. It comes from branch pvm-cpu/cpu-only 7373dec0f+ and was built with
  `ANCHOR_TIER=pvm-cpu ANCHOR_MODE=protected ANCHOR_RELEASE_KEYSTORE=… ./build.sh anchor`.
- **Relay.** /etc/nan-relay/api-relay.env gained `PVM_CPU_CODE_HASHES`, `PVM_CPU_AUTHORITY_HASHES` and `PVM_CPU_RUNTIME_IDS`
  (pvm-rt d3370878…), restarted 11:00:58Z. The backup is api-relay.env.bak-pvmcpu-20261008. Relay code: main 0af0ea4ce
  (CPU-only tier; a pVM-only policy attaches phones).
- **Host.** `cpu/prod-host.sh out/anchor-pvm-cpu-release.apk` runs the foreground service in mode app with `app_serve_s 0`,
  serving cpu-probe until stopped. It is attached to `wss://api.enclave.host/v1/fleet-tunnel` as `pixel10-pvm-cpu`.
  - `prod-1.log`: the attestation was ACCEPTED at measurement d2538636…; the capability report (v2, relay-bound, CPU-only,
    no model) was ADMITTED as tier pvm-cpu; the relay keeper is armed and a keepalive runs every 30 min.
  - The app is exempt from Doze (`dumpsys deviceidle whitelist +host.enclave.pvmcpu`), and the phone is on USB power.
- **Not yet:** the host serves no deployments. A pVM is "not in the app serving set": TUNA routes for it, the owner's serving
  scope and the runner's on-chain registration are still open (PVM-CPU.md, "Production path").

To stop the host, run `adb shell am force-stop host.enclave.pvmcpu`. To roll the relay back, restore the env backup and
restart `enclave-api-relay`, after the prediction check.
