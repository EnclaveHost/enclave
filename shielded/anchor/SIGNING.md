# TA signing: the vendor programs, and the way around them

**Read this first (2026-08-31).** The three vendor programs below are all dead ends for a solo
LLC, and the S21+ closes every one of them. But "no vendor will sign our TA" is not the same as
"we cannot have a signed TA", and that distinction was buried under the phone research.

**On OP-TEE we ARE the signing authority.** `optee_os/mk/config.mk` takes `TA_SIGN_KEY` /
`TA_PUBLIC_KEY` as build inputs, and `core/crypto/signed_hdr.c:shdr_verify_signature()` checks
every TA against `ta_pub_key`, which is **compiled into the OP-TEE core image**. Whoever builds
the secure world chooses the key that admits TAs. Demonstrated, not asserted, by
`optee/prove-signing-authority.sh` — it signs the anchor TA with OP-TEE's default key and with
ours, then cross-verifies (diagonal = positive control):

| TA signed by | vs OP-TEE default key | vs our key |
|---|---|---|
| OP-TEE default | ACCEPTED | REJECTED |
| **our key** (`0e0ea502…`) | REJECTED | **ACCEPTED** |

So the real question is not *who will sign our TA* — we sign it — but **which silicon lets us own
the boot chain that loads our OP-TEE**. On a retail phone the BootROM verifies the secure world
against a hash fused by the OEM, and that is the wall. On SoCs whose fuses are
**customer-programmable** (the embedded/industrial lines: NXP HABv4/AHAB SRK, TI HS-FS, Rockchip,
ST), the customer burns their own key hash and the entire chain — BL2/BL31, OP-TEE, TAs — is
theirs. That is a real TrustZone TA with no gatekeeper, and it is the live route.

## Two OP-TEE constraints that narrow the SoC choice (from the tree, not a datasheet)

**CORRECTION (2026-08-31): my earlier pager list was wrong, and the real answer is simpler.**
I had grepped for platforms whose `conf.mk` *mentions* `CFG_WITH_PAGER` and reported them as
supporting it. Most of them mention it in order to `$(call force,CFG_WITH_PAGER,n)`. Verified
against the tree:

- forces the pager **OFF**: `tegra amlogic nuvoton rzn1 versal2 sunxi`
- actually enables it: **`stm32mp1`, and only `stm32mp1`**

So the handoff's SRAM-anchored paging design is not merely awkward to get — it is available on
essentially nothing shippable. **Drop it.** It also would not have been wanted: the pager
hashes every 4 KiB page on fault, which is ruinous for a GEMM working set, and it exists for
parts that have no secure DRAM at all. The design takes a TZASC/RISAF DRAM carveout instead,
with keys in secure DRAM — weaker than SRAM-resident keys, still TrustZone-class, and the trade
already named above.

**A lower ceiling than TZDRAM, which bites first.** `CFG_PGT_CACHE_ENTRIES` defaults to
`CFG_NUM_THREADS * 2`, each entry maps one page table covering **2 MiB** under LPAE
(`CORE_MMU_PGDIR_SHIFT = 21`), and `pgt_check_avail()` refuses a mapping past that. On a
12-core Orin that is **24 x 2 MiB = 48 MiB of TA mappings in total, across all live TAs** — our
TA would fail there no matter how large `CFG_TZDRAM_SIZE` is. Our TA declares 24 MiB, which is
exactly why the limit has not shown up yet. The fix is `CFG_CORE_PREALLOC_EL0_TBLS=y` (which
ignores the cache, and is mutually exclusive with the pager) or a much larger
`CFG_PGT_CACHE_ENTRIES`. **Nobody has publicly demonstrated GB-scale OP-TEE TZDRAM on any
platform, so this — not the fuses — is the program's real technical risk, and it is the first
thing to prototype.**

Default carveouts remain small by convention rather than limit: `CFG_TZDRAM_SIZE` is 32 MiB on
`stm32mp2`, 63.5 MiB on `plat-tegra` `t234`. Both are `?=` overrides.

## And attestation is solved too, by the same inversion

The AVF route died on attestation: no pinnable trust anchor, and RKP factory provisioning that
only the OEM can perform. **Both objections dissolve when we are the vendor** — we do the
provisioning, so we hold the registry and the root.

