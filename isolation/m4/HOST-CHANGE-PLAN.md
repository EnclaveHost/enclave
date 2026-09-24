# Host change and recovery plan: second-plane precondition 4

**Status: a plan, read-only. Nothing in it has been installed, activated, rebooted or approved.** Written
2026-09-24 from existing documentation (`m3/PLAN.md` sections 13 and 16, `m4/svsm/README.md` "What a second
plane requires", `m4/HANDOFF.md`) and from read-only facts gathered on warden-host that morning. Not
independently reviewed. The decision to change the host is Steven's.

## Read this first: what is NOT established

- **The remedy for precondition 4 is not decided, and neither is whether it needs a host change at all.**
  `svsm/README.md` states the precondition as a hypervisor-side one: the planes kernel's `sev_snp_ap_creation`
  checks only `vmpl < VMPL_MAX` and that VMPL0 is replaced only by a VMPL0 vCPU, "and the SVSM is not in that
  path". A later, unfinished lead (`HANDOFF.md`, "Unfinished investigation") found that a Linux guest that is
  not at VMPL0 creates vCPUs through the SVSM's `SVSM_CORE_CREATE_VCPU` instead of RMPADJUST. So for our
  topology the SVSM may be in the path, and what it checks about the calling plane was not read. That
  investigation is provider-blocked in this lane and is **not** continued here.
- So this plan does **not** contain a patch, and nothing in it should be read as implying one exists or is
  needed. The possible outcomes of the open question are, at least: an SVSM-only change (measured, shipped in
  the IGVM, **no host change**, and this plan is unnecessary); a host KVM change; or both.
- **The second-plane blocker stands whatever happens here.** No run is to be scored as isolation until
  precondition 4 is resolved AND a second plane has been tested for the property. That test needs a second
  plane, which is a separate campaign and is not authorized now. A host change on its own validates nothing
  about isolation.

## Decisions, and who holds them

| decision | holder | state |
|---|---|---|
| finish reading the vCPU-creation path for the plane topology we run (SVSM `core_create_vcpu` caller checks; the host AP-creation path) | route to be chosen by Steven | blocked in this lane |
| where the remedy lives: SVSM, host KVM, or both | follows from the row above | open |
| whether to change the host, when, and who attends | Steven | not asked yet; not needed until the row above says "host" |
| a second-plane campaign to test the property | Steven | not authorized |

## The host as it is (read-only, 2026-09-24)

| | |
|---|---|
| host | warden-host |
| running kernel | `7.2.0-gbf5bafed3e6d`: coconut-svsm/linux `svsm-v7.2` at `bf5bafed3` ("KVM: selftests: Test SNP vCPU state and direct VMSA launch"), `.config` from this machine's `localmodconfig` (`~/.cache/enclave-isolation/planeskit/linux/.config`, 2026-09-23 10:43) |
| booted from | the **non-default** GRUB entry: `BOOT_IMAGE=/planes/vmlinuz`, sha256 `a47042d2e48a7349f16d679ec62a5fce26c9415b0ef92e40d28f7fabc7ed575a`; up since 2026-09-23 12:37:12 |
| default entry | entry 0, `/boot/vmlinuz-linux`, sha256 `1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7`; `GRUB_DEFAULT=0`, `GRUB_TIMEOUT=5`, menu shown; `grubenv` `next_entry` empty |
| command line | `iomem=relaxed rd.luks.name=13b83097-e9df-4762-9e50-a3816f64ba1c=cryptroot root=/dev/mapper/cryptroot loglevel=3 quiet usbcore.autosuspend=-1` |
| boot and root | GRUB 2.14; `/boot` is a vfat ESP with 797M free; root ext4 on LUKS `cryptroot` |
| network | the only real NIC is USB ethernet (`r8152`), which needs `usbcore.autosuspend=-1` |
| GPUs | RTX 3070, Tesla PG500-216, Tesla V100-PCIE-32GB on NVIDIA 580.178.04 (DKMS); the planes build of the modules is in `~/.cache/enclave-isolation/nvbuild` |
| installed planes pieces | `/boot/planes/{vmlinuz,initramfs.img}`, `/etc/grub.d/42_planes`, `/usr/lib/modules/7.2.0-gbf5bafed3e6d` (`install-planes-kernel.sh check`) |
| out-of-band access | none: `/dev/ipmi0` exists but no IPMI tool is installed, and there is no `console=` |
| privileges | no passwordless sudo, and every agent session runs **on this host**, so a reboot ends the agent that would verify it |
| services of note | sshd, zerotier-one, NetworkManager, docker/containerd, libvirtd, proton.VPN, the ly display manager; user service playwright-mcp |

### A consequence that holds today, before any change

**Any reboot returns the machine to the default distro kernel**, including an unclean one like the stop at
2026-09-23 09:01:45. The distro kernel has no KVM planes, so every M3b/M4b run then fails with
`KVM plane 2 is not supported`, which is stage A7's documented negative. That is a failed precondition,
not a finding. Recovery is to select "Linux (KVM planes...)" in the GRUB menu (keyboard, 5-second window),
or to run `sudo grub-reboot <that entry>` before a planned reboot.

## If the decided remedy includes a host kernel change

This reuses the procedure that took the planes kernel onto this machine on 2026-09-23 (`m3/PLAN.md`
section 13), because it was built to be reversible and it worked: stage A health, stage B regression and
stage C all passed after an attended, non-default boot.

1. **Identity of the change.** Base `bf5bafed3`, and the patch as a file committed in this repository with
   its sha256. Record an independent review of that patch, which is not available today.
2. **Build** with `m3/build-planes-host.sh` from the same `.config`, with a **distinct kernel release
   string** (a `LOCALVERSION` suffix, for example). Without it, `/usr/lib/modules/7.2.0-gbf5bafed3e6d`
   would be overwritten, and the kernel that works today would lose its modules.
3. **NVIDIA**: rebuild 580.178.04 against the new tree in `nvbuild` using the `dkms.conf` make line, then
   confirm zero errors and the new vermagic **before** installing. Other sessions depend on CUDA here.
4. **Installer prerequisite, not yet done:** `m3/install-planes-kernel.sh` installs to the fixed paths
   `DEST=/boot/planes` and `/etc/grub.d/42_planes` (`install -D` over `$DEST/vmlinuz`), with no refusal when
   they already exist. As written it would **replace the planes kernel that works today**, which is the
   fallback. Worse, its failure handler runs `rm -rfv "$DEST" "$GRUBD"` so that a failed install leaves
   nothing bootable, which means a *failed* second install into the same paths would **delete** today's
   working planes kernel and its menu entry. It needs a parameterised
   destination and entry (e.g. `/boot/planes-<tag>`, `/etc/grub.d/43_planes_<tag>`) before it can install
   a second kernel. Its existing safeguards stay: files outside the `/boot/vmlinuz-*` glob, the entry after
   every generated one, and a read-back of `grub.cfg` that refuses to finish if entry 0 moved.
5. **Before the reboot, record** `uname -r`, `/proc/cmdline`, the sha256 of every installed kernel, the
   `grub.cfg` entry list, `nvidia-smi -L`, `ip route` and the running services into `~/enclave-bench/`. Do
   not use `/tmp`: the scratchpad is tmpfs, and a reboot wipes it.
6. **Announce, and have every session park its work.** The reboot ends all of them, including the one that
   would verify the result.
7. **Boot the new entry once**: attended at the GRUB menu, or with `grub-reboot`. Never make it the default.
8. **Validate**, as a person or as an agent reconnecting afterwards:
   - `m3/m3b-verify.sh <workdir> <new release>`, which stops at the first failure:
     - **stage A (health):** the intended `uname -r`; all three GPUs; a default route; DNS; `sshd`; and the plane gate, checked against its real negative.
     - **stage B (regression):** M1, M2 and M3a re-run unchanged.
     - **stage C (boundary):** the full boundary run on the new kernel.
   - the M4b one-plane suites:
     - `verify-measured-boot.sh` (step 2, with `RELEASE_FW=` for cases 6/7);
     - `verify-plane.sh`, 10 checks;
     - `verify-runtime-set.sh`, good plus 2 negatives.
   - **What none of this validates** is precondition 4 itself. That needs a second plane and a property
     test designed once the mechanism is known. Neither exists, and a two-plane campaign is not authorized.
9. **Keep or roll back.** Any stage-A failure means roll back and attempt nothing else.

## Rollback and recovery

- **Rollback:** reboot and choose the existing planes entry (`/boot/planes/vmlinuz`, `7.2.0-gbf5bafed3e6d`)
  or entry 0. Nothing that boots today is replaced, provided step 4 was done. Then remove the new entry with
  the parameterised installer's uninstall.
- **The new kernel does not boot, or boots without network:** someone has to be at the keyboard, and the
  GRUB menu is the rollback. There is no out-of-band path.
- **It boots but the GPUs do not come up:** roll back. Other sessions' CUDA work depends on them.
- **The root does not unlock:** the command line must carry `rd.luks.name=` and `root=` verbatim, as the
  existing installer copies them from `/etc/default/grub`. Losing either one means a keyboard visit.
- **An agent cannot do steps 4 to 9.** There is no passwordless sudo, and the reboot ends the agent. They
  are for a person at the machine.

## What this plan deliberately leaves out

A patch, or any claim that one is needed. Any instruction to act now. Any change to host security settings.
And any use of the unfinished lead above to relax or dissolve the second-plane blocker.
