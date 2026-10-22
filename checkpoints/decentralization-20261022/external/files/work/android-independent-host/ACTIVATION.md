# Independent Android host: deferred activation, signing, update and rollback (ROOT/OWNER ONLY; nothing here was done)

The phone is untouched. No keystore, private key, wallet or device secret was read. Every artifact here is UNSIGNED.

## What is installed now (read-only evidence)

| fact | value | how established |
|---|---|---|
| package / versionCode | `host.enclave.pvmcpu` / 6 (`versionName` 0.1) | `dumpsys package` (earlier, read-only) |
| installed APK | sha256 `0d56f9558031cc203b7dbb9a9279e2471e9fe7fc17ff9bada3f7a7a467cff9f1` | the public `base.apk`, pulled read-only |
| signer certificate | SHA-256 `867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d` | `apksigner verify --print-certs` |
| installed classes.dex | `8bb873a0…` = the rebuild of `enclave-hosting-ui-android@ea8210a55` host/app (byte-identical) | `build-artifacts.sh` "base dex == INSTALLED dex" |
| installed code hash (fs-verity root) | `ff559327385fec363bc757837307edc5f6aaae49566578be9cd5731f11eea848` | `runner/verifier-inputs.mjs` over the installed APK |
| installed agent bundle | older than ea8210a55's own build: its network child REQUIRES a relay (no directories) | asset diff |

## 1. Review (root)

- `work/android-independent-host/android-independent-host.patch`: base = main's working tree (BASE.txt) plus the deployed
  Android sources; `MANIFEST.json` gives each file's base and new sha256 and every suite's result.
- Choose ONE dex variant:
  - `candidate`: independent hosting only.
  - `candidate-relaydial`: independent hosting plus the phone-dns-recovery `RelayDial` fix (`host-relaydial.patch`, tested
    separately, applies cleanly). Recommended, because legacy mode also stops depending on the device DNS for the relay.

## 2. Sign (owner, on the owner's own machine; the same key as the installed app, or Android refuses the update)

```sh
BT=$ANDROID_HOME/build-tools/35.0.0
"$BT/apksigner" sign --ks "$ANCHOR_RELEASE_KEYSTORE" --ks-pass "file:$ANCHOR_RELEASE_PASS_FILE" --ks-key-alias "${ANCHOR_RELEASE_ALIAS:-release}" \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true \
  --out host-candidate-signed.apk work/android-independent-host/artifacts/apk-candidate-relaydial-unsigned.apk
"$BT/apksigner" verify --print-certs host-candidate-signed.apk | grep -E 'SHA-256|Verified'
# REQUIRED: "Signer #1 certificate SHA-256 digest: 867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d"
```

These flags are build.sh's release flags. A different key cannot update the installed app. Uninstalling it to install
another key would delete its VM instances (their keys, the proof key, the registration's binding).

**Optional, owner-built release carrying the owner's choice.** Before signing, add `assets/agent/independent.json` (and,
if used, its `lease-gas.json` record) to the APK. The file is public and covered by the signature and code hash. Then the
phone selects independent hosting with no private-storage write. Without it, the phone stays in legacy mode until a
`files/agent/independent.json` exists.

## 3. Publish the pVM build approval (governance; exact content binding)

The code hash is the fs-verity Merkle root of the SIGNED APK, so it exists only after step 2.

```sh
node shielded/anchor/avf/runner/verifier-inputs.mjs --apk host-candidate-signed.apk --build shielded/anchor/avf/standalone/build.json --out pvm-verifier-inputs.json
# -> {"sha256": "<digest>", "codeHashes": ["<the signed APK's code hash>"]}
```

- The platform reviews and publishes the digest. Owners pin it in `verifierInputs.sha256`.
- Serve the exact bytes from 2 or more independently chosen HTTPS sources.
- Keep the installed build's document (`artifacts/verifier-inputs/installed-0d56f955.json`, digest `afa76485cfff…`) during
  the transition, if both builds should verify.
- Legacy mode also needs the new code hash added to Nan's `PVM_CPU_CODE_HASHES`, or a relay-mode phone on the new build
  is refused by the relay.

## 4. Install (root, after an explicit restart window; it ends the running pVM sessions)

```sh
ADB=/home/steven/Android/Sdk/platform-tools/adb; S=YV4FGO7B9WS7F4
$ADB -s $S shell dumpsys package host.enclave.pvmcpu | grep -E 'versionCode|lastUpdateTime'   # record before
$ADB -s $S install -r host-candidate-signed.apk                                               # same package, same key, versionCode 6
```

- `MY_PACKAGE_REPLACED` restarts `AgentService` (BootReceiver.java), and the agent relaunches the host VM and each slot on
  its held lease.
- Same-key updates keep each VM's InstanceID, measured on this Pixel (INSTANCE-BINDING.md). So the proof key and the
  instance pins survive.
- The registry measurement must change to the new code hash. The runner re-states it with one operator-paid `register`
  (re-state), which is the shared "on an actual mismatch" rule.
- Expect an outage of each served app for its VM's relaunch.

## 5. Verify (root)

- Legacy mode (no `independent.json`): agent log `"ev":"start"` with `relayOrigin` and the relay re-attach as before.
- Independent mode:
  - `"ev":"independent"` names the profile and the verifier-inputs source; `platform-policy` serving true;
  - `capacity-published` ok in the owner's directories;
  - no `enclave.host` request in the agent log;
  - a client's `network/native-client.mjs` pvm profile, or `network/pvm-independent-admission.mjs`, admits a served
    deployment over its own nonce.

## 6. Rollback

```sh
$ADB -s $S install -r /home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/claude/installed-host.apk
```

- This is the original signed APK: same package and key, versionCode 6. Equal versionCodes install with `-r`. The
  candidate deliberately keeps 6, so rollback needs no uninstall.
- The runner re-states the registry measurement back to the old code hash (`ff559327…`).
- Delete `files/agent/independent.json`, or ship no asset copy, to return to legacy mode without reinstalling.
- Never uninstall: that destroys the VM instances.

## Not covered (stated, not faked)

- **Secrets.** pVM app secrets: the measured payload pins the relay's release keys, so independent mode refuses apps that
  need them. Lifting this needs a new measured build verifying a custody-v2 release (a governance decision).
- **Browser access.** It needs WebPKI and DNS. Native clients pin the attested key instead.
- **Lease gas.** The app-funded reserve's funding awaits human approval (root's gate). Until then independent claims and
  renewals are refused with the reserve's reason; there is no operator-paid fallback.
