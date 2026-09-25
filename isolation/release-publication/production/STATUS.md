# The production release's publication artifact: inventory done, packaging HELD for the final id

**The target.** 5d's production domain release. Its id has moved as review fixes landed:
- bca562cc (aff21c73);
- 31d117a9 (d1a38994);
- 0839ac3a (ecf02384), checked below. It is installed inert on warden-host.

0839ac3a is itself about to be superseded. Codex decided that the app's stdout and stderr must not reach the host's serial
console, and that is a change to dominit.c, so template/init changes again. The rebuild, the comparison and the tarball
wait for that final id. Everything below carries over, provided `check-third-party.py` says SAME for the final id.

## Checked on 0839ac3a (ecf02384; 5d's artifact ~/enclave-bench/prod-release-ecf02384/release-ecf02384, read only)
- **`check-third-party.py`** against 0181bce3's 5c3561f9 prints SAME. Both releases verify against their ids, and the
  only files that differ are Enclave's own:
  - template/front 282cb360… -> bd066066…;
  - template/init 30b660c4… -> 2bd54d6c….

  The firmware, the kernel, the five modules, wasmtime, the rt libraries, runtime.json, the cmdline and the measure
  parameters are all byte-identical. So release-0181bce3's INVENTORY, THIRD-PARTY-NOTICES, licenses/ and SOURCES
  cover its third-party content unchanged. The check also fails a release whose manifest is self-consistent but whose
  wasmtime differs (tested).
- **template/front** has no third-party Go modules: `go version -m` lists m2 and its in-repository contract replace, and
  there is no go.sum. It embeds four public CA roots and Enclave's relay release key, listed in
  `front-embedded-data.md`, which goes into the release's notices. Their DER sha256 equal pins.go's RootFingerprints,
  and the key's id is 06212e5df9c3779a.
- **template/init** is still `gcc -static` of dominit.c against the same glibc and GCC. That is the same LGPL-2.1
  section 6 situation as 0181bce3, met the same way: the source, the link command and glibc's source.
- **The recipe since 0181bce3:** app-image-template.sh builds a LAB front only when ISOLATION_LAB_FRONT=1, and clears
  GOFLAGS. make-artifact.sh now unsets ISOLATION_LAB_FRONT and clears GOFLAGS itself, with GOTOOLCHAIN=local, so a
  publication build is always the production front.

## The production bundle (5d's facts; to be confirmed against the final id)
- **The image:** the final release. Its id is sha256(release.json).
- **The pins in the image:** the relay release key d6c8a959… (keyId 06212e5df9c3779a), RelayHost api.enclave.host,
  TicketPort 9444, EgressPort 9443 and the four roots.
- **The release-id pins outside the image, on the relay:**
  - SECRETS_RELEASE_PREDICT_RELEASES (id=dir);
  - SECRETS_RELEASE_DOMAIN_RELEASES (the admitted ids): the new id BESIDE 5c3561f9 (the rollback) and 6f14ce75
    (6757d139, kept for the relay's known-answer test). See INSTALL.md §3 in the release's evidence directory.
- **Clients:** d1's supervisor-guestcert.mjs check holds a guest to the relay's /v1/expected-guest prediction (branch
  d1/guestcert-expected, in review). There is no separate client-side list of release ids on main.
- **The rollback:** 5c3561f9 (0181bce3), which stays installed and pinned. Its publication artifact is
  release-0181bce3/.

## When the final id arrives
1. `check-third-party.py <final release dir> --expect <id> ~/enclave-prod/release-0181bce3 --reference-id 5c3561f9…`
   must print SAME. If it does not, inventory the difference first.
2. `make-artifact.sh <image commit> <outdir> --expect <5d's release dir> --firmware <fw4>/OVMF.amdsev.fd
   --firmware-versions <fw4>/versions.txt --notices release-<commit>`, run twice, for a byte-identical rebuild and the
   same tarball twice.
3. release-<commit>/ gets:
   - the notices, from `collect-notices.py … --title "domain release <commit> (release id …)" --extra-md
     production/front-embedded-data.md`;
   - SOURCES.md, which is 0181bce3's plus the new commit;
   - INVENTORY.md, a diff note against 0181bce3;
   - ARTIFACT.md.
4. Review by 63, 5d and e3 before anything is published.
