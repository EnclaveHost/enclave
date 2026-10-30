# Full-model SNP A/B: loader drop-cache marker (prep, source only)

Date: 2026-10-27. **Source only. Nothing was built, tested, booted or measured.** Read/Grep/Glob/Write only.
No credentials, guestd/session configs, tenant logs or live state were read. Production
(`REL=/home/steven/enclave-prod/release-5cab66e4`) was only read for `release.json` and file names.
The old run-canary scripts and `lab.py` (which drove a temporary guestd with the production pair key)
were **not** reused. Labels: **[src]** read in source, **[user]** stated by the user, **[est]** my inference.

Paths: `PGI=/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init`,
`H=` this staging dir.

## 0. Status

> **Revision 2 (2026-10-28): read `REVISION.md` first.** It supersedes the following parts of this file: ownership
> and cleanup (§4/§7), the watchdog (§5), the GPU policy (P1, now a reviewed shared-card option), the RAM formula (§5,
> now a reviewed guestd-snapshot option next to strict), the worker `--host 127.0.0.1` (P4), and the trust paths (P5).
> The strict defaults below are unchanged.

The harness is **not ready to execute**. The source parts are written (§7). Execution is blocked on
six concrete prerequisites that I can't derive from public source (§6). The most important are:
- two coordinated idle GPUs (the measured init hard-wires two workers),
- the host RAM fit, which is marginal at the current 83 GiB available.

## 1. What the A/B compares

