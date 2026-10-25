# Native desktop resource boundary

The resource primitives now feed a dedicated native M3 monitor/domexec/front
build. Production admission remains disabled and normal `contract.Parse`
still refuses desktop bundles. Final host storage/image selection, capacity
reservation, owner-secret release and measured release binding remain required.

`ReadInstalled` reads one canonical, bounded, root-owned profile from a
read-only platform mount. `CheckBundle` binds its exact canonical SHA-256 and
controller artifact to the desktop manifest. `OpenMounted` retains descriptors
for the actual read-only SquashFS and ext4 roots, checks their active kernel
dm-verity tables, and verifies mount IDs and filesystem-root identities. This
establishes integrity against the trusted profile's root hashes, salt and
geometry; it does not hash the image files or independently authenticate the
profile, kernel, final platform image or RuntimeID. The trusted platform must
prevent privileged table replacement and keep the descriptors through bind/clone.

`AcquireClaim` atomically consumes the guest's root-only tmpfs claim. It remains
consumed after errors, teardown and monitor restart. `NewGroup` is single-use
per claim and creates one fresh cgroup. It configures and reads back CPU quota,
8..64 GiB memory, no swap, group OOM and 1024 tasks through the same directory
fd used for CLONE_INTO_CGROUP and cleanup. `CheckCapacity` requires sufficient
actual guest CPUs and memory plus a 512 MiB platform reserve. Manifest values
must feed these helpers directly; request overrides cannot bypass their bounds.

The caller must serialize launch against teardown, reserve native UIDs
1000..1003 guest-wide, refuse all ordinary workloads on this dedicated guest,
and keep cgroupfs inaccessible to untrusted roles. Begin teardown by revoking
new worker/secret admission, kill the entire cgroup, reap children, then remove
the empty cgroup before freeing its reservation. Any failed cleanup poisons the
guest; do not fall back to killing only the supervisor, reuse the claim, or
release resources while descendants may survive. `Group.Close` closes handles;
it does not kill tasks or release resources. `Resources.Close` closes pins.

## Qualification on the selected kernel

Two fresh KVM guests use Linux 6.6.87.2-enclave-kvm-box, 8 vCPUs and 12 GiB RAM,
with no NIC, physical GPU, host input or writable disks. Both mount and fully
read the selected immutable desktop and model volume through dm-verity.
Both validate installed profile/mounts, refuse changed root hashes, ordinary
subdirectories and a bind-mounted /usr, and allow exactly one winner among
32 concurrent claim attempts. Both reject a second use of the same claim
before and after group removal, and reopening the claim after teardown.

The limits guest proves CPU throttling at 400%, task exhaustion at pids.max,
and removal refusal while escaped descendants remain. cgroup.kill then removes
all descendants. The OOM guest proves memory.max=8589934592, swap.max=0 and
memory.oom.group=1: the kernel records oom_group_kill=1 and kills both the
9 GiB allocating process and its idle sibling. The CPU stress process is
stopped by its own process handle before that allocation. CPU stress during
allocation previously exhausted the 45-second fixture deadline; this failure
is retained, not counted as a successful OOM test.

The pinned kernel's cgroup.kill sequence makes cloning into that killed group
unsuitable for a later independent test. `Group.FD` becomes unavailable as soon
as Kill begins; production must never reuse such a group. The two scenarios
therefore use fresh guests. Disk ordering can vary: the updated harness locates
its three read-only disks by unique expected geometry, then uses trusted hashes
for authentication. Geometry alone is not an identity check.

Go race tests and vet pass, including malformed profiles, unsafe dm tables,
model/root backing layouts and the bind-subdirectory mountinfo case. The final
fixture initrd SHA-256 is
a7102d682a845586767807063ad01d736a13b3e19c7f1a2b34aa5b93fa7f197b.
The installed profile SHA-256 is
1d74f5fc194a759103291ebdd554c21f017555b4ea2ea74ab68f6776d26b2589.

Claude's focused resource review found claim-object reuse after group removal
and bind-subdirectory acceptance. Both are fixed and exercised in these real
KVM runs. Source-only review is not a substitute for that qualification.
Evidence is exported under outputs/kvm-box/evidence/native-resources.

These probes perform no GPU work, launch no production app, release no owner
secret, and authorize no worker. Numerical/performance acceptance, Moonlight
streaming, NucBox deployment and wallet publication remain separate work.

## Dedicated monitor integration

Build the monitor in the M3 module and the front in the M2 module with
`-tags native_desktop`; compile M3 `domexec.c` with `-DNATIVE_DESKTOP`.
These are separate measured binaries. An ordinary monitor/front/domain cannot
be switched into native mode with a load flag or marker file. The native
monitor requires its fixed T0-hv paths, kernel release, profile and verified
volumes. It admits only the exact controller bound by that profile, with a
sealed-secret deployment, measured public-web configuration, and valid resource
limits. Neither ordinary artifacts nor probe workloads are admitted.

