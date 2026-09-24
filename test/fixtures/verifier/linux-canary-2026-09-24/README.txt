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
            The node attached "via attestation" (VCEK chain verified; the VCEK rides fw_cfg because this host
            attaches no certificate table and KDS has none for the part). The relay lists it serving, mode snp.
  manager   enclave-guestd.service (user unit) from worktree ~/enclave-prod/iso-03be27d6 at f5053f62; control on
            127.0.0.1:8095 (guestd-control/1, kid 7dbd27b4352d10e1), data plane 127.0.0.1:8096 (enclave-splice/1);
            the node CVM reaches both at 10.0.2.2 over QEMU user networking.
  guest     gd9a34e856 (guestd-instance.json): its OWN SNP guest, 1 vCPU, verdict attested by guestd's judge.

WHY THIS IS THE NEW PER-APP PATH AND NOT THE OLD SHARED PROCESS PATH (each checkable from the files here)
  - The certificate the public hostname serves is the guest front's own (served-cert.pem, CN=enclave-domain). Its
    SPKI sha256 b6230cb3948781c6c7fdf1f891f028c3a2fc99d59e726ef6462fe2bec06dbe91 equals the key the attestation
    document binds (prod-doc.json transportKey) and the key guestd's verifier recorded for the instance.
  - The attestation document is the GUEST's SNP report (format sev-snp-guest-domain-v1), measurement
    df03e2f6...40f, not the node CVM's 24109645...f30.
  - report_data[32:64] = AppID 9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45, the sha256 of
    the bundle derived from the catalog version (record.json, enclave-catalog-bundle/1, policy
    enclave-isolation-policy/1 = {cpuPercent 100, memMiB 128, vcpus 1}).
  - The node advertises isolation snp-guest-per-app / fullService false and starts no in-CVM app manager; on the
    tier its supervisor proxies no plaintext (421) and holds no certificate for the app's name.

CLIENT VERIFICATION, from the public internet side (prod-client.txt): isolation/m2/client.mjs, TRUSTED mode, through
the production relay: VERDICT attested (AMD chain via vcek.der to the pinned Turin ARK, TCB checked against
min-tcb.json), key bound, second nonce attested, replay rejected, app 200 "Hello World!" on the pinned key.
  The expectations were NOT taken from the host: the component was fetched by CID from a public gateway and
  hash-checked; the bundle was derived by the independent derive_reference.py (AppID matches); the measurement was
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

FINDINGS
  F1  FIXED (39d2d138, live 12:25): /availability on the tier advertised capability flags the tier refuses
      (secrets, customDomains, config overrides, waf...). With the tier box the only serving box, the relay's
      aggregate offered them to every customer (confirmed live), and such deployments would queue forever. The tier
      now reports them false, and the live aggregate shows secrets/customDomains/configOverride/waf/devDeploy/
      shareResize false.
  F6  OPEN: a node restart REAPS the app's guest instead of adopting it. The orphan reaper runs before the claim
      loop has resumed the lease, sees an instance no record owns, and ends it; the resumed lease then launches a
      fresh guest (about a minute of downtime and a new transport key). The adoption path added in 39d2d138 never
      got to run. Fix: on the tier, no reaping before the claim loop's first pass.
  F2  The guest front's certificate is self-signed: a browser warns. Trust comes from attestation (the verifying
      client), not WebPKI. A CA certificate for the guest's own key (CSR from inside the guest) is not built.
  F3  The relay-terminated /x/<id>/ path answers 503 "state unknown" for this deployment instead of a clear refusal.
  F4  The node CVM itself boots from a measured image whose supervisor comes from a branch overlay, not a main release.
  F5  The operator key is metal0's (shared between two nodes that do not run together).

WHAT THIS DOES NOT ESTABLISH
  Anything beyond what one SNP guest per app gives: the host is still the scheduler and can deny service; the
  node CVM and guestd are not the client's trust anchor and their checks are routing hygiene; the minimum-TCB file is
  this lab's floor; one app, one node; no independent review; no multi-plane (M4b) property.
