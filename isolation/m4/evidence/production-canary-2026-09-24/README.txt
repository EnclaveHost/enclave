Per-app isolation tier (M4a: one separate SEV-SNP guest per app) - FIRST PRODUCTION APP, 2026-09-24

Production-first at Steven's direction ("get it live in production, then follow up with testing to prove security
and patch any issues"). This file records what was deployed and what was checked. It is NOT a security proof and
NOT an independent review. This is M4a (separate SNP guests), not the SVSM-plane M4b work, which stays lab-only.

ENDPOINT
  https://4e62e60d.app.enclave.host/        hello-world:1.0.4 (catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4)
  deployment 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e on ledger 0xF9e71385C5cB49844F2457ba6567De0742f8B89a
  owner 0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C (the agent wallet; a real user wallet, not a fixture)
  created tx 0x6ceaeb0b31687149949014e9eb13f108886421c738e3aa62c1ff603750be4c10, public, cpuMilli 100, envelope
  {"isolation":{"require":"snp-guest-per-app"}}. Rate 0: the owner declared itself the node's payout wallet
  (setPayoutWallet tx 0x7ac65fa2a91cd062ecf6c404f867087ca226e2d201c503bb0d5beae83350fd0d), so the ledger waives the
  host charge (rev 12 self-hosting). No USDC moved; gas only (deployment-txs.json).

WHAT SERVES IT
  node      metal-iso0 on warden-host: a node CVM that runs the control plane only (no app, no wasm-manager).
            Registered EnclaveRegistry id 0xf7a1256d22644d59d88fd523a42820586335fb3bcf01f7ed132e9448a298c745
            (operator 0xC9D0835C..., metal0's key reused; a second endpoint of the same operator).
            Image metal/dist-iso-f5053f62 (node-image-manifest.json): supervisor ghcr digest-pinned + overlay of
            supervisor.js and the three guestd client modules from commit f5053f62 (clean tree), wasm-manager pinned,
            reproducible:true. Verifying AmdSev firmware (sha256 142589cc...). Measured cmdline carries
            metal.isolation=snp-guest-per-app. Live measurement = the build's prediction:
            2410964515fa82dac869ad2f3a6e06d245a0876858ad4fe165ae8a5c31a88a012bcf40e37626a1a768d77f0486ca8f30
  relay     production api-relay (nan): METAL_ALLOWED_MEASUREMENTS = that one measurement (env backed up first).
            The node attached "via attestation" (VCEK chain verified). The VCEK rides fw_cfg because this host
            attaches no certificate table to reports. CORRECTION (enclave-99): AMD KDS DOES serve this chip's VCEK
            (kdsintf.amd.com/vcek/v1/Turin/fa11afcf54ae9c53?fmcSPL=01&blSPL=03&teeSPL=02&snpSPL=05&ucodeSPL=117), and
            it verifies the live reports; an old note that it did not was repeated here. The relay lists the node
            serving, mode snp.
  manager   enclave-guestd.service (user unit) from worktree ~/enclave-prod/iso-03be27d6 at f5053f62; control on
            127.0.0.1:8095 (guestd-control/1, kid 7dbd27b4352d10e1), data plane 127.0.0.1:8096 (enclave-splice/1);
            the node CVM reaches both at 10.0.2.2 over QEMU user networking.
  guest     gd9a34e856 (guestd-instance.json): its OWN SNP guest, 1 vCPU, verdict attested by guestd's judge.

WHY THIS IS THE NEW PER-APP PATH AND NOT THE OLD SHARED PROCESS PATH (each checkable from the files here)
  - The certificate the public hostname serves is the guest front's own (served-cert.pem, CN=enclave-domain). Its
    SPKI sha256 b6230cb3948781c6c7fdf1f891f028c3a2fc99d59e726ef6462fe2bec06dbe91 equals the key the attestation
    document binds (prod-doc.json transportKey) and the key guestd's verifier recorded for the instance.
  - The attestation document is the GUEST's SNP report (format sev-snp-guest-domain-v1), measurement
    df03e2f66cbb0b70f9cf0c474a2e334727b3b276ac496cb93f8937497b7c973790699f02e207e0e2f73f0146add8840f (the full
    expected-measurement.sh output, with the release id, is expected-measurement.txt), not the node CVM's.
  - report_data[32:64] = AppID 9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45, the sha256 of
    the bundle derived from the catalog version (record.json, enclave-catalog-bundle/1, policy
    enclave-isolation-policy/1 = {cpuPercent 100, memMiB 128, vcpus 1}).
  - The node advertises isolation snp-guest-per-app / fullService false and starts no in-CVM app manager; on the
    tier its supervisor proxies no plaintext (421) and holds no certificate for the app's name.

CLIENT VERIFICATION, from the public internet side (prod-client.txt): isolation/m2/client.mjs, TRUSTED mode, through
the production relay: VERDICT attested (AMD chain via vcek.der to the pinned Turin ARK, TCB checked against
min-tcb.json), key bound, second nonce attested, replay rejected, app 200 "Hello World!" on the pinned key.
  The expectations were NOT taken from the host: the component was fetched by CID from the public trustless
  gateway https://trustless-gateway.link/ipfs/<cid>?format=raw (Accept: application/vnd.ipld.raw; it refuses Python's
  default user agent) and hash-checked against the CID; the bundle was derived by the independent derive_reference.py (AppID matches); the measurement was
  recomputed by expected-measurement.sh --pin from the domain release built at c423f9b9 (domain-release.json,
  release id ec0f713cebf03d601c6fab3a21394b6cf1447818a919b28bd47c527613689c6e).

