# Frozen r12 consumer and durability review

Read-only review of exact230-file author delivery, manifest `0c04ee45aa28215eb0cd5577654bda1f460d57261b4dbfdc0fda60e5b1d966d5`. No test/build/module execution, product edits, network, signing, finance or production action here. Findings below are SOURCE EVIDENCE, not executed crashes, stale POSTs, double sends or lost records. Root owns the focused executable consumer loop. No automatic r13 preparation.

## Improvements present in source, not yet qualified here

The Host now carries its original launch snapshot through isolation-lifecycle to supervisor plan.basis; runtime plans.read compares it with the admitted snapshot and rejects replacement during the capability await. The protected client has a new-work predicate before stage and permit request calls. settleStart re-reads its unknown predicate and journal after inventory resolves. Unknown-stage cleanup is per route, with bounded supervisor waits that retain the underlying operation. Direct and sponsored sends now use a separate file-backed record store. These are meaningful consumed-path changes, but each requires actual positive/race tests and crash durability qualification.

## 1. Missing record file is still treated as fresh; durability errors are swallowed

`control/windows/node/operator-obligations.mjs:36` returns an empty object on every ENOENT. There is no initialized-genesis marker or owned-log handle distinguishing a first installation from deletion/loss of an established journal. Thus the REPORT claim that a *missing* journal refuses every write is inaccurate: unconfigured path refuses, configured-but-absent file initializes implicitly. `r12-durable-send-restart.test.mjs` covers missing configuration and malformed JSON, not deletion of an established store.

`writeAtomic` line25 catches every directory-open/fsync/close error and assumes Windows unsupported. A real Linux I/O error is also ignored. Line23 calls writeSync once without checking a complete write. Failed temporary files are not cleaned on exception. The store validates only schema and records-object shape (line38), not exact record identity/state/nonce/body. It accepts overwriting a key and uses read-modify-rename without physical exclusion or compare/version control; independently loaded sender instances have independent chainTx queues. This is not the owned-durable log discipline already used by protected VM obligations.

Required targeted tests: initialized store with unresolved write -> file absent -> no new inert write; injected directory-fsync failure -> no effect; short write -> no effect; two same-identity owners -> second refused or exact serialization; foreign/malformed record -> no new effect. Keep genuine first-install initialization explicit. Missing/unknown obligations are never an empty state. Qualify platform durability rather than swallowing every error.

## 2. A known-unsent final refusal can leave a permanent attempted-write quarantine

`chain.mjs:288-291` puts the sending record, then rechecks the gate. If that check refuses, catch at301 immediately rethrows notSent; wrote is still false and writeContract has not been called. The exact record remains as sending. durableBlock then waits for a mined nonce that this operation never sent. This can unnecessarily block all later direct work. Preserve conservatism on uncertain effects, but discharge a provably unsent exact owner-bound attempt when the final gate refuses before invocation. Add the actual direct sender case: allow initial checks, refuse the post-persist check, assert zero inert writes and exact unsent cleanup; a later unchanged-authority positive must work without nonce replacement/cancellation. A failed cleanup may conservatively retain the record, but must not be presented as an unknown broadcast.

The durable record stores JSON args truncated to2048 characters (line288); the report's 'exact intent' wording is too broad. Record a complete bounded canonical request or a sufficient digest/identity for the intended reconciliation contract; never silently truncate the only request representation.

## 3. The policy callback is before an awaited control handshake, not at actual POST

`protected-isolation.mjs:291` checks policy before calling control.request at298, and line382 checks before permit request397. The real `control/isolation/m4/guestd/control-client.mjs:196` then awaits `_current()` (possibly a fresh hello/session handshake), before `_send` at197. No live permission callback is carried to that send boundary. Permission may change during this await without the earlier check seeing it. The new policy negative flips the file in Host.isolationVerdict, before later supervisor checks; it does not cover this boundary.

Carry an operation-specific last-send gate through the actual authenticated transport, rechecking after session acquisition/renewal immediately before stage/permit request bytes. Keep hold/Stop/cancel and read-only reconciliation outside new-work admission. Preserve unknown operation records when a request could already have executed. Test with real GuestdControl and held handshake/session (external server fixture), then revoke/corrupt policy; assert no stage/permit POST while Stop remains usable. Separate owner loss and policy loss after a possibly executed request; do not claim an earlier local check revokes a request already sent.

## 4. Sponsored recovery still needs the actual shipped bundle and recorded identity

No new r12 test exercises the shipped lease-gas-runtime.bundle; existing r11 tests replace it with an emulator and were not updated for required journals/function-form withheldLeaseSignatures. Do not count those as actual-client qualification.

At chain399 the withheld record contains message/signature/time, not the signing domain/account. Resolver lines546-547 reconstructs withheld-only operator/chain from CURRENT acct/base and omits executor/ledger. The requirement is recorded identity, not current configuration. Persist exact signing domain and operation identity before signing; confirm deadline/nonce reconciliation cannot be redirected by later config changes. This is a source issue, not an assertion that the withheld signature was disclosed.

The store persists an empty begun record before signing; the catch at480 and read-only resolver540 can classify no-intent/no-post as unsent. That classification must be qualified through actual account/client/onSigned/POST ordering and crash boundaries. Preserve a signed or posted obligation durably even when its final record update fails. Test signature-time refusal, journal failure, earlier POST plus later refusal, process reconstruction and exact expiry/consumption. No operator-funds fallback, replacement or nonce jump.

## 5. Consumer fixture and report scope/provenance need correction

The new real-consumer test imports actual Host/factory/owned authority/manager/router code and attempts a full positive. It explicitly flags unverified admission snapshot and Host plan inputs. It must run before any success claim. Tests for actual-dispatch late commitment/unknown work, independent raw-cleanup Stop, owner loss, actual sponsored bundle and native workloads remain absent.

The header claims a native-role Manager/two-manager rig, but this fixture only constructs one ProtectedManager and points nativePort to1. No ordinary neighbor is started. Native and neighboring workload coverage do not follow from this file. The report itself lists native work unfinished. Use the real scope when publishing.

REPORT section2 says 'authored first'. The verified mutation replay shows52 successful mutation events: event1 edits isolation-lifecycle; the real-consumer file is written at event50, after product changes, operator-obligations and restart tests. Preserve original author output, but correct this chronological claim in the root review. No tool-scope/replay violation occurred; this is a report accuracy correction.
