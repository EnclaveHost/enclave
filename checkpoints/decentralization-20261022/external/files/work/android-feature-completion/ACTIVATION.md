# Android feature completion: signed-artifact handoff and device activation (ROOT/OWNER ONLY; nothing here was done)

The phone is untouched. No keystore, private key, wallet or device secret was read. Every artifact here is UNSIGNED.
Exact bytes and hashes: `MANIFEST.json` (artifacts) and `HANDOFF.json` (the per-entry APK diff). Every value below is
copied from them.

## 0. What is installed now (unchanged from the frozen candidate's ACTIVATION.md, read-only evidence)

| fact | value |
|---|---|
| package / versionCode | `host.enclave.pvmcpu` / 6 |
| installed APK | sha256 `0d56f9558031cc203b7dbb9a9279e2471e9fe7fc17ff9bada3f7a7a467cff9f1` |
| signer certificate | SHA-256 `867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d` |
| installed code hash | `ff559327385fec363bc757837307edc5f6aaae49566578be9cd5731f11eea848` |
| installed payload `libanchor.so` / `libpvm_rt.so` | `5916c1dc…` / `904d9048…` |

## 1. What changes in the APK (the per-entry diff; everything else byte for byte the installed APK)

- **`classes.dex`.**
  - The Java host maps the options-file `STARTUP` line to `APPSTARTUP`.
  - EgressPool carries `CUSTODYAUTH`.
  - Plus the frozen candidate's `independent` extra, and the RelayDial fix (variant `feature-relaydial`, recommended).
- **`assets/agent/*.mjs`.** The agent bundle:
  - independent hosting (frozen candidate);
  - owner startup packages (owner's file or gateways, sha-checked);
  - operator `CUSTODYAUTH` for the launch's own deployment.
- **`lib/arm64-v8a/libanchor.so`.** The measured payload:
  - APPSTARTUP;
  - the custody callbacks: egress dial, AVF attest with an app check and instance signature, and authorize;
  - its refusals;
  - zeroing.
- **`lib/arm64-v8a/libpvm_rt.so`: UNCHANGED** (the installed `904d9048…`). The payload hands it an ordinary environment
  block: ENCLAVE_CONFIG = the owner's config resolved in libpvmcustody, plus the values.
- **`lib/arm64-v8a/libpvmcustody.so` (NEW).** The Go custody v2 client (isolation/m2/pvmcustody, frozen
  bootstrap + custody packages).
- **Unchanged:** the manifest (package, versionCode 6, permissions), resources, build.json, idle-app.wasm, libpvm_rt.so,
  libnode.so, libenclavewg.so and libc++_shared.so.

The **payload changes, so the code hash changes**: the AVF codeHash is the fs-verity root of the SIGNED APK.

## 2. Sign (owner, on the owner's machine; the SAME key as the installed app)

```sh
BT=$ANDROID_HOME/build-tools/35.0.0
"$BT/apksigner" sign --ks "$ANCHOR_RELEASE_KEYSTORE" --ks-pass "file:$ANCHOR_RELEASE_PASS_FILE" --ks-key-alias "${ANCHOR_RELEASE_ALIAS:-release}" \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true \
  --out host-feature-signed.apk work/android-feature-completion/artifacts/apk-feature-relaydial-unsigned.apk
"$BT/apksigner" verify --print-certs host-feature-signed.apk | grep -E 'SHA-256|Verified'
# REQUIRED: "Signer #1 certificate SHA-256 digest: 867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d"
# check the signed APK's payload is the reviewed one (signing never touches entries):
unzip -p host-feature-signed.apk lib/arm64-v8a/libanchor.so | sha256sum      # == MANIFEST artifacts/native/payload-candidate/libanchor.so
unzip -p host-feature-signed.apk lib/arm64-v8a/libpvmcustody.so | sha256sum  # == MANIFEST artifacts/native/libpvmcustody.so
```

The same key keeps the package, its data and **every VM instance**:

- `InstanceID` survives same-key updates, including a payload change. This was measured on this Pixel
  (INSTANCE-BINDING.md: "the same across a same-key APK update that changed the payload code").
- So the proof key, the instance pins, the relay-era seal keys and the custody `instances` bindings all survive.
- A different key cannot update the app. Uninstalling to change keys would destroy the instances: never do it.

## 3. Release measurement and admin authorization (governance; exact content binding)

```sh
node shielded/anchor/avf/runner/verifier-inputs.mjs --apk host-feature-signed.apk --build shielded/anchor/avf/standalone/build.json --out pvm-verifier-inputs.json
# -> {"sha256": "<digest>", "codeHashes": ["<the signed APK's code hash>"]}
```

- **Platform admin.** Reviews the signed APK and publishes the verifier-inputs digest. Owners pin it in
  `verifierInputs.sha256`, served from 2 or more independent sources.
- **Overlap.** Keep the installed build's document (`afa76485…`) while both builds should verify.
- **Legacy mode.** Add the code hash to Nan's `PVM_CPU_CODE_HASHES` only if the relay path must keep serving; independent
  mode does not need it.
- **Registry.** The operator's `register` re-states `measurement` to the new code hash, once, on the actual mismatch (the
  shared rule). The same endpoint, enclaveId, operator, owner acceptance and payout are kept. No registry, admin,
  ownership or contract change is made.
