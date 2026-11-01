# Guest-created RPC bootstrap identity; production remains offline

Previous goal turn NO PROGRESS (catalog confirmation only). This turn implements
actual dedicated-monitor control integration and owner verification, not a running
RPC service. The monitor generates one guest-held Ed25519 key and self-signed
client certificate for the actual loaded bundle, fixed immutable runtime and
exact storage request. No host key input/private key output. The original nonce
is preserved by AcquireRequest, which rechecks bundle/boot/window before any
namespace access. The monitor waits under its existing original PID1 cutoff;
public info, one guest-TPM challenge and one acquisition signal do not grant roots.

The report binds exact canonical request, SPKI, certificate, owner challenge and
runtime with a separate bootstrap purpose. Actual control path calls guest TPM
Report directly; absent TPM refuses, never launcher fallback. Failed/lost/late
report stays consumed. Local credential handoff is single use; actual bounded
broker launch still must call it and replace the command's external key inputs.
No target hardware or whole provisioned broker was executed.

Owner verifier uses real full TPM boot/credential/quote/log/IDKS/VBS verification
with explicit owner image/runtime/profile/signer/product/module pins and actual
TLS client certificate input. No Enclave registry/service/default authority.
Caller must own/consume a fresh challenge and its independent deadline and verify
actual deployment/volume authority. The verifier is not a replay store, permission
server, writer fence or running attestation. rootsGranted/rpcReady remain false;
hostExcluded false. No normal app report or secrets-purpose acceptance.

## Actual qualifications

R1 invocation4d6e90f79ada41949aff154a9006e678 terminal1/Main0,4.701137754s/600pins:
Go5bootstrap methods+7subtests,1monitor method,1preparedrequest method all PASS
(14test/subtest success events plus3package events). Actual local TLS1.3 handshake
proves generated client key possession, public output lacks private material;
repeated local credential handoff refused. One-shot report/acquire, failed/oversize
hardware, invalidboot/request/challenge, delayedhardware/original80ms expiry,
close-wakeup and every authority-input binding mutation checked. Monitor's actual
control handler refuses missing TPM; reporter mocked for positive Go evidence.
Public Go vector1739B SHAb8d62be6a445c9ab4598af27eaf63b000c6a85642f1a8a065d90cf9c2dfcb715.
JS stopped BEFORE tests due missing runtime import alias in isolated bundle.

R2 invocation4c1db10cc97a4fcda3ce89373162eb74 terminal1/Main0,.182951517s/601pins:
corrected alias closure only, but synthetic fixture setup stopped BEFORE tests
because namespace lacked public /etc/ssl/openssl.cnf. No runtime code change.
R3 invocation9eff9942d45e474ba02d0a552f1aa019 terminal1/Main0,.437410315s/602pins:
public reviewed OpenSSL config copied/read-only/current+frozenSHAchecked. Actual
Go/JS byte binding and exact canonical request tests PASS. Synthetic valid report
refused because fixture omitted guest SVN at offset228; owner minimum5 unchanged.
Other negative cases returned refusal but did not yet prove intended stages.

R4 invocationb1405ddeb19c47688976511ac12a5ecb terminal0/Main0/collected,
2.087757132s/602pins: ONLY four affected crypto cases and two previouslyunexecuted
monitor compiles. Fixture now writes synthetic guestSVN5 before signing. Every
negative family requires a valid baseline; signature/VTL/binding/SVN/imageidentity
checks asserted to prevent generic failure masking. Full synthetic TPM chain PASS,
19 request/key/clock/purpose substitutions and12policy variants refused, ordinary
Bind2/foreignIDKS/debug/securebootoff/capturedhost refusal. Not actual Windows TPM.
Six unique JS methods acrossR3/R4; no successful unaffected Go/interop/canonical
or old primitive trials repeated. Test fixtures do not prove production identity.

Actual native monitor8955928B SHA73ae387d67d96588d5e88c1aa8b12cad51d7b6ecba525e70dd2d2af3ed99c99b;
ordinary monitor8465759B SHA7862e5a34deaae0f315a624892cc0f63a1c294c2bdc9f3426c01e0f4bf3f559c.
Independent bytes/SHA rehash exact; binaries local/uninstalled. Historical image
7e48 unchanged and does not include this source. Runtime unchanged across four
runs; docs and corrected fixture deltas explicitly preserved. No suite/build replay.

All jobs terminal with exact invocation queue EXIT receipts. Freshauthenticated
R1available94671/R294554/R394677/R494621MiB,pending0 ACTUALLYreported,installed18432,
unread0. Retained27648+640;512hard450RSSCPU1noSwap120suite150outerstop5. R1peak271,
R4peak274MiB; no Windows prospective39388 omission/admission. Prior guardian
preservation unit actually missing/Main0, never restarted. Source/failures/public
receipts and changed frozen inputs preserved; unchanged pins verified by actual
gitcat-file against00784bac3. No private keys/journals/binaries/data in Git.

## Next production integration

Concrete bounded broker launch must take this monitor-owned credential, receive
owner-committed public configuration and authenticated bridge, create its own
protected listener, then signal acquisition. The storage owner's real TLS endpoint
must consume its own fresh challenge, verify the above evidence, independently
verify deployment authorization, prepare the exact nonce/clock-bound owner relay
and settle previous writers BEFORE writable grant. Current broker still grants
NO roots. Current control APIs are not an accepted measured release/target boot.
NBD/optical/verity/TPM/rolefilters/networkDNS/Basecoverage/actualfullstackfit,
sync/finality/readiness/event-drivenauth/persistentadoption/consumerdeployment
remain missing. No fakegrant/hostJSON/guestlocalownerjournal/manualVM substitute.
Windows5a ambiguousheld/no replay/adopt/release; original8091 untouched. No VM,
provider/export/funds/catalog/route/RPC/appRunning mutation. Full cold recovery,
newuser/storagefailure/Enclaverefusal/independent hosting remains unproven.
