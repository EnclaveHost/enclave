# Remote storage-owner proof integrated; production RPC remains offline

Maintained rpcstorage.AuthenticateRemoteReservation verifies BOTH actual
owner-committed volume signatures, request/identity/runtime/epochs/export binding
and original guest clock. The authoritative ext4 journal stays at the owner;
only the existing OwnerIssuer creates its durable pair and persisted proof.
The guest retains a root0700 tmpfs audit receipt, never an authoritative writer
journal. Existing same-host AuthenticateAndReserve compatibility remains; both
paths publish the verified consent for the same one-shot export connector.
Neither path establishes writer settlement, release, readiness or adoption.

ExchangeOwner consumes/fsyncs an exclusive guest owner-submit intent BEFORE one
public request to the accepted bootstrap relay. Framed Unix stream, 4-byte BE
length, request<=4MiB/response<=64KiB; no private keys or FDs. Large real bundles
cannot fit ordinary Unix seqpacket buffers, so the relay uses a byte stream.
Exact raw response retained before verification. Monitor loss, EOF, ancillary
rights, oversized/truncated/ambiguous response refuse with intent held; no retry.
Original900 guest bound and owner's existing60s dispatch cap are not extended.
Relay bytes/returned exporter metadata never confer authority or prove death.

Concrete cmd/rpc-storage-broker composes exact monitor pidfds, own real
bootstrap.Reader.Authorize, one-shot relay, both remote signatures, protected
client credential inputs and exact signed mTLS export control. Fixed FDs3..11,
no path/endpoint/deadline override arguments. Actual root128MiB/noSwap/CPU1/Tasks32
kernel checks; original sealed clock; independent bootstrap guardian required,
internal timer supplemental only. Control-bound output always rootsGrantedfalse,
rpcReadyfalse,writersFencedfalse,reservationMayReleasefalse. No writable descriptor
grant. The current monitor3s acquisition deadline still closes an uncompleted
control-only acquisition; do NOT lengthen startup or call this a working broker.
A proper accepted bootstrap/relay and staged acquisition/attachment integration
must preserve the original900s window and independent termination before launch.

## Actual qualification

R1 dfc25b1a3cec4f86b24eed7f072fc3b3 terminal1/Main0. Both new command test methods
PASS (canonical complete JSON aliases/duplicates/missing/null/trailing refusal,
private read-only stable regular input size/mode/pipe refusal). rpcstorage failed
TEST compilation: copied new remote fixture retained old journal variable in
its final assertion. Runtime unmodified; all576pins rehashed unchanged after
terminal failure. Corrected only assertion owner.Name; failure retained.

R2 e89ae88e0be74379a8554ca6713a5e1f terminal1/Main0/3.798099159s/576pins unchanged:
63test/subtest PASS, one helper skip. All new remote owner proof, stream relay and
real control/guardian cases PASS. Sole failed case unauthenticated matched an
old error substring; actual refusal correctly preceded dialing. Corrected only
expected text, retaining failure. Existing affected package regression ran because
shared consent publication and connector prerequisites changed.

R3 22b9e7d386cb4bb988bf60e7819332dd terminal0/Main0/collected/2.283982605s/576pins
unchanged. Only corrected unauthenticated subcase and its parent PASS (2events),
then previously unexecuted broker and monitor compiles PASS. No successful test
or build replay. Across runs67successful test/subtest events (including parents),
not67independent native scenarios. After qualification only rpcstorage README
changed; all compiled runtime pins independently rehashed unchanged.

Release broker7503996B SHAd791e7db28e86853f175cd2cfcb4404f24c673970eb62493e2037725810b7392;
compatibility monitor8332104B SHA9264257a046b0dfc24b66b688e770e0533e66845c3f08076b1f6c0d0122b2d87.
Actual hashes independently recomputed. These binaries are local-only/notGit,
uninstalled; full broker command has NOT been executed as a provisioned service.
Its functions and new library composition are qualified separately. The prior
candidate image7e48feae1 is unchanged and does NOT contain this new broker.

New positive composition uses actual OwnerIssuer, real disposable ext4 pair and
proof persistence, separate guest tmpfs receipts, actual kernel monitor pidfds,
real TLS1.3 connection to maintained Python AppControl/guard, and blocked
SIGTERM-ignoring worker+descendant. External controller preheld both exact pidfds;
monitor loss -> both dead564.417018ms, owner records retained, reconnect refused.
This is same-machine isolated composition, NOT a real cross-host guest or Warden
provisioning. Chain quorum is MOCKED; keys generated/private; health fixture is
synthetic; no production data/export/provider/network route/funds/appRunning.
Remote proof refuses forgery/legacy/no remote binding/persistentguestjournal/
existingguestreceipt. Actual 300000-byte public payload traverses framedstream;
ancillary rights/oversized/EOF/monitor death/repeat submission refuse.

All512hard450RSSCPU1noSwap/original120suite150outer, private user/PID/network/mount
namespace/loopback only. Fresh authenticated resource readings94720,94705,94583MiB,
pending0 actuallyreported, installed18432/unread0; retained27648+640. Peaks73/120/197,
minimumavailable94665/94648/94533. No floor/time/cap relaxation, noWindows39388
prospective omission. Completed jobs terminal; NEVER rerun. Private data excluded.

## Remaining acceptance

Concrete next work: accepted bootstrap FD/credential provisioning and real
relay to the independently supervised owner dispatcher, then qualified
attachment/root grant and guardian. A staged acquisition acknowledgment is
needed if provisioning crosses the current3s monitor handshake; preserve the
original900deadline, not an extension or blind timeout relaxation. Need realHTTPS
owner authorization, actual guest identity/attestation and storage-owner
commitment/namespace/previouswriter settlement before writable grant. Native
NBD/optical/verity/TPM boot, per-role networking/filters, Base coverage, whole-stack
capacity, sync/finality/readiness, persistent adoption/event-driven authorization
and consumer deployment remain unproven. No synthetic host permission or manual
VM-as-app substitute. Windows5a ambiguity remains held; original8091 preserved.
Catalog preview already signed/confirmed, never republish/spend. Full goal active.