PRODUCTION NEGATIVES RUN (no transactions)
  - plaintext https://api.enclave.host/t/metal-iso0/x/<id>/ and /hello: 421, TLS-only message
  - relay-terminated https://api.enclave.host/x/<id>/: 503 not_running (serves nothing; a routing oddity, see below)
  - wss .../t/metal-iso0/x/<id>/https: right SNI -> the guest's key; another app's SNI -> refused (wrong-name);
    no SNI -> refused (no-sni); plaintext -> closed after 341 ms, 0 bytes (not-tls). The node logged each refusal.
  - client with a wrong measurement / wrong app / wrong runtime version / malformed TCB floor: exit 3, gate closed,
    0 application requests.

THE CAPTURE vs THE LIVE ENDPOINT. prod-doc.json, served-cert.pem and prod-client.txt are from guest gd9a34e856
(transport key b6230cb3...). served-cert.pem is PUBLIC and was force-added past the repo's *.pem ignore rule, which
exists for private keys. At 12:24:58 a node restart (deploying the F1 fix) REAPED that guest before the claim
loop resumed its lease, and the lease relaunched it as gda9c2b39a (key 08c88f1e...), which verifies attested
the same way. So the live endpoint now presents a different key than this capture: expected, see F6.

SECOND ROUND (12:36-12:46 local, 2026-09-24), all on production, transactions in test-deployment-txs.json
  lifecycle  A's rate-0 lease RENEWED on schedule (12:36:00, to 20:05:59Z); proof-of-time checkpoints landed every
             5 min (steady).
  admission  C = a PRIVATE tier deployment: refused by the node ("the deployment is private, and its owner gate needs
             the request's plaintext, which exists only inside the guest on this backend").
             D = a public deployment WITHOUT the isolation envelope: refused ("this runner serves only deployments
             that require per-app isolation").
  cross-deployment  B = a second public tier deployment of the same app (0x9ee69e3d...): its OWN guest gd3305b8e4,
             the same AppID and measurement by design, a different transport key (6c27f29a... vs A's 08c88f1e...).
             A's SNI on B's route and B's SNI on A's route: both refused (wrong-name) before any guest.
             There is NO second approved wasi:http app in the catalog, so a cross-APP (distinct AppID) test in
             production was not possible: every small catalog app (hookbin, ballot, pixelboard, ...) declares
             http:8000 and is a wasi:cli SOCKET server, which the tier's wasi:http guest cannot run (tested on the
             host: hookbin's guest exits "no exported instance named wasi:http/incoming-handler@0.2.12"); the claim
             gate refuses them (ports declared), correctly.
  restart    F6 fix deployed (node image e498c404, 12:43:09): BOTH guests were ADOPTED, not reaped; the public keys
             were unchanged afterwards (A 08c88f1e..., B 6c27f29a...).
  stop       B stopped by its owner on chain (setActive false, 12:45:4x): node "stopped by owner on-chain ->
             teardown + release" at 12:46:22, guestd instance gone at 12:46:25, B's hostname fails closed at TLS,
             A unaffected (200). C and D retired the same way.

FINDINGS
  F1  FIXED (39d2d138, live 12:25): /availability on the tier advertised capability flags the tier refuses
      (secrets, customDomains, config overrides, waf...). With the tier box the only serving box, the relay's
      aggregate offered them to every customer (confirmed live), and such deployments would queue forever. The tier
      now reports them false, and the live aggregate shows secrets/customDomains/configOverride/waf/devDeploy/
      shareResize false.
  F6  FIXED (e498c404, verified live 12:44): a node restart REAPED the app's guest instead of adopting it. The orphan reaper runs before the claim
      loop has resumed the lease, sees an instance no record owns, and ends it; the resumed lease then launches a
      fresh guest (about a minute of downtime and a new transport key). The adoption path added in 39d2d138 never
      got to run. Fix: on the tier, no reaping before the claim loop's first pass.
  F7  FIXED, verified live 20:46:03Z (cfd9e198 + 48ef955b): a guestd restart ADOPTS every guest that verifies again
      as itself (recorded key, measurement, AppID, HOST_DATA) and ends only the rest; SIGTERM no longer ends guests.
      The FIRST F7 deploy (20:43:45Z) FAILED to adopt: the restart ran the OLD binary's SIGTERM handler, which ended
      both guests; the supervisor relaunched them (new keys; the relay reissued certificates for them at 20:45:29Z).
      The fixed binary was then brought in with SIGKILL (so no old handler ran): "adopted 2 guest(s)", public keys and
      ZeroSSL certificates unchanged by validity window, serials not compared (A 295ce2e0..., E d590dd84...); a guestd
      restart leaves the node's certificate memory intact, so no reissue is expected. Nothing respawned. Rollback now ends guests
      explicitly (systemctl --user stop 'm2-gd*').
  F8  OPEN: the public edge (us-west) failed TLS (EOF) for one or both hostnames for 1-2 minutes after a change: A
      failed 6/6 at ~12:40 after B was claimed (cause not established; us-west is not reachable from this host), and
      both failed for ~2 min after the 12:43 restart (explained: the node restores its records only when its claim
      loop resumes the leases, ~70 s after boot). 0/28 failures in the 3 steady minutes measured.
  F9  FIXED (cfd9e198): a failed start keeps its error, serial tail and build/launch/verify logs under
      <root>/failed/<id>/ (bounded), and GET /vms/<id>/logs serves a running or failed guest's console in the
      supervisor's (owner-gated) logs shape; live on A it shows the HOST_DATA-derived name and the certificate install.
  F10 FIXED, live 21:21Z (cf8b22bd..0181bce3): socket-server catalog apps (wasi:cli with one http:N port) run on the
      tier through enclave-catalog-bundle/2. The first is hookbin 0.1.4 at https://0ddbd824.app.enclave.host: attested,
      browser-usable, webhook round-trip through the guest's TLS, and the first cross-APP refusals. See
      f10-hookbin/README.txt, which also carries F12 (fixed: node restarts re-issued every certificate), F13 (open:
      x-forwarded-for is the host's vsock CID) and F14 (a transient operatorSig rejection at attach).
  F11 OPEN (raised with the enclave-99 verifier lane): the attestation evidence names the app (AppID), the image
      (measurement), the runtime and the TLS key, but NOT the deployment. Two live instances of one version, such
      as A (4e62e60d) and E (395bed3e, created 19:52Z for the verifier's test; guest gd6ee1b5cd, key 26db975c...),
      are indistinguishable by their evidence. So a relay that misroutes one to the other is detectable only by a
      client that pinned a key earlier (trust on first use), not by verification. The host-side SNI check and
      guestd's per-instance admission are routing hygiene, not client evidence. Closing this needs an
      instance/deployment binding a client can check (the pVM tier is building one: INSTANCE-BINDING.md); it
      must not come from an unauthenticated host input.
      CONFIRMED from the public side by enclave-99 at 19:53Z: A and E, verified under A's expectations, are identical
      in every claim the verdict carries (product, report version, VMPL, measurement, AppID, chip fa11afcf54ae9c53,
      TCB, policy, firmware, runtime binding, ARK/VCEK); only the served key, the report id (A ad130511ef9a8b49...,
      E bb731bfeac83d5b1...) and the nonce/key-derived report_data differ.
      PROPOSED FIX: launch each guest with SNP HOST_DATA = its 32-byte deployment id (QEMU sev-snp-guest host-data=).
      HOST_DATA is signed into every report and fixed at launch, but not in the launch measurement, so the expected
      measurement stays one per version; the judge gains an expected-deployment check (report.host_data == the
      deployment id the client is visiting, which it knows from the hostname / chain). A host could still start a
      second genuine instance labelled A, but it could no longer answer A's users from E's guest undetected. Any
      per-deployment secret release must then bind to HOST_DATA as well.
      BUILT AND LIVE (bc07f899, 20:06Z): see host-data/README.txt. The A/E misroute is now refused from the public
      side; the copied-label case and owner/instance authorisation remain OPEN by design (F11 is narrowed, not
      closed).
  F2  FIXED, live ~20:37Z (6757d139): see webpki/README.txt. Previously: the guest front's certificate was self-signed: a browser warned. Trust comes from attestation (the verifying
      client), not WebPKI. A CA certificate for the guest's own key (CSR from inside the guest) is not built.
  F3  FIXED, live 20:53Z (99b0e3c0, node measurement bc7d0c27...): the relay-terminated /x/<id>/ path answered 503
      "state unknown" - from nucbox-k11, not metal-iso0. Cause: on the ATTESTED attach path the agent's only hello (which
      carries publicUrl = the registry id) arrived before the hub bound the tunnel, so metal-iso0's row stayed synthetic
      ("tunnel:metal-iso0"), the relay's ledger rule could not match the lease holder, and its fan-out took nucbox, which
      answered 204 to /x/<id> for ids it does not run (reported; fixed by the Windows owner at 78b3eb9f, pushed but NOT
      deployed and NOT scheduled: deploying it needs a nucbox restart, a decision nobody has taken - CORRECTED
      2026-09-24, an earlier note here said it would ride a planned reboot window, which does not exist; a nucbox
      restart interrupts its full app set for about 15 minutes, the RISC Box's 21.8 GiB snapshot restore dominating). Now the row carries 0xf7a1256d... and https://api.enclave.host/x/<id>/ answers metal-iso0's
      421 "This deployment is served only over TLS that ends in its own guest: https://<label>.app.enclave.host/".
      Node restart adopted both guests (keys unchanged; CORRECTED 21:35Z: the certificates were very likely RE-ISSUED,
      as the 21:18Z restart's measurably were; only the validity window was compared then. F12, fixed at 8ed6231f).
      Independently re-verified by the Windows
      owner (enclave-d1). RESIDUAL on nucbox's side until its fix deploys: deployments with NO live runner still reach
      the fan-out, and two real ones (0x9eb4e600..., 0x2b84a098..., model-volume apps nucbox refused by name) get a
      503 from nucbox instead of a 404 - live and user-visible, correctness and clarity, not exposure (nucbox serves
      and terminates nothing for them).
      Related, from the same owner: the Windows manager now speaks guestd-control/1 server-side, tested against this
      branch's unmodified control-client.mjs over a real socket (handshake, signed request, body round-trip, wrong-key
      refusal, no-key fail-closed, single-use nonces, replay window, cross-instance rejection, response MAC). A wire
      format change here breaks those tests by design.
  F4  The node CVM itself boots from a measured image whose supervisor comes from a branch overlay, not a main release.
  F5  The operator key is metal0's (shared between two nodes that do not run together).

LIVE CHECK BY THE VERIFIER LANE (enclave-99, research/independent-verifier), 2026-09-24T19:33Z, read-only from the
public side: VERIFIED - served SPKI 08c88f1e... equals transportKey, VCEK -> SEV-Turin -> ARK-Turin (pinned), CRL
fresh, TCB fmc 1 bl 3 tee 2 snp 5 ucode 117, report_data[0:32] = Bind2 over the served key, its own nonce and
RuntimeID ccadb38a..., [32:64] = the AppID. Their measurement check is continuity with this capture (the domain
release is not published), which they report as such. A second implementation agreeing; not an independent review.

WHAT THIS DOES NOT ESTABLISH
  Anything beyond what one SNP guest per app gives: the host is still the scheduler and can deny service; the
  node CVM and guestd are not the client's trust anchor and their checks are routing hygiene; the minimum-TCB file is
  this lab's floor; one app, one node; no independent review; no multi-plane (M4b) property.