The monitor consumes the guest claim and configures the cgroup before launch.
The controller runs as UID 5001 and the front as UID 1053577; native roles
1000..1003 are reserved guest-wide. The root-only `/native` tree contains the
supervisor's verified root/model binds and restricted guest device/sysfs views.
The outer platform bind excludes those submounts. Both chroot roots have their
own mounts so their children can make propagation private. Every parent-side
mount, including the recursively cloned models mount, is tracked for strict
reverse unmount; teardown does not use lazy detach.

Domexec installs the fixed UID network policy, mounts protected procfs, and
starts the supervisor and gateway before creating the owner-secret pipe.
These helpers inherit no owner-release descriptor. Only the controller gets
the app configuration and seccomp-statement channel. The front independently
parses the complete desktop bundle, checks its component against `/app.wasm`,
and verifies its AppID against the monitor's statement. Its native build rejects
missing identity files, ordinary bundles and mismatched components. The Wasm
controller stays in `secretrun` until owner provisioning supplies its secret.

The root-owned worker socket checks exact UID 1001 and forwards only through
the authenticated, one-use host worker transport. Loss of that transport or
broker retires the domain. Stream permission is revoked before cgroup teardown;
this does not release physical GPU capacity. The host manager must retain the
capacity reservation until VM removal is confirmed, including failed guest
cleanup. A poisoned guest retains its consumed claim and cannot be reused.

The disposable KVM integration uses the actual monitor, domexec, front,
supervisor and desktop graph, with the selected verified volumes. Its lifecycle
client is a privileged fixture that adopts the controller UID; it does not
prove owner authentication or execution of the Wasm controller. The successful
normal-stop run proves native graph readiness, role-network exclusions,
controller seccomp installation, clean W^X scan, configured cgroup limits,
sealed-secret waiting, strict process/mount cleanup and refusal of a second
guest claim. The worker is a synthetic test endpoint, not a physical GPU.
The happy-path initrd SHA-256 is
2dbae6fcf0e607abb561eba83fc4357b473564a78e751faf14f5088ec56de8b0.

A second fresh KVM guest revokes the authenticated host worker transport only
after the desktop is running. The production lease watcher ends the live
domain; all cgroup tasks and tracked mounts are removed, the claim stays
consumed, and host worker streams drain to zero. The guest fixture never calls
retire to make this happen. Its initrd SHA-256 is
928b7af7c21bf0333f848c8cdbcfa7ea6761b443d39e0d60839878c4575f4587.
Both complete in under 30 seconds after verified boot. Default and native front
tests pass, as do monitor race tests, native monitor tests and native monitor
vet. Host unit tests skip the explicitly guest-only integration test.

Claude supplied a source-only launcher draft and independently reviewed the
monitor lifecycle. Its two concrete untracked-submount findings are fixed.
Its capacity-release concern was checked against the actual worker transport:
closing stream permission cannot return or reassign the host allocation. The
corresponding comments now distinguish those obligations. Review output is
retained alongside integration evidence; it is not execution evidence.
Evidence is exported under outputs/kvm-box/evidence/native-monitor-integration.

## Native optical storage boot

The separate `native-boot.c` helper consumes three fixed-size ISO containers:
desktop root, root hash tree, and the existing combined model data/hash image.
The app's `guest/native/build_iso.py` constructs deterministic ISO9660 wrappers
with a fixed 65536-byte header. The guest does not mount ISO9660 or parse its
metadata. Hyper-V rejected raw non-ISO files at VM startup even though DVD
attachment readback succeeded; QEMU accepting them was insufficient evidence.

The helper identifies exactly three SCSI optical devices by pinned container
sizes, sets and verifies their block-layer read-only flags, and holds their
descriptors during setup. Three read-only dm-linear mappings skip the fixed
128-sector header. The measured dmsetup explicitly creates its device nodes
without udev. Kernel table, geometry and device identity checks permit only
the exact kernel-derived `/dev/dm-N` link or matching block node. Two dm-verity
mappings authenticate root and models against constants generated from the
measured profile. Their actual kernel tables are checked before mounting.

The root is read-only SquashFS; models are read-only, noexec ext4 with journal
replay disabled. The helper binds nsinit from the authenticated root, loads
its nft_ct module, and seals `/plat` read-only. Failure aborts setup; no app,
owner-release handler or GPU worker starts here. Production init must run the
helper after its required vTPM checks, before starting the monitor.

An actual KVM fixture invoked this helper and read all 564912128 root data
bytes and 2546024448 model data bytes through dm-verity. It checked the nsinit
bind, module load and platform write refusal. Six further KVM boots rejected
duplicate media, an extra medium, and corrupt root/model data and hash blocks.
The successful fixture initrd is
9080d42445b0ae942416d1ae45c720013806a92fd2fc8aa9f1a198c0ae28d1a0.
It uses a test initializer, not production dominit, and does not test owner
release, the GPU, or the native monitor together with this new boot helper.
The new root differs from the previously qualified monitor root only in the
Firefox locked SOCKS proxy address, corrected to 127.0.0.2:1080. Its measured
profile SHA-256 is
0036cf9866d663e19bbc2323d8673b4c0ec4d194f2e517e3686270ea92302c40.

