# Candidate b7ba7731 (digest 56FBB27F): first boot, serving, and the live-neighbour probe with the TPM control (run 093904)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Box-clock log lines. Log:
[uefi-dev-boot-20260925-093904.log.txt](uefi-dev-boot-20260925-093904.log.txt).
- Image: enclave-63's v36, `pkg\3384e097aa024b73\guest\igvm-vbs\vbs-linux-candidate-1539-b7ba7731.bin`. It was
  re-hashed at use: `b7ba7731240ec9025f8c…`, 77,794,396 B. My byte review is `fd92d610`.
- Initrd `1539d5b2`, whose domprobe `2c260049` has the open-only TPM control.
- Script: `uefi-dev-boot.ps1` at `ad61cb02` (the shared judge under enclave-99's rules), with
  `-LinuxDirect -IsolationType 1 -VbsOptOut -Bundle hello-world -ProbeNeighbor`.
- The neighbour was served by the box's `target\release` wmiserve `0160d835`, not by the package's `435717de`.
- AllowFirmwareLoadFromFile and the 9001 service were restored and removed (verified), and the VM was removed.

**Established (measured on this host):**
- **It boots.** `b7ba7731` is accepted by Start-VM as a type-1 partition under Secure Boot, with no medium, and reaches
  `MON ready` (boot `5ad7d689…`).
- **It serves.** The pinned fixture served exactly `03ba204e…` through the guest's own TLS. curl -k accepted the guest
  cert, so this shows serving, not identity.
- **The TPM control ran, and its result has a limited meaning.** `PROBE2 dev_tpm0=No such file or directory` and
  `PROBE2 dev_tpmrm0=No such file or directory`: the TPM nodes are ABSENT FROM THE DOMAIN'S VIEW. Their existence in the
  guest's root namespace is not stated by this build. So this is not "an existing device was denied".
- **The rest of the judge:**
  - the neighbour was live BEFORE and AFTER (relay `03ba204e`, and the monitor's list showed domain 1 with AppID
    `9c3d10f1`);
  - own_app READABLE (6 bytes), the positive control for the view;
  - uid 5002; visible_pids 2 and signalable_pids 1;
  - memory CONTAINED: 48 MiB touched of its 64 MiB cap, then killed (137);
  - nothing reached.

**Verdict: INCONCLUSIVE, as expected on this build.**
- The file-route targets' existence in the root namespace is not stated.
- vsock to CID 1 is no in-guest route (no loopback transport).
- report=refused is not cross-domain evidence.
- host_excluded=no.

**For enclave-63's rollover rule** (a new candidate stays eligible:false until its own canary boots and serves): this
run shows it boots and serves. Whether it replaces `a44bb55a` as the eligible digest is 63's and 99's call under that
rule. Its only difference from `a44bb55a` is the rebuilt domprobe inside the measured initrd.
