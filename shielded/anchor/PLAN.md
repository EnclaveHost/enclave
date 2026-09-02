# Phone-anchored Shielded: the build plan

Target support statement, as customers will read it: **Google Pixel 9a, and Pixel 10 or
newer.** The rule that generates it, and that the verifier actually enforces: launched on
Android 15 or later (vendor API level >= 202404, so the RKP `/avf` component is admitted),
protected VMs offered, remote attestation verified per model. The Pixel 9, 9 Pro, 9 Pro XL
and 9 Pro Fold launched on Android 14 and are excluded; nothing from another maker offers
protected VMs today (SIGNING.md).

What the phone is for: the operator owns a GPU box and a phone. The GPU box is untrusted
and runs `worker-cuda`. The phone runs the trusted half in a protected VM its owner cannot
read, and proves to the platform, with Google's certificate on a key that exists only inside
that VM, which code is running and behind what boundary. Prompts are decrypted, unmasked,
verified, sampled and cached on the phone; the GPU only ever sees masked planes.

## Decisions taken (change here, not in the code)

- **v1 hosts an engine, not apps.** The pVM terminates an end-to-end session from the user's
  client (prompt in, tokens out) and runs the model's trusted half. Wasm apps do not run on the
  phone; a phone-anchored host serves the platform's inference verbs, not the app catalog.
- **The phone is a client.** It connects out (to the operator's GPU box and to the relay); nothing
  connects in. Phones live behind NAT and carrier networks.
- **The host app is untrusted plumbing.** It owns the VM and relays bytes. It never sees a pad, a
  plaintext activation or a product: worker traffic is ciphertext frames, user traffic is inside
  the session the pVM terminates. So the operator modifying it changes nothing.
- **Google is the root, Enclave.host is the policy.** The platform verifies the RKP chain, pins
  the anchor's code hash and the APK's signing certificate, and issues its own credential. It
  does not, and cannot, replace the root (REPORT.md section 9 discussion; SIGNING.md).
- **Badge from evidence.** A phone-anchored host earns the TEE CPU pill only when the verifier
  has accepted its chain, never from the model name.

## Phases

### 1. Product-shaped app, real GPU worker (DONE 2026-09-02, REPORT.md section 10)
`shielded/anchor/avf/`: one APK carrying the payload and the owner app.
- Foreground service owns a protected, non-debuggable VM (done; REPORT.md section 9).
- Support gate at start: protected VMs + vendor level + attestation capability, reported plainly.
- Control channel (vsock 7777): challenge in, attestation chain + results out.
- Worker bridge (vsock 7778 <-> TCP): the pVM drives a real `worker-cuda` through the app.
- Proof: the split against the RTX 3070 from inside the pVM reproduces the x86 harness's digests
  bit for bit (section 10). Runs on the Pixel 8 Pro today (attestation reports UNSUPPORTED there).
- Open: the Java bridge costs ~4 ms per exchange; native bridge or guest networking.
- Signing: the spike key is generated locally and never committed; the release key moves to the
  platform certificate service before anything ships.

### 2. The verifier (needs the Pixel 10 Pro XL's chain as the first vector)
On the relay: parse the certificate chain the app forwards, verify to Google's RKP root, read
the AVF extension (challenge, isVmSecure, vmComponents{codeHash, authorityHash}), pin codeHash
to the published anchor build and authorityHash to the platform's APK signing certificate,
bind the challenge and the VM's session key, issue the Enclave credential, and attach the
evidence the fleet badge reads. Fail closed on any unpinned root or unknown hash.

### 3. The real trusted half in the pVM
Port the ggml-shielded engine (llama.cpp CPU path + the shielded backend now living in the
wasmtime patch) to Microdroid: model weights arrive public over the bridge, the KV cache and
nonlinears run in the VM, pads are banked on the spare vCPUs (i8mm/SDOT refill kernels), the
session key is the attested key. Memory scaling: large `--mem` VMs, no 48 MiB ceiling here.

### 4. Operator flow and fleet
Pair the phone with the GPU box's enclave agent (the `enclave://` pairing the mobile shell
already uses), register a "phone-anchored shielded host", per-host pricing as today, badge.
Distribution: `MANAGE_VIRTUAL_MACHINE` is grantable by adb only, so early operators sideload
and grant; the retail path is an OEM or Play conversation, not code.