The same full-volume helper fixture also passed on NucBox in a disposable
type-1 Hyper-V VM with three pinned DVD attachments, no NIC, and no hard disk.
Its non-debug IGVM is
b7f32c1a960d75000ac8e26b15d387d0508a31236535983f1b4b5946d5c73da5.
This proves the actual host's full-volume attachment and guest verification
path; it does not establish an attestation trust chain or exclude the host OS.

`dominit.c -DNATIVE_DESKTOP` now makes strict base mounts, enables loopback,
verifies CPU/memory/pids delegation, retains the required guest TPM selection
and device checks, then runs `/plat/native-boot` under a 90-second monotonic
deadline before execing the monitor. Native builds omit legacy module/probe
loading. Both builds compile with warnings as errors; the ordinary build's
executable `.text` is identical to the pre-integration build. Eighteen vTPM
selection checks pass. A KVM boot using the native initializer and builtin
marker refuses a missing guest TPM before invoking the storage helper.

The actual native initializer and helper then passed a NucBox boot with a
fixture in place of the monitor. The fixture received the exact report-host
and required-TPM arguments, checked the TPM device and cgroup delegation,
read both full authenticated volumes, and confirmed the sealed platform.
That initrd is
0da3e4b3582b8f193ed1e34018af2ac8513ac2f2eba8ef18a035d7a9390b6fca;
its non-debug IGVM is
9c735476b4419ed3707d80b6bc9a269cfa50d824c95aa519f13c1fe2cfd7caae.
This tests initializer-to-monitor handoff, not report cryptography or the
complete application launch. Production packaging and combined qualification
are described below; host admission and owner release remain to be completed.

## Production platform packaging and combined qualification

`python3 isolation/m3/build-native.py --spec native-platform-spec.json --out NEW_DIRECTORY`
builds the distinct native initializer, monitor, domexec, front and secretrun.
The spec uses schema `enclave-native-platform-build/1` with exactly `schema`,
`profile`, `runtime`, and `storage`. Every external file is an absolute path and
SHA-256 pair. Runtime keys are the six fixed names under `plat/rt`; storage
keys are guest paths for dmsetup, veritysetup, the ELF loader and their shared
libraries. The selected profile generates the helper's C constants. Runtime
identity must match the qualified Wasmtime 49.0.3 identity. The build receipt's
`inputPins` records a complete external-input mapping for reproduction.

The builder refuses symlink inputs, changed pins, duplicate fields, unknown
spec fields, invalid resource geometry, unsafe guest paths and existing output
directories. It inventories repository source and production embedded trust
roots before and after compiling. Go workspaces and implicit Go environment
configuration are disabled, modules are read-only, and the proxy is offline.
The archive contains no application component, test programs, probe modules or
nsinit copy; the latter is bound from the authenticated root. Root ownership,
fixed modes and zero timestamps are encoded without requiring host root.

The production initrd is
b95fa86668f666d8287542e776ad3d25e4e2921092a463312a04137551c57e3d.
Two reviewed-draft builds and the final builder produce identical archive
bytes. An independent newc reader checked every entry against the allowlist,
mode/owner rules and external input pins. Nine invalid-input cases are refused.
Tool versions and output hashes are recorded; this is not a hermetic build of
the entire compiler, static C library or Go module-cache closure.

A separate KVM test archive appends an explicit test initializer and monitor
test binary to those exact production bytes. With the v3 root and all three
ISO containers, both normal stop and live worker revocation pass. Tests cover
the production boot helper followed by the monitor/domain implementation,
resource limits, role separation, sealed-secret waiting, single-use claim,
W^X and seccomp checks and strict teardown. The test archive is
a998aeba1adf939d081a2032ea1bbb0306bf1223122014cc2d326c0f72be43d1;
its bundle AppID is
78bdc789f6b5805386e0c15f64d046ab456ed4550a0adbc64b1ac9f5407066a8.
It uses a synthetic worker and privileged lifecycle client, so it does not
prove owner release, Wasm controller execution, or real GPU work.

The unmodified production archive boots on NucBox with non-debug IGVM
299c3b30d214955bd233e60bc772ae90de385b94f4c80ccd2edfba06e90c6d61.
The real monitor reaches readiness; the Windows `hvdial` CLI successfully asks
its actual control port for `state` and `list`. This boot has zero domains and
one userspace process (the monitor). It establishes working production boot
and control transport, not application admission or attestation trust. A KVM
boot without the required TPM powers off before the helper/monitor instead of
leaving PID 1 in a kernel panic. The ordinary initializer's executable code is
unchanged by that native-only shutdown behavior.

Host admission still needs the dedicated three-volume image contract and
allocation/owner-release wiring. Native host memory sizing also needs its own
rule: a 12288 MiB NucBox VM reported 10951 MiB guest memory, so the ordinary
application-plus-640 MiB rule cannot simply be reused for an 8192 MiB native
allocation with its required guest reserve. GPU acceptance, Moonlight and
publication remain separate requirements. Evidence is exported under
outputs/kvm-box/evidence/native-platform-integration.