OP-TEE ships this upstream. `core/pta/attestation.c` (UUID `39800861-182a-4720-…`), gated on
`CFG_ATTESTATION_PTA` (default `n`, depends on secure storage), exposes exactly four calls:

| cmd | what it returns |
|---|---|
| `0x0 GET_PUBKEY` | the device attestation public key — *"typically during device provisioning"*, i.e. ours to collect and register |
| `0x1 GET_TA_SHDR_DIGEST` | the digest from a TA binary's **signed header** |
| `0x2 HASH_TA_MEMORY` | **nonce-signed runtime measurement** of a TA's code and read-only data |
| `0x3 HASH_TEE_MEMORY` | **nonce-signed runtime measurement of the TEE OS kernel** itself |

Both measurement calls take a caller-supplied **nonce** and return `SHA-256 || signature` under the
device key, so it is a replay-resistant challenge-response — the shape a remote verifier needs.
The key is an RSA keypair (`CFG_ATTESTATION_PTA_KEY_SIZE`, default 3072) persisted in
`TEE_STORAGE_PRIVATE` secure storage, which on real hardware should be RPMB-backed
(`HUK_SUBKEY_RPMB`); OP-TEE also derives a per-TA unique key from the hardware unique key
(`HUK_SUBKEY_UNIQUE_TA`), so TA identity is hardware-bound.

That gives the anchor everything the SNP attestation gives it, with us in Google's chair:

1. **We build** the secure world, so we know the expected `HASH_TEE_MEMORY` and
   `HASH_TA_MEMORY` values — computed from our own build, not looked up in someone's registry.
2. **We sign** the TA (proven above), so `GET_TA_SHDR_DIGEST` binds to our key.
3. **We provision**, so the device attestation public key is in *our* registry — the exact step
   that is impossible on AVF, where it happens at Google's RKP factory.
4. **We verify**, against a root we published. OP-TEE also carries a
   `core/pta/veraison_attestation/` PTA for IETF RATS / Veraison if a standards-based
   verifier is preferred over a bespoke one.

Caveats to settle on real silicon, not in QEMU: secure storage must be RPMB-backed to make the
device key non-clonable (needs eMMC with RPMB, standard on the SoM-class boards under
consideration); `CFG_ATTESTATION_PTA` is off by default and must be enabled in our build; and
the measurements cover code and read-only data, not the anchor's live secret state — which is
correct, but means the argument is "our code is running unmodified", not "our data is intact".

---

# The vendor programs, for the record

Answers open question 1 of the phone-anchor handoff ("which TA signing program"), and then
the constraint that supersedes it: **the anchor has to work on a Samsung Galaxy S21+.**

Sources are public record and linked. Where the public record is silent, that is marked and
is itself a finding — it means the answer only exists under NDA. Device facts come from the
handset itself ([REPORT.md](REPORT.md) section 0), not from a datasheet.

## The decisive question, first: on-chip SRAM + pager control for a third-party TA

The route the handoff chose rests on TA code, keys and working tiles living in **secure
on-chip SRAM**, with everything else AES-GCM-paged to a TZASC DRAM carveout under
SRAM-resident freshness state. So the gating question is whether any program exposes that
to a third party.