| Arm | Image | Differs from A by |
|---|---|---|
| **A** | `REL/template` copied byte-for-byte (every file sha-checked against `release.json`) + the public bench bundle | — |
| **B** | A with `template/shieldmodel` replaced by the `loader-candidate` build, plus `template/rt/shield-model-drop-cache.enabled` = `1\n` | loader binary + marker only |
| A1 (optional, recommended once) | A with the candidate `shieldmodel` and **no** marker | loader binary only (shows the candidate's default path ≡ production) |

Everything else is identical in every arm and identical to the installed release:
- init `dffd093b…`, backend `74e834bf…`, `libenclave_llama` `5fce1b9e…`, wasmtime, all five markers (compact, reclaim, spill, native CPU pool, RAM admission), kernel, firmware, cmdline.
- The measured env from `PGI/isolation/m2/dominit.c:549-665` [src] is produced by the unchanged init. So these all hold automatically, with no harness knob: ctx 65536, sessions 16, park 6, prefix 8, `N_RS_SEQ=1`, batch/ubatch 64, FA off, MTP, compact unit 64, pool 128, refill 16×64, reclaim fds 198/199, spill fd 197 with governor headroom 1 / batch 16.
- Spill governor note: dominit picks headroom 1 / batch 16 only when the app config has no `shieldPadBusyMint`. The bench guest gets **no config** (§3), so `busy == -1` and the governor setting matches production's default [src `dominit.c:643-647`].
- packed24 is **not** in any arm.

**Telemetry is host-side only and identical in both arms.** At 1 Hz: the QEMU unit's cgroup `memory.current/peak/stat`, the two worker units' `memory.current`, and host `MemAvailable`. The guest serial carries init's own `DOM …` lines and shieldmodel's `MODEL verified … copy_verify_ms=…` line (shieldmodel is spawned non-quiet, `dominit.c:780`). No guest telemetry is added, because that would mean changing init in both arms. Consequence: guest-internal peaks (the 32.755 / 16.403 GiB loader-only figures) are **not** reproduced here. Host cgroup peak is the RAM metric this A/B produces.

## 2. Why every production path that needs a lease, ticket or tenant is avoidable [src]

- **No guestd, no lease, no ticket.** `run-domain.sh` is just QEMU under `systemd-run`. The bench helper builds the same QEMU shape itself (§4) and never talks to guestd.
- **No deployment config.** With all-zero SEV-SNP `HOST_DATA` (we pass none), the front reads a good report, decides "lab / no-deployment guest", and hands init `"N"` (`PGI/isolation/m2/front/release_decision_test.go:57-58`, `provision.go:322`). The app starts with no `ENCLAVE_CONFIG`, no secrets and no egress credential.
- **App = public probe.** `PGI/isolation/m4/evidence/shield-target25-2026-09-27/probe` is a wasi:http component that `load_by_name`s the preloaded model and greedy-decodes a fixed public 17-token prompt (≤384 steps, MTP optional). `full-bench-prep/probe-bench/src/lib.rs` (§7) extends it with deterministic synthetic prompts so longer and concurrent workloads can run. The prompts are still public: token ids come from a public seed, and there is no text and no user input.
- **Client = `PGI/isolation/m2/client.mjs` in trusted mode** through `PGI/isolation/m2/fwd` (vsock → 127.0.0.1). The client fetches the attestation document with a fresh nonce, judges it, pins the TLS key, then sends `GET --path`. A closed gate means no application request is sent [src `client.mjs:2-48`]. No wallet, signing, session or tenant worker is involved.
- **GPU = bench-owned workers on bench-owned rings.** Production workers and their ring dir (guestd `--shield-shm-dir`) are never opened. A Qwen guest is QUEUED [user], and the target25 README warns never to recreate or truncate worker rings.

## 3. Attestation and security (unchanged gates; nothing bypassed)

- **Launch:** `sev-snp-guest … kernel-hashes=on`, measured initrd = the assembled arm image. The measurement is predicted per arm exactly as `PGI/isolation/m4/build-app-guest.sh:54-56` does: `sev-snp-measure --mode snp --vcpus 16 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf <REL firmware> --kernel <REL kernel> --initrd <arm image> --append "console=ttyS0 rdinit=/init loglevel=3"`.
- **Verification:** `client.mjs` default trusted mode with `--measurement <arm prediction> --app-sha <bundle id> --runtime REL/template/rt/runtime.json --vcek <der> --amd-chain <Product>=<pem> --min-tcb <json> --no-kds`. Only a `VERDICT` of attested, with exit 0, is accepted. The helper refuses `--lab-unsigned` and `--t0-diagnostic` outright.
  - The VCEK, AMD chain, product and min-TCB are the files guestd's `--vcek/--chain/--product/--min-tcb` flags already point at [src `guestd/main.go:38`]. They are public certificates, but I didn't read guestd's live args, so root supplies the paths (§6).
  - **Until a receipt shows an attested verdict for both arms, the bench is "configured SNP", not attested.** Even then, the measurement is a bench measurement (a different app bundle), not production readiness.
- **Unchanged:** shieldmodel's pinned whole-file digest, copy-before-verify, per-tensor table, fd 198/199 capabilities, uid drop, seccomp, W^X, cgroup OOM decline, pad one-use, the integrity checks (`SHIELDED_OVERLAP_VERIFY=1`) and spill sealing. These all live in unchanged measured binaries. B changes only the cache advice on `/dev/vda` (LOADER.md).
- **No host mmap of the model.** QEMU opens it `readonly=on,cache=none` (O_DIRECT). The host only `stat`s it, never reads or hashes it.
- **No plaintext model or protected inputs leave the guest.** The serial carries only `DOM`/`MODEL` lines. Probe responses carry token ids and timings for public synthetic prompts.
- **No public endpoint.** `fwd` listens on 127.0.0.1 [src regex `FWD listening 127\.0\.0\.1`]. The workers run with `PrivateNetwork=yes`, so whatever port they bind exists only in a private netns (see §6 P4).
- **vsock CID:** chosen from 200000–209999, disjoint from guestd's band 131072–196607 and run-domain's random band 65536–131071 [src `run-domain.sh:59-70`]. A CID already in use makes QEMU fail to start (fail closed).

## 4. VM, worker and storage shape (mirrors `run-domain.sh` snp + Shield 27B; one deliberate deviation)

```
qemu-system-x86_64 -machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1
  -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on
  -object memory-backend-memfd,id=ram1,size=<G>M,share=true
  -cpu host -smp 16 -m <G>M -bios <REL>/firmware.fd -kernel <REL>/kernel -initrd <arm image>
  -append "console=ttyS0 rdinit=/init loglevel=3" -device vhost-vsock-pci,guest-cid=<CID>
  -object memory-backend-file,id=sh0,mem-path=<bench rings>/card-0,size=64M,share=on -device ivshmem-plain,memdev=sh0,addr=5
  -object memory-backend-file,id=sh1,mem-path=<bench rings>/card-1,size=64M,share=on -device ivshmem-plain,memdev=sh1,addr=6
  -drive file=<public model>,format=raw,if=virtio,readonly=on,cache=none
  -drive file=<bench bank>,format=raw,if=none,id=padbank,cache=none
  -device virtio-blk-pci,drive=padbank,addr=0x10,logical_block_size=4096,physical_block_size=4096
  -nodefaults -monitor none -display none -serial file:<run>/serial-<arm>.log -no-reboot
```
Unit: `systemd-run --user --unit fullbench-<run>-<arm>.service --service-type=exec -p MemoryMax=<G+768>M -p MemorySwapMax=0 -p CPUQuota=1600% -p TasksMax=256 -p AllowedCPUs=<coordinated set> -p RuntimeMaxSec=<cap> -p KillMode=control-group`.

**Deviation (both arms):** production starts QEMU with `-S -qmp` and pins vCPUs via `pin-shield-cpus.py` [src `run-domain.sh:109-134`]. QMP is forbidden here, so the whole unit is confined with `AllowedCPUs=` to a coordinator-assigned set that shares one L3. The vCPU threads float inside that set.
- A/B stays fair, because both arms are treated the same.
- **Absolute tok/s is not comparable to production.**
- Repeat arms ABBA to bound the noise this adds.

Workers: two `fullbench-<run>-w{0,1}.service` user units, each running `CUDA_VISIBLE_DEVICES=<gpu uuid> <worker> --port <p> --vram-gb <n> --shm <bench rings>/card-<i>` (the command line shape from `PGI/shielded/bench-harness/workers-shm2.sh:12-14` [src]) with `MemoryMax`, `PrivateNetwork=yes`, `RuntimeMaxSec`. Workers start before the guest (the broker waits for both, `dominit.c:787-792`), and stop after the guest is gone.

Rings: new `/dev/shm/fullbench-<run>/card-{0,1}`, 0600, exactly 67108864 B (`run-domain.sh:80`). Created by the helper (refused if they exist), removed at the end.

Pad bank: new sparse `<bank dir>/fullbench-<run>-<arm>.padbank` (`truncate`, 4 KiB blocks), deleted after its arm's QEMU is gone. Size is a plan parameter, default 64 GiB, against production's 512 GiB [user]. Preflight requires `statvfs` free ≥ size + 32 GiB, because idle minting can fill it. Contents are sealed under guest-only keys, so they are noise to the host. A smaller bank may fill during a long soak; both arms are equal, and the receipt records the pad counters from `x-enclave-performance` if they're available.

## 5. RAM and resource plan

Fixed facts: production Qwen request is 64281 MiB + 768 MiB unit overhead [user, CURRENT-BASELINE-CORRECTIONS]; installed floor 51200 MiB [user] (source contract; the LIVE guestd advertises Qwen `modelFloorsMiB` 73728, and the 64281 request comes from the CPU-share clamp, so neither number proves the other; see REVISION.md §3); guestd host floor 18432 MiB and host reserve 16 GiB stay untouched [user]; resident custodian 3 + control 4 + image 6 = 13 GiB [user]; MemAvailable ≈ 83 GiB now [user].

**Guest size G = 51200 MiB (the installed floor, not lowered). This is the only size that fits now.**

Per-boot preflight, all required:
```
MemAvailable >= 13 GiB fixed reserve            (resident custodian/control/image, counted again on purpose)
              + G + 768 MiB                       (QEMU unit MemoryMax)
              + 2 x worker MemoryMax              (bench workers' host RAM)
              + pending_extra                     (anything not covered by the 13 GiB, e.g. a pending image job; explicit, >= 0)
              + 18 GiB canary floor
```
At G = 51200 the static part is 13 + 50.75 + 18 = **81.75 GiB**. Against 83 GiB that leaves **1.25 GiB** for 2 × worker MemoryMax + pending_extra.
- **[est] A CUDA worker's host RSS is very likely above 0.6 GiB, so this probably does not fit today.** The helper computes this and refuses rather than shaving the floor.
- If root's pending-image reservation (≥1551 MiB in the loader harness formula) is not inside the 13 GiB, it doesn't fit either.

Watchdog (1 Hz), which stops only the owned units:
- `MemAvailable < 18 GiB + pending_extra`.
- Any change in the `qemu-system` inventory (reusing `bench-harness/resource_guard.py`). The QUEUED production Qwen guest starting is exactly such a change, and the bench **yields to production immediately**. It cannot coexist with that guest: 63.5 + 50.75 + 13 + 18 > 83.
- Root must either hold the queue during the slot or accept that a production start aborts the run.

**Expected outcome at G = 51200 [est, unmeasured]:**
- Guest budget = available − 5% (`shield-memory.h`). Scaling from production's observed 58086 MiB budget at 64281 MiB, G = 51200 gives about **45,600 MiB**.
- The CURRENT-AUDIT load-peak estimate (≈47 GiB non-reclaimable in the cgroup + X) is above that. **Arm A may OOM-decline the model** ("DOM Shield model declined"). That is a valid, recorded outcome (`model_declined`), not a crash.
- B's marker only advises away **reclaimable** page cache, so it probably does not change the cgroup OOM outcome. Its expected effect is on host-touched pages, which the host `memory.peak` measures.
- If A declines at 51200, a throughput A/B needs a size where A serves. The production size, 64281 MiB, needs MemAvailable ≥ 13 + 63.53 + 2W + 18 ≈ **95 GiB + 2W**. That is not available while the production Qwen guest is queued for the same RAM. This is a scheduling decision for root.

CPU: 16 vCPUs at 1600% plus two workers. `AllowedCPUs` comes from the KVM coordinator and must not overlap the image generator's or the control VM's CPUs.

Wall time per arm [est]: boot + copy ≈ 1–2 min, registration/encode several minutes (unmeasured for this release), workload ≈ 15–25 min, optional soak 60 min. Default `RuntimeMaxSec` = 3600 without soak, 7800 with soak.

## 6. Missing prerequisites (concrete; each one blocks `execute`)

| # | Missing | Why I can't derive it | What root supplies / checks |
|---|---|---|---|
| P1 | **Two coordinated idle GPUs** (UUIDs) with ≥ `vram_gb + 1` GiB free and no compute processes | Measured init requires both worker routes and both ivshmem BARs [src `dominit.c:340-346,387-404`]. Public source shows two V100 UUIDs for bench workers [src `workers-shm2.sh`], but not the current production worker/image-generator mapping. If production workers hold both V100s with `--vram-gb 30`, there's no room for a bench worker, and freeing them would touch existing GPU workers, which is **not allowed** | `--gpu-uuid` ×2. The helper runs a read-only `nvidia-smi --query-compute-apps` / `--query-gpu` at preflight and refuses if any process is present or free memory is too low. Sharing one GPU between both bench workers is **not** supported: 2 × 15.5 GiB reservation + contexts ≈ a full 32 GiB card, and it would also change GPU timing |
| P2 | Production **worker binary** path + sha256 and its `--vram-gb` | Lives in supervisor/worker-manager config, not read | `--worker`, `--worker-sha256`, `--vram-gb` |
| P3 | **Worker host RSS** | Not in public evidence | Root reads `VmRSS` of a running production worker (read-only `/proc`) and sets `--worker-memory-max-mib` ≥ 1.25×RSS. This decides whether §5 fits |
| P4 | Worker **listen address** | Unknown. It may bind 0.0.0.0 | `PrivateNetwork=yes` makes this moot if CUDA works under user-unit `PrivateNetwork` (which implies `PrivateUsers` in user units). Verify once with a 0-model worker smoke; if it doesn't work, stop. Don't drop the isolation |
| P5 | **Attestation trust files**: VCEK DER (or AMD chain PEM + product), min-TCB JSON | They're guestd's live args, not read | `--vcek`, `--amd-chain`, `--min-tcb` paths (public certs) |
| P6 | **Bench bundle** (`probe-bench`) built and wrapped as a contract bundle with `Inference{Model: qwen3.8-27b-mtp-q4-vl-gguf, GPUMilli: 500}`, `Policy{Vcpus: 16, CPUPercent: 1600, MemMiB: 51200}`, `serve` mode | Needs `cargo component` and the contract bundle tool. The manifest shape is from `guestd/inference_test.go:120` [src]. 500 milli × 31 GiB = 16642998272 B per card, which matches the release's worker reservation [src `check-shielded-worker-config.py:18`] | Build per §8. Its `app_id` goes into the plan |

Also open and non-blocking:
- **Source provenance.** The installed `init` (`dffd093b…`) is consistent with PGI `dominit.c` (every marker it tests exists in the release), but it hasn't been reproduced. `shieldmodel`/the shim/the backend → padgov 4c716378a is user-stated and unverified (CURRENT-AUDIT §1). The installed floor of 51200 conflicts with PGI `contract/inference.go:19` (73728).
  - None of this matters for the A/B, because both arms reuse the installed binaries **as files**. A has no rebuild.
  - Only B's `shieldmodel` is rebuilt, from `loader-candidate/`. Its legacy path is the production source's `copyVerified` (LOADER.md), but the production shieldmodel was never reproduced from padgov. **A1** isolates that question.
- Prefix-slot engagement. Whether the wasi-nn backend reuses a parked shared prefix across separate probe requests (automatic token-prefix match vs an app API) isn't visible in what I read. The workload records `prefill_ms` per request, so reuse shows up as lower TTFT. It isn't assumed.

## 7. Files written (all under `full-bench-prep/`)

| File | Role |
|---|---|
| `FULL.md` | this document |
| `fullbench.py` | Host helper: `stage` (verified template copies A/B/A1 + manifest), `plan` (no command run; writes plan.json 0444 and prints its sha256), `execute` (dry run by default; `--execute --coordinated-slot` boots the arms serially). It owns only its units, rings and banks. Reuses `bench-harness/resource_guard.py` and `benchlib.storage_check` |
| `workload.json` | The fixed public workload (§9), consumed by `fullbench.py` |
| `REVISION.md` | Revision 2: ownership/cleanup, watchdog, shared-GPU and snapshot-RAM options, reservations schema |
| `guestd_commitments_probe.mjs` | Revision 2: read-only guestd `/health` + `/vms` probe through the pinned `control-client.mjs`; prints sanitized numbers only |
| `test_fullbench.py` | Offline fixtures: RAM formula and refusal, argv invariants (no QMP, no `-S`, exact devices, CID band), unit limits, workload validation, template staging against a fake release, receipt classification, cleanup touching only owned names. Fake host; nothing runs |
| `probe-bench/src/lib.rs` | Probe extended with `?seed=&prompt=&shared=&shared_seed=` deterministic synthetic prompts (public ids), chunked prefill, TTFT/prefill/decode timings, and an FNV-1a hash of the output tokens. The original fixture route and the 17-token prompt are unchanged |
| `probe-bench/README.md` | How to build it with the evidence probe's `Cargo.toml` and `wit/`, which aren't copied (vendored WIT stays where it is) |

## 8. How root can validate (in order; nothing here was run)

1. Read `fullbench.py` (`qemu_argv`, `qemu_violations`, `worker_argv`, `required_available`, `preflight`, `watch`, `cleanup`) and `probe-bench/src/lib.rs`.
2. Offline tests (shared small queue): `cd $H/full-bench-prep && timeout 300 python3 -m unittest -v test_fullbench`. Re-run `bench-harness` tests too, because `resource_guard` is reused.
3. Build the candidate loader exactly as in `bench-harness/BENCH.md` step 3, then the probe as in `probe-bench/README.md`, then wrap the bundle (P6).
4. `python3 fullbench.py stage --release REL --candidate-loader <shieldmodel> --candidate-source $H/loader-candidate --out <S>/templates`. Then for each arm: `SHIELDED_IMAGE_TEMPLATE=<S>/templates/<arm> sh PGI/isolation/m4/build-app-guest.sh <bundle> <S>/img-<arm>.cpio.gz 16`, and record its `predicted measurement` (these two are the existing scripts, unchanged). The stage manifest pins every template file. A and B must differ only in `shieldmodel` and the marker; `stage` asserts this.
5. `fullbench.py plan …` with P1–P6 values. Inspect `plan.json` (`required_available_bytes`, argv, units, CID, rings, banks, predictions) and note its sha256.
6. `fullbench.py execute --plan … --approve-plan-sha256 <sha>` is a dry run: it prints preflight and argv.
7. Only inside a coordinated slot (16 CPUs, `required_available_bytes` of RAM, two GPUs, the production Qwen queue held or accepted as an abort): `… --execute --coordinated-slot <id>`. Default order is `--order A,B,B,A`. Add A1 with, e.g., `--order A,A1,B`, plus `--image A1=… --measurement A1=…`.
8. Read `receipt.json`. Per arm it records: attestation verdict, `model_served` / `model_declined`, `copy_verify_ms`, host unit `memory.peak` (last sample) and max `memory.current`, and per request the token hash, TTFT, `prefill_ms`, `decode_ms` and tok/s.

## 9. Workload and pass criteria

Fixed in `workload.json`, identical across arms, with public synthetic ids only:
1. `fixture`: the historical 17-token prompt, 128 steps, MTP k=1. Its tokens must equal across arms (and should equal earlier records of the same release if root has them).
2. `ttft`: one session, 8,500-token prompt, 64 steps, MTP. TTFT = `prefill_ms` + first-token time.
3. `fill`: 7 concurrent sessions × (6,200 shared-seed prefix + 2,300 unique) + 128 steps, MTP ≈ 60.4K of 64K tokens (≈92% pooled occupancy if the prefix isn't shared; the guest's own accounting isn't observable without telemetry).
4. `sessions16`: 16 concurrent sessions × (6,200 shared + 256 unique) + 64 steps.
5. Rounds 2–4 repeated 3× (round 1 = warm-up, reported separately). `soak` is optional.

Report decode tok/s per request and aggregate, TTFT, load time (guest boot → first probe success), host unit peak and max current, and copy_verify_ms. Keep startup and steady state separate.

**Provisional target: ≤5% throughput loss [root provisional target, not a user-specified limit]. It is a target, not a guarantee.** A/B pass needs all of:
- both arms attested;
- the same `model_served` / `model_declined` outcome;
- identical token hashes on `fixture` and `ttft` (sequential);
- concurrent-round token mismatches reported, not auto-failed: batched CPU paths may legitimately reorder;
- B's aggregate decode tok/s ≥ 0.95 × A's, with the ABBA spread reported. If the spread is ≥ the difference, report "inconclusive".

**No admission or floor change** without separate pressure tests at representative context and concurrency on the actual production size. This bench doesn't do that. The candidate stays opt-in.

## 10. Limitations

1. Nothing was run. Python and Rust compile or test failures are possible.
2. Host-side RAM only. The guest's internal phase peaks need an init change and are out of scope.
3. vCPU placement differs from production (no QMP), so absolute numbers are not production numbers.
4. At G = 51200, arm A may decline the model, in which case no throughput comparison is possible at the size that fits now.
5. The P1/P3 resource fit is likely to fail today. The helper refuses rather than lowering any floor.
6. `client.mjs` runs one request per process. Concurrency comes from parallel client processes, each attesting independently, so its own startup is included in wall time but not in the guest-reported decode/prefill timings that the comparison uses.
7. The bench measurement is not a production measurement. Any release using B must be independently predicted and admitted.
