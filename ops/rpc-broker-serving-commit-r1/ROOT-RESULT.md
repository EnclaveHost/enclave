# Broker original-owner and guardian transaction

Production RPC remains OFFLINE. This source completes a component transaction; exporter and outer host adoption remain unfinished. No production activation occurred.

The actual RunOwnerContinuations loop now immediately requests serving through the original owner stream after both guardian preparations. It requires the same live prepared response and private observation, original export reservation, current authority and current permit chain. It consumes a durable transport intent before one request, verifies both original signatures and the EXACT requested permit, persists the exact owner response, obtains both original guardian COMMIT acknowledgements, and persists a guardian receipt before publishing a private component result. Later off-chain renewals reuse the same stream/preparation/observation and ordered chain, followed by both guardian RENEW acknowledgements. Owner and guardian sequences are distinct.

Accepted monotonic expiry is conservatively translated to the same-kernel guardian clock. Prior authorization, initial four-second observation age, three-second transaction deadline and original broker deadline are rechecked throughout. Partial/late/invalid/ambiguous results close the whole broker session, both guardian channels and original owner/export raw transports, retaining intents/proofs without retry. This does not prove remote death, writer fencing or reservation release.

## Actual qualification

Invocation 023184d4d52e4c3492a449096235c918 completed status 0/MainPID 0/empty cgroup. The actual TLS integration test has 21 passing subcases (22 PASS records including parent), no failures. Whole composition 10.332905335118994 seconds, including an actual broker build. All 833 frozen/current pins match after execution and at preservation preparation.

Nine new cases exercise commit, same-stream renewal, original broker deadline after component commit, second guardian loss, receipt conflict after guardian acknowledgement, invalid owner signature, VALID signed response with a different requested permit, lost reply and late reply. Twelve existing actual-loop cases cover startup/preparation, tamper/staleness, protocol downgrade, unsolicited/partial data, idle loss, monitor loss and original expiry.

Actual TLS 1.3, original Go owner producer, dual Ed25519 verification, private persistent fixture journals, monitor identity references, original private front pipe and actual seqpacket GuardClients are used. Guardian receivers are bounded responders here; native receiver/process death evidence remains separate. Chain authority and exporter binding are fixtures. No hardware attestation, live exporter, target Windows, full-stack readiness or finality is inferred. No C/native primitive was rerun.

Retained envelope: 512 MiB hard, 450 MiB RSS, one CPU, no swap, 150-second outer, 120-second composition, 5-second stop. Authenticated admission: available 93613 MiB, actual pending 0, installed floor 18432; retained 27648 plus 640 MiB. Inner peak 193 MiB, outer tree peak 262 MiB, minimum host available 93490 MiB. No cap/floor/deadline relaxation or reused 1.5 GiB compiler exception.

Private broker binary independently rehashed: 11495511 bytes, SHA256 47a9cdbfb5fe63c92a02685553e8e819ac45d33ffb7ed355a5e7c225346a657c. It is not deployed or in Git. No keys, private journals, media or cache are included.

## Remaining actual callsites

BrokerSession.alive still enforces originalD. ConnectExportControl still enforces its original read cutoff; AppControl.step still rejects any bytes after binding and expires at originalD. guarded_export.guard and export_owner therefore still require an authenticated serving-transfer protocol that preserves the same original writer/export and independent expiry/resource/owner-loss controls. The outer operator/systemd/TLS and Windows guardians also require coordinated transfer. Do not boot this partial composition, disable those cutoffs, reset a clock, replay an ambiguous attempt or mix old firmware with these descriptor/protocol contracts.

Target admission, accepted platform, original production journal/chain and all prior writer settlement, real NBD/verity/20 GiB fit/sync/finality and consumer cutover remain unproven. Original 8091, catalog, funds, ambiguous Windows attempt and private records remain unchanged.
