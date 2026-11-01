# Actual framed owner relay qualified; production RPC remains offline

Maintained rpc/server/relay_owner.py supplies the concrete owner-side wire
entrypoint for the broker's request. It executes in the SAME existing independent
256MiB/CPU1/noSwap/Tasks32/60s dispatcher unit; checks that actual envelope before
input, then calls maintained dispatch in-process. No new native callback, service
listener, extra dispatcher or deadline. Prepared protected dispatcher/request
pins determine the entire attempt; network bytes cannot select keys, paths,
commands, endpoints, timeouts or another owner configuration.

An exclusive relay directory under the original clock consumes ingress before
reading any input. Its fsynced receipt binds exact unit identity and expected
wire digest. Inherited pipes only; big-endian length framing;3s ingress from unit
START (not after preparation), clipped to original900. Exact canonical wire must
match the pinned prepared owner request. Durable dispatch intent before actual
dispatch; response must equal the dispatcher's persisted file and is fsynced in
relay namespace BEFORE framed acknowledgment. Unknown outcomes/failed input/lost
response remain consumed. No retry, cancellation, reservation release or writer
settlement claim. Guest still independently checks both owner signatures.

Found/fixed a real integration size mismatch: dispatch_owner formerly passed the
whole bundle-bearing request to the64KiB public-contract parser. New
 decode_owner_request preserves small public-contract bounds but accepts at most
4MiB for the complete request, exact outer fields/canonical unique JSON/canonical
base64, bundle2MiB/manifest64KiB/inner request2KiB. This is encoding validation;
actual unchanged Go actor remains responsible for app/manifest/request semantics
and independent owner authorization. No signature or permission bypass.

## Actual tests

Unit4bd9a2ab70284f38ae72327e92b2f45f terminal0/Main0/collected:
9new methods+6affected dispatcher regression=15PASS,3.205317351s,51pins unchanged.
Real protected files and fragmented pipes with a300000-byte bundle; exact durable
response and repeat refusal. Canonical/duplicate/alias/invalidbase64/size bounds,
wrong request, original ingress expiry, truncated/oversized frames, ambiguous
dispatch, nonpersisted response and nonpipe transport refuse. SYSTEMD/DISPATCH
are mocked in unit tests. Whole command native composition follows separately.
Fresh authenticated available94641MiB/pending0 actuallyreported/installed18432/
unread0, retained27648+640;512hard450RSSCPU1noSwap120suite150outer;peak113/min94564.

Native d5c036e74a4b48c39d7156fecf6118cf terminal0/Main0/collected:
2.681311646s/52pins unchanged. Actual provisioner9035ce432a844c96b97b14da4b5f9277,
framed relay/dispatcher008bc8160c0e46fcab39434eead2dc86 and signer
1d4a471584d74fa6857d103d69626791 terminal0/Main0/collected. Actual exporter
54b1b860fce1410396fb170418c61300/attempt1b1442f69d604215849d3150c267024b
terminal2/Main0 expectedapp-control-lost; exact4preheldprocesses all-dead
89.061243925ms after controlclose, cgroupgone/empty, originaldummyhashes unchanged,
logicalvolume/proofrecords retained, no adoption or release assertion.

Actual3057-byte request traversed stdin length frame; actual1309-byte response
matched BOTH durable dispatcher and relay files byte-for-byte. Full unchanged
owner command/real signatures/ext4 pair+proof persistence/real kernel FDnamespace/
actual dispatcher/actual qemu-nbd dummy TLS exports execute. Opt-in prior pinned
TEST-ONLY owner b384bfcca342576ad4bbf6f1b19a1d6a06649b609872c73d7f75704e34e351e5
from rpc-owner-state-build-r1 is reused without rebuilding; its chain HTTP
RoundTripper is MOCKED. This binary has its separately recorded historical source
revision, not a claim that all latest Go dependencies were compiled. Current Go
owner command and owner issuer were unchanged. No new release binary produced.
Ephemeral storage keys/dummy sparse images only, synthetic Windows clock explicit.
Local pipes, NOT real cross-host transport/accepted guest/attestation/realHTTPS
chain/kernel attachment/production volumes/client RPC or consumer cutover.

Original900 begins before preparation. Native full1664MiB allowance includes
wrapper128/controller512/provision128/signer128/dispatcher256/export384/overhead128;
fresh actual94731available/pending0/installed18432/unread0, retained27648floor.
Zero actuallyreported, not Windowsprospective39388 assumption. CPU1/noSwap;
outer90/controller65s, provision/sign20s+1stop, dispatch60s+1stop,
exportoriginal900+2swatchdog. Controllerpeak76/min94659,exportpeak55697408B.
All exact generated units reobserved terminal; no completed helper rerun.
The --relay fixture omits old unrelated state-poison tests; it does not replay
signing, provisioning or export for the same attempt. New random disposable
attempt exercises the new wire composition once. Full failed evidence: none.

After qualification only rpc/server/README.md changed to describe actual results;
runtime source pins still match and docdelta is recorded. Public receipts and
changed frozen source preserved; unchanged inputs verified with actual git
cat-file against1c8dc83ac. Private authority/journals/keys/TLS/dummydata/testbinary
excluded. No production service installation, wallet/chain transaction, VM,
appRunning, catalog or route change. Original8091/Windows5a held state preserved.

## Remaining integration

The actual guest bootstrap/credential provisioning and authenticated cross-host
bridge still must connect FD7 to this owner command. That bootstrap must obtain
the exact monitor request and prepare the original owner configuration before
launching this one-shot entrypoint; no arbitrary caller-created replacement
request is accepted. Accepted guest identity/attestation, actual owner commitment,
authoritative volume namespace and previous-writer settlement remain mandatory
before writable grants. Current broker does not attach or grant real roots.
Native NBD/verity/optical/TPM lifecycle, network/role filters, Base coverage,
full stack fit, sync/finality/readiness, persistent adoption/event-driven auth
and consumer deployment remain incomplete. No fake grants/hostJSON attestation/
guest-local owner journals/manualVM-as-app fallback. Full cold recovery/new-user/
storage-endpoint failure/independent hosting under Enclave refusal not proved.
Catalog preview already confirmed; never republish/sign/spend. Goal active.
