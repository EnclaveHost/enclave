# Shield local transport admission (P1) and callback-key privacy (P2): result

**Repository:** `wo/work/enclave`.

**Constraints kept:**
- nothing committed or staged;
- no production, chain, Wine or GUI activity;
- on the minipc: no services, manager config, VMs, registry, real operator keys or new users touched.

**Inputs:** `work/claude-shield-peer-review-result.md` and `work/shield-peer-review-interface.txt`. **Interface**
(published before implementation, results appended): `work/shield-local-auth-interface.txt`.

**Scope.** This protects the package (9446) and custody (9445) loopback servers, and the callback key, from **other local
callers**. It does not remove host trust from T0-hv: an administrator or SYSTEM process on the host remains trusted.

## What changed

| File | Change |
| --- | --- |
| `windows/vbslike/manager/bridge-auth.mjs` (new) | The per-start credential (32 random bytes) and the `createBridgeGate` admission. |
| `windows/vbslike/manager/custody-transport.mjs` | The server sits behind the gate. `requests` (the lifetime budget) and the pending slots count authenticated connections only. The bridge is spawned with `--worker-auth-stdin`, and the credential is written to its stdin. |
| `windows/vbslike/manager/package-transport.mjs` | Likewise: `served` counts authenticated connections only. `close()` now destroys its connections. |
| `windows/vbslike/host/src/bin/shielded-bridge.rs` (real bridge) | An opt-in `--worker-auth-stdin`, lifetime 0 only. The credential line is read from stdin before the hv_sock bind and written at the head of every worker connection. The rest of stdin is the stop signal. The 5-argument (egress, GPU) form is unchanged. |
| `windows/vbslike/host/src/bin/bridge-auth-check.rs` (new) | A box-run check over Hyper-V socket loopback, a sibling of `bridge-drain-check`. |
| `windows/vbslike/manager/testdata/fake-custody-bridge.py` | The same stdin protocol (fixture). Its `VM <guid>` peer line stays a synthetic stand-in, fixture-only. |
| `windows/vbslike/manager/custody-key-file.mjs` (new) | `readCustodyCallbackKey`: POSIX mode 0600; win32 owner and DACL through `Get-Acl` (path in the environment, not the script); refuse-only, never alters. |
| `windows/vbslike/manager/main.mjs`, `windows/node/agent.mjs` | Both read the key through `readCustodyCallbackKey`. The win32 skip is gone. |
| `windows/installer/install-host.ps1` | An additive block after the ProgramData ACLs (described below). |
| `test/windows-shield-local-auth.test.mjs` (new) | 7 tests. |
| `test/windows-shield-custody-transport.test.mjs`, `test/windows-shield-package-transport.test.mjs` | Updated for the credential. Two direct-connection expectations now assert refusal; one key-file message is updated. |

### P1: the mechanism, and why

**Choice.** A per-start credential handed to the bridge on stdin was chosen over ACL'd IPC. The real bridge keeps its TCP
worker relay, so egress and GPU users are untouched, and a named-pipe transport in Rust is avoided.

**The flow:**
1. The manager mints the credential.
2. It spawns `shielded-bridge <vm> <port> <loopback port> 0 --worker-auth-stdin` and writes
   `enclave-bridge-auth-v1 <64 hex>\n` (88 bytes) to its stdin.
3. The bridge validates that line before binding hv_sock.
4. The bridge writes the line first on every worker connection.
5. The gate (`createBridgeGate`) compares it in constant time, accepting the line delivered in pieces and rejecting
   early on the first mismatching byte.

**What unauthenticated connections cost.** A connection that is empty, wrong, a bare guest-shaped request, or partial
then silent is closed within `authTimeoutMs` (2 s). It consumes no budget, pending slot or serve.

**Bounds on the gate:**
- At most `maxUnauthenticated` (16) wait at once. Beyond that, the oldest connection that has sent nothing is evicted.
  The bridge's line arrives in its connection's first segment, so a flood evicts its own connections.
- Every timer and socket is cleaned up.
- `server.maxConnections = maxPending + 2 + maxUnauthenticated`.