**Publicly unanswered-to-negative on all three, with no known precedent.** Every third-party
TA whose memory layout is publicly documented — Widevine included — executes in a
**TZASC-protected DDR carveout**, not on-chip memory
([Wideshears, Black Hat Asia 2021](https://i.blackhat.com/asia-21/Thursday-Handouts/as-21-Zhao-Wideshears-Investigating-And-Breaking-Widevine-On-QTEE-wp.pdf);
[bits-please on the QSEE carveout](http://bits-please.blogspot.com/2016/04/exploring-qualcomms-secure-execution.html)).
Snapdragon on-chip IMEM is small and reserved for boot/debug/hardware blocks rather than
general TA use (mainline `sm8550.dtsi` / `sm8650.dtsi` describe it as a `syscon` of a few
hundred KB), and the older multi-MB OCMEM is a GPU/camera/video resource. The GlobalPlatform
Internal Core API has no primitive for pinning residency or driving a pager at all.

The structural reason is worth stating once: **pager-style encrypted paging out of on-chip
SRAM is a trusted-OS-core capability, not a TA capability.** OP-TEE demonstrates the exact
pattern — its pager does AES-GCM encrypted paging, and on STM32MP1 the core runs in on-chip
SYSRAM paging out to DRAM ([OP-TEE docs](https://optee.readthedocs.io/en/latest/building/devices/stm32mp1.html))
— but it does so *as the secure OS*. On QTEE, Kinibi and TEEGRIS that machinery belongs to
the vendor, and a TA is a userland process above it.

The one public lever: Trustonic **secure drivers (`drApi`) can map physical memory and handle
interrupts** ([Quarkslab](https://blog.quarkslab.com/a-deep-dive-into-samsungs-trustzone-part-3.html)).
If any program can host this design, it is Kinibi, as a **driver-level** arrangement rather
than a TA.

> **Consequence: SRAM-anchored software memory encryption is not available off the shelf from
> any of the three. It is a bespoke partnership ask everywhere.**

## The three programs

| | QTEE (Qualcomm) | Kinibi (Trustonic) | TEEGRIS (Samsung) |
|---|---|---|---|
| **Who signs a retail TA** | the **device OEM's** fused root of trust — so an OEM relationship, not merely a Qualcomm one ([Check Point](https://research.checkpoint.com/2019/the-road-to-qualcomm-trustzone-apps-fuzzing/)) | Trustonic test key for dev, **OEM key** for production ([Kinibi-600a](https://www.trustonic.com/news/kinibi-600a-commercial-release/)) | Samsung only: the trustlet's pubkey hash is compared against a hash baked into the TZOS binary ([Quarkslab pt.1](https://blog.quarkslab.com/a-deep-dive-into-samsungs-trustzone-part-1.html)) |
| **Solo-LLC entry** | Not realistic. SDK is "available to licensed users"; the 2024-25 open-sourcing (upstream QTEE Linux driver, `quic-teec`, `minkipc`) is **normal-world client code only** | Most realistic of the three. Historic ‹t-dev program, emulator, remote test servers; current third-party-via-SoC precedent in Solana Mobile on MediaTek | Effectively closed. SDK is "only available to strategic partners"; the entire public on-ramp is one email address |
| **Cost / NDA** | **public record silent** | **public record silent** (historically per-device/per-TA under NDA) | **public record silent** |
| **GP conformance** | compatibility shim, not native | GP-certified lineage; Kinibi-610a aligns crypto to **Internal Core API v1.4** | GP-**certified** (TEEgris v4/v4.1) |
| **TA threading** | not documented for third parties | **yes** — pthreads/SMP since Kinibi-610a | **yes** — multicore + PThread |
| **Heap ceiling** | not documented | no public figure; CA↔TA buffer capped at 1 MiB | not documented |
| **On-chip SRAM / pager** | **no**, and no precedent | **no** as a TA; `drApi` driver is the only lever | **no**, not documented |
| **Remote attestation** | Android Key Attestation | Android Key Attestation | **Knox Attestation** — TrustZone-signed verdict over REST, the best third-party story of the three |
| **Fleet** | ~22% of SoCs, ~35% of premium | MediaTek volume leader (~30%) but thin at premium; legacy Exynos S6–S9 | Exynos Galaxy only, and **eroding** — S25 was Snapdragon-only, S26 is region-split |

### Ranking, in the abstract

1. **Kinibi** — most realistic to engage, and the only one with a public lever toward the
   paging design (`drApi`). Production still needs an OEM key.
2. **QTEE** — best fleet and the Widevine precedent, hardest entry: needs an OEM co-sponsor.
3. **TEEGRIS** — strongest attestation, but closed to a solo LLC and on a shrinking fleet.

## Against the S21+, all of it is moot

The handset is **SM-G996U1 / SM8350 (Snapdragon 888)**, so its TEE is **QTEE** — the Exynos
2100 variant would have been TEEGRIS, and that was checked rather than assumed. Which one it
is barely matters, because on this device every route is closed by the device itself:

| route | why it is closed here |
|---|---|
| QTEE TA | signing requires **Samsung's** key. Item 1 in the ranking is Kinibi, which this SoC does not run; item 2 is QTEE, whose gate is an OEM relationship a solo LLC does not have. |
| OP-TEE / own secure world | `sys.oem_unlock_allowed=0`, `oem_unlock_supported=null` — the US "U1" handset has no unlock toggle, permanently. No custom bootloader, so no replacing the secure world. |
| pKVM / AVF protected VM | no `/dev/kvm`, all `ro.boot.hypervisor.*` empty. AVF arrived with the Android 15 chipset mandate; a 2021 Snapdragon 888 predates it. |

So the handoff's open question 1 — *which* signing program — is not the live question for this
device. **No signing program is reachable on it.** What remains is a normal-world process,
which runs and is bit-exact ([REPORT.md](REPORT.md) section 3) but carries a materially weaker
trust story that must not be described as attested.

## What would change the answer: AVF, and exactly where it stands

Researched 2026-08-31 against AOSP source. AVF (protected VMs) is the only route a solo
LLC can walk without a vendor relationship, so its details matter more than the TA table.

**No Samsung Galaxy is a candidate.** Google's Play Console device catalog listed 361
AVF-supporting models with **not one Samsung device on it**, and a published Galaxy S23 Ultra
shell dump has no `/dev/kvm`, no `ro.boot.hypervisor.*` at all, only a root-only
`/dev/gunyah`. Architecturally consistent: two independent reverse-engineering writeups put
**Samsung's RKP/H-Arx hypervisor at EL2** (the "uH" micro-hypervisor on Exynos; embedded in
Qualcomm's QHEE on Snapdragon), and only one thing can own EL2. Exynos 2500/2600 (Z Flip 7,
S26, S26+) do expose AVF, but **only non-protected VMs are confirmed** — protected-VM
capability has never been published by anyone.

**The VM itself is more reachable than the docs imply.** AOSP's "not available to third party
apps" means "not in the public SDK and not grantable without adb", not "impossible":

- `MANAGE_VIRTUAL_MACHINE` is `signature|preinstalled|development`. The **`development`** flag
  makes it grantable by `adb shell pm grant` on a **stock, locked, production** build — the
  same mechanism `WRITE_SECURE_SETTINGS` uses. No root, no unlock, no Shizuku.
- **Our exact workload needs only that one permission.** `setProtectedVm`, `setMemoryBytes`
  and `setCpuTopology` are all top-level config; `USE_CUSTOM_VIRTUAL_MACHINE` is only needed
  for a non-Microdroid VM, a custom kernel, or extra APKs.
- **But one grant is not the whole setup**, and the first pass understated this. The AVF classes
  are `@SystemApi`/`@hide`, so they are absent from the public SDK: a third-party APK must ALSO
  either install `HiddenApiBypass` at `onCreate` (Android 14+) or have the blocklist exempted by
  a second adb command --
  `adb shell settings put global hidden_api_blacklist_exemptions 'Landroid/system/virtualmachine/VirtualMachine'`
  -- and reach the API by reflection. That is the recipe koiTerminal documents and the approach
  Podroid uses (`AvfReflect`, "so the APK compiles against the public SDK").
- **The reflection path is fragile, and this is a real engineering risk.** koiTerminal issue #4
  reports `NoSuchMethodError: No virtual method getUserId()I` on a Samsung Tab S10 FE+ (Android
  16) *and* on a Pixel 9 Pro XL, where only Google's own preinstalled Terminal worked. Binding to
  hidden platform internals means every Android release can break the anchor.
- Note also a tension in Google's own wording worth resolving before relying on any of it: the
  AVF **security** page says *"only the apps that are signed with the platform key can request
  permission to create, own, or interact with pVMs"*, which reads more strictly than the
  framework README's "can also be granted via `adb shell pm grant` for development purposes".
  The field reports side with the README, but the stricter sentence is the one Google would cite.
- **Field-confirmed on non-Pixel hardware:** Podroid issue #43 shows both permissions
  `granted = true` on a stock Lenovo Tab M11 running Android 15. Its device table (#62), however,
  reports `AVF = yes` **only** on Pixel; Samsung Galaxy A24, Nothing Phone (1), Honor and Huawei
  devices all fall back to QEMU TCG software emulation.
- The **pvmfw wall cuts in our favour**: protected VMs require a pvmfw-signed payload, so a
  custom kernel can only run NON-protected (this is what blocks Podroid, the shipping
  third-party AVF app). A native `.so` inside **stock Microdroid** is exactly the protectable
  case.
- CTS proves it works on retail: `MicrodroidTestApp` is a **non-platform-signed** CTS module
  that grants both permissions via shell identity and runs parameterised over
  `protectedVm={false,true}` — and CTS must pass on final shipping software.

  **Measured 2026-09-02, and it contradicts the strict reading:** on a locked retail Pixel 8 Pro,
  an APK signed with a throwaway key and granted `MANAGE_VIRTUAL_MACHINE` by `pm grant` (the
  permission carries the `development` protection flag) created, owned and read a
  **protected, non-debuggable** VM through the `@SystemApi` classes (REPORT.md §9). "Platform
  key" is the retail-distribution gate, not the technical one: the grant is what matters, and
  it is adb-reachable on any unit, which makes this a prototype and OEM-pitch vehicle exactly
  as stated above.

**Field confirmation of both halves.** Kalidroid (`com.excp.kalidroid`, kimocoder) is a shipping
third-party APK whose own install instructions are
`adb shell pm grant com.excp.kalidroid android.permission.MANAGE_VIRTUAL_MACHINE` — no root, no
unlock. Its binary really does carry `libcrosvm.so`/`libvirtmgr.so` and drive
`android.system.virtualmachine` by reflection, so the grant path is real in the wild, not just
in AOSP source. It also confirms the pvmfw wall from the other side, in its own strings:
*"Kalidroid's custom Linux kernel can run only as a non-protected VM. This is expected, not a
failure"*. AOSP's `virtmgr` states the rule verbatim — app-supplied images are refused in a pVM
*"to prevent random images which are not protected by the Android Verified Boot ... from being
loaded in a pVM"*. **That is exactly why our shape works and theirs does not**: we ship a native
payload inside the AVB-signed stock Microdroid and are measured as a `vmComponents` subcomponent,
rather than supplying our own kernel image.

(Do not install it to test this. It is debug-signed with the public Android debug certificate,
ships `android:debuggable="true"` while holding `MANAGE_EXTERNAL_STORAGE`/location/mic, claims
GPL over a 404 repo, and its current installer fetches the payload from an expired free-DDNS
hostname anyone could re-register. Cited as evidence of the mechanism, not as software to run.)

**Attestation is the actual blocker, and it is unresolved.** A pVM we cannot *prove* is a pVM
is worth little more than a normal Android process, and:

- Production `requestAttestation` needs no partner allowlist — same permission — but it fails
  `ATTESTATION_ERROR_UNSUPPORTED` unless the OEM registered the device's UDS-rooted DICE key
  at the **RKP factory** and threaded RKP VM markers through the vendor boot chain. That
  cannot be added later.
- CTS **requires** it only where `ro.vendor.api_level >= 202504` (launched with Android 16).
  Pixel 8/9 and every upgraded device sit in the silent-skip branch.
- **No pinnable public trust anchor is documented.** AOSP's reference verifier trusts whatever
  self-signed root the chain carries — a consistency check, not attestation. **If Google
  publishes no pinnable AVF RKP root, this route has no verifiable remote attestation**, and
  that single question decides build-vs-buy.
- `enableTestAttestation()` is a dead end: `@TestApi`, and it returns a hardcoded certificate
  that **expired 2024-02-14**.
- `isVmSecure` is false for any debuggable VM, so production must ship `DEBUG_LEVEL_NONE`.
- The CDD mandates only that `getCapabilities()` return *one of* protected/non-protected —
  **protected support is not required**, so it is a per-SoC gamble to be probed, never assumed.

**Compute envelope inside a pVM:** CPU only (no GPU/NPU — so the on-device-GPU-worker topology
is out), full NEON incl. dotprod, several GB of RAM fine, but the default is **one vCPU** so
`CPU_TOPOLOGY_MATCH_HOST` must be set explicitly. I/O over vsock. Changing the payload rotates
the VM's DICE secrets, so every app update changes its attested identity.

### The attestation gap, pinned down (2026-08-31, against AOSP source)

This was the open question that decides build-vs-buy. The answer is **"not established", and it
is empirically testable in an afternoon.**

Google **does** publish pinnable roots at `https://android.googleapis.com/attestation/root`
(verified live: 2 certificates, `CE:DB:1C:B6:...:0D:FC` valid to 2042, and
`CN=Key Attestation CA1, O=Google LLC` `6D:9D:B4:CE:...:BC:C0` valid to 2035). But they are
documented for **Key Attestation** only, and the name of the second says so. **No public source
states that a `"rkp-vm"` chain from the `/avf` IRPC instance chains to them**, and Google's own
official verifier (`github.com/android/keyattestation`) contains **zero** references to the pVM
OID `1.3.6.1.4.1.11129.2.1.29.1`, to `isVmSecure`, or to `vmComponents`.

What a relying party CAN and CANNOT do:

| | |
|---|---|
| verify the chain is internally consistent, parse `vmComponents` | **yes** — trivially, but alone it is forgeable by anyone with a self-signed root |
| verify the DICE chain structurally | **yes** — `hwtrust dice-chain --rkp-instance avf` (Apache-2.0, source-only, not on crates.io) |
| verify **the device is genuine** | **no** — `hwtrust` anchors on the UDS_Pub *inside the chain*. The genuineness evidence lives only in Google's private UDS_pub enrolment registry. |
| know the expected Microdroid image hash | **no public source** — AVB digests are baked into the RKP VM binary by `extract_microdroid_kernel_hashes.py`; the design has the RKP VM check it on-device and expects the verifier to trust that transitively |
| verify **our own payload's identity** | **yes, independently** — `codeHash` = APK Signature Scheme v4 Merkle root (SHA-256, empty salt), `authorityHash` = SHA-512 of the DER signing cert. Both recomputable from the APK we shipped. |

**The trap to avoid:** AOSP's `X509Utils.validateAndParseX509CertChain` — used by *both* the
test-mode and the real-RKP end-to-end tests — anchors on the chain's **own self-signed root**
and disables revocation. Copying it into a production verifier accepts fully attacker-forged
chains. There is no public server-side verifier for the pVM OID; we would write it ourselves.

**Test mode is definitively worthless for production**, and worth stating so nobody is tempted:
`enableTestAttestation()` yields a locally generated key plus a hardcoded leaf from
`CN=Droid Unregistered Device CA, O=Google Test LLC` that **expired 2024-02-14**. It is not
RKP-rooted; the AOSP header says so outright.

> **THE DECISIVE EXPERIMENT.** On a real Pixel, obtain a genuine (non-test) RKP-backed pVM
> attestation and check whether its chain terminates at one of the two fingerprints above. If it
> does, the gap closes empirically and this route is viable. If it does not, **there is no
> verifiable remote attestation** and the anchor is no stronger than a normal-world process --
> at which point buy an SNP node instead of building this. Note a device that was never enrolled
> answers HTTP 444 -> permanent `DEVICE_NOT_REGISTERED`, and rkpd needs network + GMS.

**MEASURED 2026-09-02 on a Pixel 8 Pro — the VM half is real, the attestation gate is exact.**
The anchor runs inside a protected VM on a stock, locked Pixel 8 Pro, launched from `adb shell`
with the stock `vm` tool; all invariants pass on all shapes (REPORT.md section 8). The
attestation call fails with *"AVF remotely provisioned component service is not declared"*,
and the mechanism is now known rather than inferred: the APEX declares
`IRemotelyProvisionedComponent/avf` with `min-level="202404"`, and libvintf drops it because
the device's vendor manifest `target-level` is 8 (its Android 14 launch generation, fixed for
the life of the device). `vintf` shows `/default`, `/strongbox`, `/widevine` and no `/avf`.
So "attestation only on devices launched with Android 15+" is a VINTF filter, not policy,
and it is testable in ten seconds with `probe-device.sh`. Consequence for purchasing: **Pixel
9 family (launched Android 15, vendor 202404) admits the component; Pixel 10 family (202504)
is CTS-required to attest.** The Pixel 8 Pro is the right unit for everything *except* the
attestation chain, which it can never produce.

**Buy, if this route is taken:** a Pixel, not a Samsung. **Pixel 10-class or newer** if
attestation must be guaranteed (vendor API >= 202504); a used **Pixel 8a (~$205-250)** is
enough to prototype the VM mechanics, with attestation to be probed rather than assumed.
Run `probe-device.sh` on the unit before committing to a fleet.

## The concrete next step, if a TrustZone route is still wanted

Ask Trustonic, in one message, the two questions the public record cannot answer: whether a
**secure driver** can access on-chip memory and implement pager-style encrypted paging, and
what the **TA working-set/heap budget** is in writing. That is the most answerable channel and
it is the only lever with public evidence behind it. In parallel, build the AVF prototype on a
device that has it — it is the artifact any OEM conversation will want to see, and it is
buildable today without anyone's permission.
