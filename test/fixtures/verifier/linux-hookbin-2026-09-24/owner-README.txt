F10 LIVE: a real socket-server catalog app on the per-app SNP guest tier (M4a), 2026-09-24 ~21:21Z

M4a = one separate SEV-SNP guest per app. Not M4b (SVSM planes), and no multi-plane property is claimed. This is a
production canary under Steven's production-first direction. It is not a security audit, and the checks below are
not an independent review.

ENDPOINT
  https://0ddbd824.app.enclave.host  (browser-usable: ZeroSSL certificate on the guest's own key)
  app         hookbin 0.1.4, catalog app 0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3 version 4,
              cid bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee, on-chain ports "http:8000", memMb 256,
              approved, publisher fee 0, config = _media only. A wasi:cli/run COMMAND that binds 127.0.0.1:8000
              through wasi:sockets. Before F10 the tier ran wasi:http proxy components only.
  deployment  0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76, owner the agent wallet
              0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C (user-owned, rate 0: owner == the node's payout wallet), public,
              envelope {"isolation":{"require":"snp-guest-per-app"}}, create tx in deployment-tx.json
  guest       gdb677d751, transport key b071a9c9cbd72f3b2ebe1cb0663f965091aa07513021554105df349ed8299bab
  code        branch isolation/portable-runtime-jit. Guest domain release built at 0181bce3 (release id
              5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2, domain-release-0181bce3.json).
              guestd built at 0181bce3. Node image dist-iso-8ed6231f (measurement 04e953a4f856c817..., the relay
              allowlist's only entry; node-image-8ed6231f.json).

WHAT F10 ADDED (cf8b22bd, c02a2c2e, 0181bce3)
  contract     the bundle manifest may state world "wasi:cli" with "http": N (1..49999). wasi:http names no port, and
               any other world is refused.
  derivation   enclave-catalog-bundle/2 (isolation/contract/catalog/DERIVE.md): v1 plus world wasi:cli and the
               version's one http port. Every v1 vector is byte-identical.
  guest        dominit reads /app.run. For "run N": wasmtime run -S cli -S tcp -S udp -S inherit-network
               -S allow-ip-name-lookup -C cache=n, /data = a 64 MiB tmpfs (ephemeral), ENCLAVE_PORTS=http:N=N. The
               measured TLS front forwards to 127.0.0.1:N. The guest has no NIC, so its sockets reach only its own
               loopback (confirmed independently by the verifier lane).
  supervisor   derives /2 only for a version with exactly one declared port, of kind http, and only when guestd's
               /health lists /2. Anything else declared is refused at the claim gate.

EXPECTATIONS, NOT TAKEN FROM THE HOST
  component    fetched by CID from https://trustless-gateway.link. Its sha256 6e105176... equals the CID's multihash.
  AppID        d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24 from derive_reference.py (record.json,
               recordSha256 1fb9360d...). The supervisor sent the same record digest. The verifier lane derived the
               same AppID from a copy fetched from ipfs.enclave.host.
  measurement  be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d from
               expected-measurement.sh --pin 5c3561f9... (expected-measurement.txt). It equals the lab prediction made
               from the dev tree. The verifier lane records this measurement as OUR word until the release bytes
               reproduce on their side.

RESULTS (all from the public internet side, through the production relay)
  client-public.txt    client.mjs TRUSTED mode, --runtime pinned, --vcek, the min-tcb floor, --host-data this
                       deployment: VERDICT attested. The measurement is be6b8644..., report_data names the AppID,
                       HOST_DATA = the deployment, the TCB meets the floor, and the app answered on the pinned key.
  roundtrip-public.txt curl with SYSTEM trust (no -k). POST /api/bins -> 200, POST /b/<bin> with a nonce body -> 200,
                       and GET /api/bins/<bin>/requests returns that body (base64 of {"event":"f10-canary",
                       "nonce":"b1223d9a06e5120a"}). The webhook was captured inside the guest and read back through the
                       guest's TLS.
  cross-*.txt          CROSS-APP. A second approved app with a DISTINCT AppID now exists on the tier, so this runs for
                       the first time. Every mismatch is refused before any app request (app_requests_sent=0):
                         hookbin expectations at A's hostname             -> reject (measurement)
                         A's expectations at hookbin's hostname           -> reject (measurement)
                         hookbin expectations, E's deployment id          -> reject (host_data)
                         hookbin measurement with A's AppID               -> reject (report_data[32:64])
                         the correct expectations                         -> attested
                       The verifier lane adds one more: the same record read as v1 (no http) derives another AppID,
                       which the report refuses, so /2 carries weight in the identity.
  route-plain.txt      https://api.enclave.host/x/<id>/ and /x/<id>/tcp/8000 -> 421 (served only over TLS that ends in
                       its guest). There is no plaintext or host-terminated path.
  certificate          ZeroSSL, serial 3636639ABF417F4B384A95A6468D5D3F, until 2026-12-23. It was issued only after
                       the guest judged "attested" with the node's TCB floor in force (node-log.txt 14:23:34 local).

RESTARTS (node-log.txt, guestd-log.txt; local time = UTC-7)
  21:17:59Z  guestd -> 0181bce3 build: "adopted 2 guest(s) ... each verified again as the same guest" (A, E).
  21:18:21Z  node -> dist-iso-c02a2c2e (TCB floor file measured into the image): accepted 21:18:35Z, A and E adopted
             21:19:36-37Z, both 200 again by 21:19:42Z (at most about 85 s unreachable, counted from the relay swap).
  21:32:32Z  node -> dist-iso-8ed6231f (the certificate-reuse fix below): A, E and hookbin adopted, and all three
             logged "already serves a valid certificate". Serials were unchanged and nothing was issued.

FINDINGS FROM THIS ROUND
  F12 FIXED (8ed6231f, verified live 21:34:44Z): each node restart RE-ISSUED every tier app's CA certificate.
      The supervisor's certificate loop kept no memory across restarts. The 21:18 restart issued new certificates for A
      (serial 6FBAAA4A... -> 9ACD5518...) and E (3A77DB7E... -> 2C36B3A9...) although both guests still served valid
      ones. The F3 node restart (20:53Z) almost certainly did the same; F6's (12:43Z) predates F2, when no guest held a
      CA certificate. A day-granular validity window hid it from
      both the verifier lane and this README. Every restart spent one issuance per app from the shared enclave.host
      quota. Fix: before judging and issuing, the relay handshakes with the guest under the name. A chain that
      verifies against the WebPKI roots, for the name, on the route's verified key and before 2/3 of its life, is
      kept. The handshake proves possession of the key, so a host cannot present such a leaf for a key it does not
      hold. Chain test step 2c (a second supervisor) passes, and fails with reuse turned off (CSRs 3 -> 4).
  F13 OPEN: the app sees "x-forwarded-for: 2" (roundtrip-public.txt). The guest front's reverse proxy appends its
      vsock peer, which is the host's CID 2, not a client address. No client address reaches the guest at all on this
      path. A misleading header is worse than none: the fix is for the front to drop X-Forwarded-For. That changes
      the front, and so every new guest's measurement, so it will ship with the next domain release.
  F14 OBSERVED: 2 of the day's 7 node boots logged one "attest REJECTED: ... attach must carry operatorSig", then
      ACCEPTED 3 s later, both on images that carry F3's hello re-send (13:51Z and 21:32Z). It is transient, and the
      cause has not been established.

WHAT THE TIER STILL DOES NOT SUPPORT (refused by name at the claim gate or the spawn, never approximated)
  tcp/udp/tls ports; a second http port; app config other than _media; config overrides; secrets; model volumes; GPU;
  private deployments (the owner gate needs plaintext the host never sees); waf rules; custom domains; outbound
  network (the guest has no NIC); persistent storage (/data is 64 MiB of tmpfs, lost when the guest stops); app
  logs beyond the serial console; wasm64 / memory64 and WASIp3 components are unverified on the tier.

OPEN, UNCHANGED BY THIS ROUND
  The measurement the certificate relay holds a guest to is still guestd's word (no independently pinned expected
  measurement at issuance). The TCB floor now applies (ISOLATION_MIN_TCB from the node image). F11: the copied-label
  and owner/instance authorisation cases remain open by design. F4/F5 unchanged. F8 was not seen in the few probes run
  this round, which is not a measurement of it.