**Leak analysis:**
- **argv, environment, logs:** the credential never appears in any of them. The ready line says only ` auth=stdin`.
  Errors name only the format; tests check argv, stdout, stderr and the fixture log.
- **Stdin:** an anonymous pipe whose handles only the manager and its child hold.
- **Loopback traffic:** reading another session's loopback traffic needs administrator rights.
- **SYSTEM process memory:** readable only by SYSTEM, administrators, or SeDebugPrivilege holders, all host-trusted on
  T0-hv.
- **Residual:** a local flooder can only cost availability, bounded by the gate.

### P2: callback key privacy

**win32 rule (manager and node).** Required:
- the owner is SYSTEM (`S-1-5-18`) or Administrators (`S-1-5-32-544`);
- every ALLOW entry, explicit or inherited, is SYSTEM or Administrators;
- SYSTEM has read;
- the DACL is not null.

Deny entries are ignored. Both services run as SYSTEM (`install-host.ps1`: the `\Enclave\Shield` and `\Enclave\Node`
tasks).

**On refusal,** the reason names the entry, and startup is refused (manager: exit 2; node: custody stays off). Nothing is
chmodded or re-ACL'd.

**Installer.** For `%ProgramData%\Enclave\shield\custody-callback.key`:
- **if absent:** 32 random bytes of hex, created by the same call that applies its security descriptor (protected DACL
  with SYSTEM Full and Administrators Full; owner Administrators). There is no window with another DACL.
- **if present:** checked with the same rule and reported as a warning; it is never modified.

The block is inert: it adds no `ENCLAVE_CUSTODY_CALLBACK_KEY_FILE` or `ENCLAVE_SHIELD_CUSTODY_V2` line, so activation
stays explicit. No other file is touched.

## Tests

### Local

All serial, under 250 MiB each, with MemAvailable never below 16 GiB.

`windows-shield-local-auth` (new, 7 tests):
- custody: 40 hostile connections against `maxRequests 3` leave `requests 0, refused 0, pending 0`; the genuine bridge
  request is then served and answered; a credential and request delivered in pieces work;
- a 12-connection flood against `maxUnauthenticated 4`: evicted 8 or more, the bridge's request is admitted, and the gate
  drains to 0;
- package: 20 unauthenticated readers get nothing and spend no serve; authenticated reads stay within `maxServes`;
- through the fixture bridge: the guest reads the frame, a direct loopback reader does not, and no credential appears in
  argv, output or the log;
- protocol agreement: the Rust constants equal the JS ones; the credential is read before bind and written before relay,
  and no output macro is given it; the 5-argument form and the lifetime-0 rule hold; the fixture refuses a bad line
  without echoing it;
- the key file: missing, a directory, mode 644 or 640, and malformed are refused; 0600 is accepted; the file is never
  chmodded; win32 is decided by the ACL;
- the win32 rule: Users (inherited), Everyone, Authenticated Users, a user SID, a user owner, a null or missing DACL,
  SYSTEM without read, and WRITE_DAC only are all refused; a deny ACE is ignored; the path travels via the environment;
  a single-ACE `ConvertTo-Json` unwrap is handled.

Regressions (each suite separately, with its own pass count):

| Suite | Pass |
| --- | --- |
| `windows-shield-custody-transport` | 10 |
| `windows-shield-package-transport` | 5 |
| `windows-shield-image-selection` | 12 |
| `windows-shield-startup` | 15 |
| `windows-isolation-manager-restart` | 5 |
| `windows-node-reboot-recovery` | 5 |
| manager `main.test` | 13 |
| manager `server.test` | 46 |
| manager `egress.test` | 10 |
| manager `wmi-launcher.test` | 64 |
| manager `shield-profile.test` | 5 |

All 0 fail. The suites using the package transport were rerun after the `close()` fix, and still passed.

### Mutation checks

These ran in an isolated on-disk copy (`work/claude-shield-local-auth-mut`), which was deleted afterwards. Every file was
verified restored and identical to the shared tree. All 10 mutations are detected as failures:

| Mutation | Result |
| --- | --- |
| Gate bypassed | fail 3, cancel 4 |
| Budget spent before auth | fail 2 |
| Serve spent before auth | fail 2 |
| win32 ACL not checked | fail 1 |
| POSIX mode not checked | fail 1 |
| No eviction | fail 1 |
| No auth deadline | fail 3 |
| Fixture omits the credential | fail 1 |
| Credential in argv | fail 1 |
| Foreign ACE allowed | fail 1 |

The "no auth deadline" mutation first hung the package test. That exposed a real gap: `servePackage.close()` waited on
open connections. It is now fixed, and the re-run fails cleanly.

A test child left orphaned by that hang (its working directory the deleted copy) was stopped. No fixture or test process
remains.

### Native

These ran on the minipc, with SSH, only under `C:\Users\claude\enclave-staging\claude-shield-local-auth`.

**Build.** `cargo build --release --offline -j 2 --bin shielded-bridge --bin bridge-auth-check` took 23 s, with
pre-existing dead-code warnings only. Hashes:
- `shielded-bridge.exe` `8912ac7d1c4ffeaebe497561ea023fa3a6c8b3cd023bcd9d42746ae86769d3f8`;
- `bridge-auth-check.exe` `8b33001e…e917`.
The two binaries are kept in `…\built`; the 80 MB of intermediates were removed.

**The real bridge over Hyper-V socket loopback** (no partition, no registry; test ports 9978-9982). `bridge-auth-check`:
ALL PASS.
- With the flag, the worker received exactly 121 bytes: the 88-byte line, then the guest's.
- Without the flag, it received only the guest's bytes.
- A malformed line, EOF before the line, and a nonzero lifetime were each refused before bind, without echoing the
  input.
- No bridge was left running.

**The real JS servers behind the real bridge** (`work/claude-shield-local-auth-staging/interop.mjs`, ports 9983/9984):
- 30 hostile local connections each, then:
  - package: `served 0`, then the guest got the exact frame (`served 1`);
  - custody: `requests 0, pending 0`, then the guest's request was listed, answered, and returned to the guest
    (`requests 1, answered 1`).
- Gate: `unauthenticated 30, authenticated 1, waiting 0`.
- No credential in either ready line.

**The installer block (verbatim) and the real ACL check on NTFS** (`acl.ps1`, against a staging copy of the protected
`shield` directory):
- the block created the key with SDDL `D:P(A;;FA;;;SY)(A;;FA;;;BA)`, owner BA, and the check **ACCEPTED** it;
- **REFUSED**, naming the SID and rights: + Users R, + Everyone R, a user-profile ACL (a user SID), and a missing file;
- an existing non-private key gave a **warn**, with the ACL and the content byte-identical before and after.

**One native case differed from the plan.** A plain copy made by the elevated admin account came out owned by
Administrators, which is Windows' default owner for an elevated admin, and it was accepted. That is correct by the rule.
The "user-owned" refusal is covered by unit tests only: proving it natively would need another local user, which was not
permitted.

All test key material was deleted from staging (no `.key` files remain).

## Release and activation notes

- **Ship the rebuilt bridge with the manager.** The new manager starts the package and custody bridges with a sixth
  argument. An old `shielded-bridge.exe` rejects it (usage error), so a mismatched release fails those starts closed.
  The release bundle's `bin/shielded-bridge.exe` and its pin must come from the rebuilt source. The staging binary is
  for review, not release.
- **Activation of direct custody,** still explicit and still to do:
  - set `ENCLAVE_CUSTODY_CALLBACK_KEY_FILE` to the installer-created key, for both the manager and the node;
  - set `ENCLAVE_SHIELD_CUSTODY_V2=1`;
  - register the 9445/9446 services if hardware confirms they are needed (the peer review's open question).
- **The staged guest candidate** at `C:\ProgramData\Enclave\staging\shield-direct-c7084346` was not touched, and remains
  unactivated.

## Remaining hardware boundaries

- **The VmId check** on 9445/9446 against a real type-1 partition: loopback proved the credential protocol, not
  partition identity. The fixture's `VM` line stays synthetic.
- **Whether WMI type-1 partitions need GuestCommunicationServices entries** for these ports.
- **A real Shield-direct guest** reading its package and obtaining custody through this path.
- **The callback key** on a real install, read by the SYSTEM-run manager and node.
