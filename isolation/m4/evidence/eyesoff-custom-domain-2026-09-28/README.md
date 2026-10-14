# Eyesoff custom-domain rollout, 2026-09-28

The verified DNS/domain mapping existed, but the isolated supervisor splice and
per-app guest certificate paths accepted only the generated app hostname.

Commit 402993c47 adds exact-name routing for verified deployment aliases and
per-hostname guest CSR/certificate handling. The measured guest independently
fetches the pinned relay domain authority over authenticated TLS every 30 seconds;
a failed refresh expires authorization after five minutes. Removed names are
dropped on the next successful snapshot. Private signing keys stay in the guest.
The existing attestation and independently predicted measurement checks remain.

The control restart exposed a reservation accounting bug: resumption compared an
already-held guest's share to the pool's room for *new* guests. Eyesoff and RISC Box
were not adopted and were reaped. Four smaller guests retained their instances.
Commit 6a551dfcd credits held guests at that preliminary capacity check while
retaining the share ledger and the later record, reservation and host-floor checks.

Validation before rollout:
- Guest domain/certificate tests passed under Go's race detector; go vet passed.
- 20 Node custom SNI, certificate/measurement and retry tests passed.
- 33 scheduler guest-pool and isolation admission tests passed after the recovery fix.
- Guest release differs from the preceding startup-warmup release only in front.
- GPU worker services, runtime and model files were not changed.

Commit 787f23c29 also corrects new-claim admission: a pricing share must fit the
share ledger; the actual catalog-derived guest reservation must fit guestd's pool
and live host floor. Comparing a 35% pricing share to the pool's free fraction was
refusing RISC Box despite its much smaller actual reservation fitting. No pool
budgets or host memory floors were increased.

Production HTTPS verified at 2026-09-29 02:42 UTC (2026-09-28 Phoenix):
- Both `https://eyesoff.ai/` and the canonical app URL returned HTTP 200 under
  normal WebPKI validation.
- A fresh nonce-bound AMD SNP attestation passed for the new guest release.
- Both hostnames presented the same attested guest public key (see JSON evidence).
- The custom certificate SAN is eyesoff.ai, issued by ZeroSSL, expiring
  2026-12-28 23:59:59 UTC.
- Chrome loaded the Eyesoff chat UI through the custom domain.

Operational limitation found during the final control update: a resident Shield
model also consumes the physical VRAM advertised by the GPU probe. The control
resumption path still treats that existing GPU allocation as unavailable to its
owner. A controlled Eyesoff guest restart was necessary; the CPU reservation
fix does not solve that separate GPU adoption case. Future control upgrades
must account for an Eyesoff restart until GPU adoption is corrected. No TLS or
attestation checks were bypassed to restore service.

Final post-restart checks:
- Both Eyesoff URLs returned HTTP 200 with normal WebPKI and fresh nonce-bound
  AMD attestation, using the same replacement guest key. See the final JSON files.
- All six app guests are running. Four unaffected guest IDs and measurements are
  unchanged from before the rollout. Eyesoff and RISC Box have replacement guests.
- Both V100s hold the model again (31,279 / 31,305 MiB); Chrome loads the custom
  domain chat UI without the model-warming overlay.
- The host's RAM-backed /tmp held about 17 GiB of temporary build/test artifacts.
  895 inactive files (11,768,934,378 bytes) were copied to disk with SHA256 checks
  and replaced by original-path symlinks. Contents remain available under
  /home/steven/enclave-bench/tmp-archive-20260928; its private manifests record
  paths and hashes. Available host RAM rose to about 36 GiB. No host floor or
  guest resource ceiling was weakened.



