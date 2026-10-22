# Host capacity records: result

Repository `work/enclave`, HEAD `abe86262`. The only commit since 45801c22 touches `windows/installer/*`, which nothing
here depends on. Nothing was staged or committed, and nothing touched production, SSH, a wallet, GUI or Wine. Every
owner file is unchanged: supervisor, Dockerfile, Windows agent and CLI changes exist only as tested patches.

Exact hashes and git states for every file are in `work/host-capacity-source-inventory.json`.

## The open item from last session: "supervisor signs while unregistered" survived

**The guarantee was weaker than claimed.** The hook gated signing on `_registered` alone. In
`supervisor.js`, `registerOnChain`:

- sets `_registered = true` *before* the register transaction lands ("claim before await");
- keeps `_registered` true with the old `_registeredOn` after the address book repoints `REGISTRY_ADDRESS`;
- leaves `_advertisedEndpoint` from an earlier registration in place. The claim selftest paths also set
  `_advertisedEndpoint` and `_enclaveId` without registering.

So the hook could sign during an in-flight registration or against a repointed-away registry. Readers would still
have refused such records, because registry verification catches them, but the producer was claiming an unconfirmed
identity. The test only covered "never registered", which is why the mutation survived. A second reason it survived:
the hook passed two separately gated functions (endpoint and registry), so ungating one half could never sign.

**The fix.**

- **`network/host-capacity-producer.mjs`** now takes ONE gate, `identity() → {endpoint, registry} | null`.
  - It is read on every request and again after signing, so a record signed while the identity was lost is never
    served.
  - The cache is never used without a current identity.
  - Passing both `identity` and `registry`/`endpoint` is refused.
- **The supervisor's `capacityIdentity()`** signs only when all three hold:
  - the once-guard is up;
  - the registration went to the registry `REGISTRY_ADDRESS` names *now*;
  - `_enclaveId`, which is set only when the register transaction succeeded and cleared by a repoint, equals
    `keccak256(endpoint)`.

  Two conjuncts that mutation showed were implied by others were removed, so every remaining one is necessary.
- **The Windows hook** uses the same single gate: the registry row this box read for its own endpoint must be active,
  name this key, and come with a known registry.

**Tests.**

- **`supervisor-capacity.test.mjs`** boots the real `supervisor.js` through the `HOST_CAPACITY_SELFTEST` seam, which
  now sets each registration state. It covers:
  - confirmed: signs;
  - never registered;
  - register transaction in flight with an endpoint known;
  - failed or reset registration with endpoint and id left behind;
  - registry repointed;
  - once-guard down with registry and id recorded;
  - endpoint differs from the one the transaction landed for;
  - landed id with no endpoint;
  - not advertising.
- **`windows-capacity.test.mjs`** gained a deactivated-row case.
- **Producer unit tests** cover identity lost mid-signing, lost while the cache is fresh, and moved registry.

## Mutation results, all on the final sources in an isolated copy, each against a passing baseline

| target | baseline | killed |
|---|---|---|
| supervisor gate: the earlier survivor's shape, the previous patch's gate, no once-guard, no current-registry check, landed id not tied to endpoint, no landed-transaction check | 9/9 | **6/6** |
| Windows gate: no active check, no operator check | 3/3 | **2/2** |
| core: operator binding, active, signer, hostId=keccak(endpoint), replay floor, expiry, equivocation, SSRF address guard, redirects, code pin, schema pin, double counting, hidden outage, directory older-record, producer post-sign recheck | 9/9 | **15/15** |