- **Platform host policy** (admin bans and admission) and the **catalog approval** apply unchanged: the new build is
  admitted by verifiers only under them.
- **Custody (to serve custody-v2 apps on the phone).** Each step is a governance or owner act:
  1. Custodian operators rebuild with `--transport direct --avf-recipients avf.json`. That is a new custodian
     measurement: code permit, then a committee handover.
  2. Owners commit AVF rules naming the signed APK's (codeHash, authorityHash = SHA-512 of the signer certificate) and the
     runtime id `d3370878…`, optionally pinning `instances`.
  3. Owners publish a startup package.

## 4. Install (root, after an explicit restart window: it ends the running pVM sessions)

```sh
ADB=/home/steven/Android/Sdk/platform-tools/adb; S=YV4FGO7B9WS7F4
$ADB -s $S shell dumpsys package host.enclave.pvmcpu | grep -E 'versionCode|lastUpdateTime'   # record before
$ADB -s $S install -r host-feature-signed.apk                                                 # same package, same key, versionCode 6
```

`MY_PACKAGE_REPLACED` restarts `AgentService`, and the agent relaunches the host VM and each slot on its held lease.

## 5. Device proof (root; this is the real-device proof nothing off the device can replace)

1. **Boot and evidence.**
   - The agent log shows `"ev":"vm-serving"` for every slot.
   - The v4 evidence from each slot verifies under the NEW code hash (`network/pvm-independent-admission.mjs`), for the
     same InstanceIDs as before.
2. **Legacy apps keep serving.** Relay mode, or an independent `$NAME`-free config.
3. **A custody-v2 test deployment** (owner's test secret only). The proof passes when:
   - the VM console shows `CUSTODY owner startup`, then `CUSTODY attested: N certificates`, then `CUSTODY ready`;
   - every custodian logs `release … OK (… measurement <signed code hash>…)` and NOT "SYNTHETIC";
   - the app sees its value;
   - the host agent log shows `custody-auth` for that deployment only.
4. **Refusals.**
   - The same package with a wrong committed sha is refused at the host and in the VM.
   - A host-set ENCLAVE_CONFIG beside a package is refused by the payload.
   - Revoking the deployment's lease ends `Revalidate`.

## 6. Rollback

```sh
$ADB -s $S install -r /home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/claude/installed-host.apk
```

- The original signed APK has the same key and versionCode 6, so it reinstalls without an uninstall, and the VM instances
  survive.
- The operator's `register` re-states the old code hash (`ff559327…`).
- Custody-v2 apps then stop being served on the phone (the old payload has no custody client). That is a refusal, never a
  leak.
- Never uninstall.

## 7. Not covered (stated)

- **Browser names.** See `BROWSER-NAMES.md`: the in-VM ACME client and the attested responder's AVF mode are not built.
- **Funding.** See `FUNDING-PLAN.md`: the phone's apps are not in the approved 25-operation enrollment. A separate public
  plan only.
- **Byte reproducibility of the native libraries.** See MANIFEST `native.base` (whether the base payload rebuild equals the
  installed one).
