# Root result: native app filesystem composition

Actual bounded invocation 2d26c65fe1c2494f9856dc08d278ede7 terminal0/MainPID0.
98 Go test/subtest checks PASS, 2 subprocess-helper skips (their actual child
paths ran through parent tests), plus 5 Python tests PASS and entry build PASS.
35.681769195s; 273 frozen source pins unchanged at verification. Root independently
rehashes current files and entry: 5350221 bytes, SHA256
bc9d477c600db187061680ee741df55dae4284b1c6082df91d0268ed79bc3db2.
Entry remains ERPCONE4 but now requires profile schema2 and pinned wrapper.
Output binary retained locally, excluded from Git and not production executed.
Peak tree RSS312MiB, minimum host available91625MiB. Authenticated admission
available91858/pending717/floor18432/unread0; retained27648 floor plus640 allowance.
Original120s suite/150s outer512MiB hard450RSS CPU1 noSwap; no cap or deadline change.

Meaningful new kernel check: actual private-user/mount/PID namespace binds a
dummy filesystem directory read-only and its exact held child writable. It
verifies nosuid/nodev/noexec flags, refused parent write, successful child write,
unchanged source mount flags, real inode binding and no mount leakage to the
parent. No production filesystem or host-root privilege is used. Other checks
cover symlink/escaped source refusal, ext4-root refusal, exclusive metadata,
mode restoration under restrictive creation defaults, and consumed partial
composition blocking transfer/abandon/retry. Existing namespace and supervisor
regressions passed. Python validates app/logical-volume/role ownership/framing
mutations and mount observations with mocks, retaining the historical UUID path.
Profile1/zero/mismatched wrapper pins refuse.

Prepared.ComposeCommand now builds the fixed root from held capabilities and
returns the existing one-shot command. It does not launch it. State attachments
require caller-authenticated exclusive writer authority; root-owned metadata
and logical IDs are not that authority. The full composition has NOT been
positively exercised on actual role-owned ext4 attachments. Actual role UID/JWT,
minimal devices, network, accepted platform, storage fencing, monitor load and
report registration, readiness/adoption, chain sync/finality and production
RPC remain unqualified. No production default, export, provider, VM, payment,
app deployment, catalog publication, reservation release or RPC-ready claim.

The unchanged client image is overlaid with the separately profile-pinned
maintained wrapper, avoiding a silent fallback to VM UUID expectations. Original
chain data is neither chowned nor modified. Composition errors retain mounts
and handles; this is not a cleanup certificate. Documentation was updated after
tests; a package-comment wording edit was immediately restored byte-for-byte;
all current executable/test source exactly matches frozen pins.