A 16th core mutation (dropping the producer's early `if (!id)` in `current()`) survived because the check was implied.
I removed that line rather than keep an untestable guard, then re-ran the suites: 9/9 and 9/9.

## Tested source and actual results (final sources, bounded, serial)

Each run was foreground, at most 512 MiB per node, with MemAvailable at 17–18 GiB throughout. Peak RSS is for the
whole process tree.

| test | where | result | peak RSS |
|---|---|---|---|
| `test/host-capacity.test.mjs` | real tree | **9/9**, exit 0 | 268 MiB |
| `work/…/supervisor-capacity.test.mjs` | patched copy (supervisor base `8d1b9262`) | **9/9**, exit 0 | 278 MiB |
| `test/direct-only-supervisor.test.mjs` (existing) | patched copy | **4/4**, exit 0 | 242 MiB |
| `work/…/windows-capacity.test.mjs` | patched copy (agent base `ce9eabf3`, committed) | **3/3**, exit 0 | 393 MiB |
| `test/windows-node-deploy-files.test.mjs` (existing) | patched copy | **3/3**, exit 0 | 55 MiB |
| `test/windows-node-retired-engine-agent.test.mjs` (existing) | patched copy | **1/1**, exit 0 | 243 MiB |
| `work/…/cli-capacity.test.mjs` | patched copy (cli base `5c21db40`, `cli/independent.mjs` `36b3a364`) | **3/3**, exit 0 | 290 MiB |
| `test/cli-independent.test.mjs` (existing anvil suite, with the one-line assertion patch) | patched copy | **14/14**, exit 0 | 389 MiB |
| `test/windows-node-availability-labels.test.mjs`, `test/cli-deploy-isolation.test.mjs` (existing) | patched copy, previous session; their inputs are unchanged since | 6/6, 12/12 | 152 / 278 MiB |

I confirmed the six patched owner files are byte-identical to the tree the tests ran on: I applied the patches to
fresh copies of the current owner files and compared them to the tested copy. My seven source and test files are
likewise identical to the tested copies.

What the tests cover:

- **Real wire paths:**
  - signed records over real HTTPS from host producers, including a Windows-style `/t/<name>` endpoint;
  - real HTTP directories (POST and GET);
  - verification at one agreed block of a schema-4 registry behind two JSON-RPC servers, through the committed
    `quorumReader`, and through `cli/independent.mjs`'s `QuorumChain` in the real `enclave` binary.
- **Refusals:**
  - changed operator, with the new operator not vetoed by the old floor;
  - stale or replayed records, persisted across restarts with `--state`;
  - expired records;
  - equivocation;
  - fake, unregistered, inactive, foreign-chain or foreign-registry records, and a forged signature;
  - wrong code or schema agreed by the quorum;
  - one RPC down, or one RPC lying.
- **Outage transparency:**
  - unreachable hosts are reported as `unreachable` with `unknown` counted;
  - dead directories become source errors;
  - with no quorum, the read is refused and never treated as zero.
- **No double counting:** the same record seen from host plus two directories counts once.
- **Shield tier:** kept separate, `hostExcluded: false`.
- **Bounds and SSRF:**
  - non-global resolution and redirects are refused;
  - plain http and credentials are refused;
  - oversized replies are refused.
- **The real `enclave` CLI:**
  - **zero** non-loopback connections and **zero** hits on the stand-in Enclave API;
  - without `--independent`, output is **byte-identical** to the unpatched CLI.

## Integration patches (coordinator applies once the owners release)

Location: `work/enclave/work/host-capacity-integration/`. Apply with `patch -p1` from the repository root, or with
`python3 work/host-capacity-integration/apply-edits.py .`. Every anchor must be unique, and the script refuses
rather than half-patching. `make-patches.sh` regenerates the patches if a base moves.

| patch | base sha256 (prefix) | content |
|---|---|---|
| `supervisor.patch` | `8d1b9262c5af5f2f` (dirty, owner: move-fix worker) | producer import; `capacityIdentity()`; `GET /v1/host/capacity`; optional `HOST_CAPACITY_DIRECTORIES` publish (no default); `HOST_CAPACITY_SELFTEST` seam |
| `dockerfile.patch` | `a535509f9397171c` | COPY `network/{canonical,host-capacity-record,host-capacity-producer}.mjs` (no packages) |
| `windows-agent.patch` | `ce9eabf345a45026` (committed 45801c22) | producer with the row/key identity gate; `/v1/host/capacity` frame route; `deploy-files` ships exactly the three package-free files |
| `cli-enclave.patch` | `5c21db40f393806f` (dirty, owner: CLI/move worker) | `availability --independent --capacity-directories … \| --hosts … \| --cold [--max-hosts] [--capacity-state]`; requires `--profile`; help line |
| `cli-docs.patch`, `cli-independent-test.patch` | `d3660d23…`, `a5c2fed2…` (untracked, CLI worker) | the docs refusal becomes the supported command; the existing suite's assertion follows the new, more precise refusal |

`--capacity-directories` is deliberately not the existing `--directories`, which names management directories over a
different protocol.

## Remaining blockers and limits (precise)

1. **The patches are not applied.** `supervisor.js` and `cli/enclave.mjs` are dirty under other owners. Until the
   coordinator applies the patches, `enclave availability --independent` still refuses, and hosts serve no record.
   - Until then, `cli/independent-capacity.mjs` already works standalone (`record`, `publish`, `serve-directory`,
     `availability`).
2. **The measured supervisor image changes.**
   - The Dockerfile patch adds three files, so a rebuild and a new measurement are needed before hosts serve records.
   - Not built or activated here.
   - `cli/dist` was not rebuilt or promoted.
3. **The supervisor's full `/availability` success path was not booted.** The VM manager is absent, so the boot test
   signs the 43-key fallback document. The full-path pass-through fields are covered statically and by a synthetic
   full document in the unit tests.
   - A real manager reply over 32 KiB, or with arrays longer than 256 entries, would make the producer answer 503.
   - That 503 is visible to readers as `unreachable` with the reason; it is never reported as zero.
4. **Windows hosts under `https://<relay>/t/<name>` are reached through the Enclave relay as transport** when read
   with `--hosts`/`--cold`.
   - Fully relay-free reading of those hosts needs a capacity directory or the host's own domain.
   - The record itself does not depend on the relay.
5. **No live read was run.** The profile pins the live Base registry (`0x868e…cac`, codeHash `0x3991…f518`), but every
   chain read here is a local fixture.
6. **Directories keep floors in memory.** A restarted directory could re-accept an older, still-unexpired record, so
   staleness is bounded by the 15-minute maximum lifetime. Readers using `--state` refuse it.
7. **What a signature proves.** It authenticates the operator's report, not hardware or a reservation. Attestation at
   claim and connect time remains the hardware proof, and there is no reservation protocol: a claim can still fail.
8. **The CLI integration depends on `cli/independent.mjs` (untracked, CLI worker).** It needs `QuorumChain.snapshot(fn)`
   returning `{value}`, adapted by `agreedRead()`. If that API changes, `cli-capacity.test.mjs` catches it.

Isolated copies under `/tmp` are removed. No background jobs remain. The `anvil` processes on this host belong to other
projects or workers (none has my copy as its working directory) and were left alone.
