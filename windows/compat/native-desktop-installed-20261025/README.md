# Native desktop node compatibility overlay

This is an offline compatibility port for the exact NucBox source pins in
`manifest.json`. It adds independent native release pins, desktop planning,
adoption checks, certificate expectations and private-route enrollment to the
installed node. It changes nine existing modules and adds nine runtime modules.
The remaining 83 observed installed modules are unchanged, including the local
CPU-share rules, wallet/lease support and compiled host-admission module.

The upstream native changes could not be applied directly because this host has
local changes and older manager interfaces. `node.patch` is the reviewed result
against the installed bytes. `port-hunks.json` records the upstream commits and
context adjustments used to port the changes. Only unchanged context was
trimmed; changed lines needed a unique exact match. The resulting patch applies
without context adjustment to the pinned installed source.

## Prepare without activation

Use a local snapshot of the installed public source modules. The script reads
inputs, checks every hash, verifies that new module names are absent, applies
the patch in a temporary directory and checks all output hashes and JS syntax.
It never writes to the installed source, changes environment variables, starts
or restarts a service, or publishes an app.

```sh
python3 prepare.py --installed /path/to/installed-public-source \
  --source /path/to/enclave-repository --output /path/to/new-overlay
```

Both the output directory and its parent must be under the intended workspace;
the parent must already exist. The output directory must not exist. Source
symlinks are allowed only when they resolve within the supplied repository;
installed input files must be regular files. No wallet, owner credentials or
production configuration files are inputs. The repository source pins include
the exact bytes of the nine added modules, so a later source update is refused
until the compatibility package is deliberately regenerated and retested.

`prepared.json` records the staged files. It is not deployment authorization or
proof that the manager can launch this image. Before eventual installation,
revalidate the live pins and absent paths, preserve a rollback copy, finish the
manager integration below, and test the complete proposed release.

## Validation and limits

`validation.json` records 31 passing native tests. The combined run has 112
checks: 111 pass and one capacity-accounting expectation fails. That exact
expectation also fails against the unmodified installed source; all 15 outcomes
in the installed-source baseline comparison are unchanged. The test expects
only isolated provisioning records to reserve capacity, whereas the installed
host reserves the other provisioning record as well. The failure is retained,
not skipped or counted as a pass. This is not an all-green test claim.

Six refusal tests cover changed installed code, changed new modules, existing
module collisions, an existing output directory, source symlink escape, and an
installed symlink even when its bytes match. Run them with the same snapshot:

```sh
NATIVE_COMPAT_INSTALLED_SNAPSHOT=/path/to/installed-public-source \
  python3 test_prepare.py
```

The independently prepared overlay matches the exact modules exercised in the
compatibility tests. Runtime dependency traversal excludes four modules used
only by the test fixtures. The tests use synthetic services and test keys; no
real wallet operation, RPC transaction or production VM launch occurs.

## Remaining integration

The installed manager still needs native admission, media/launcher selection,
shared resource reservations and authenticated worker transport. Its existing
CPU-share and guest quota enforcement must remain intact.

The signed v8 native monitor currently fixes effective CPU to the catalog CPU
policy. The installed node buys CPU by a share of its configured processor pool,
and its launcher confirms the requested guest quota. A share that differs from
the fixed catalog quota cannot be silently discarded or reported as enforced.
Resolve the native allocation contract and test the resulting guest quota before
activating native desktop admission. This overlay does not bypass that mismatch.

Owner provisioning, final GUI/Moonlight acceptance, publication and live
activation remain incomplete. No production services or configuration were
changed by this preparation.
