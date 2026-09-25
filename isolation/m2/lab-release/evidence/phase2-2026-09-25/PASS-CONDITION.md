# Release lab, phase 2: the pass condition, recorded BEFORE any phase-2 guest exists

Recorded 2026-09-25T18:32:30Z (enclave-5d), from enclave-99's relay-side recording at security/attested-release 415995e7.
Committed before the phase-2 run, so the evidence cannot be read into it.

- Image-affecting tree FROZEN at isolation/app-config-m1 **5ce7ced6**: the c15f5850 image. Later commits (212365f6,
  04d01086, 65fa93cb and this one) touch only lab-release/ scripts, the lab relay and evidence.
- Lab domain release **6d18f7ad8bcad9576cbcbf670bd347d7966bd6ccd65e017b238acab6c745ad0f**, built at 5ce7ced6 with
  `ISOLATION_LAB_FRONT=1` and the phase-2 session pins; template/front sha256
  f7bec291e9c818f407a8d7960ae11a56c6ceadcdf7d22b3665618c4538a2f079; runtime ccadb38a…. It is the ONLY release the lab
  relay admits (1428c0c4 and c5375c71 are uninstalled).
- Derivation record (catalog://0x5bca36b5…47bc/0, bafybeie5q…, enclave-catalog-bundle/1, policy {cpuPercent 100,
  memMiB 128, vcpus 1}, runtimeId ccadb38a…): recordSha256 **bc1ac3be7625a1f4ca5751444da1519dd3449555d522b14f573f5e705432a3a0**,
  equal to the supervisor's own isolationDerivation + derivationDigest on this host.
- PREDICTED by the relay's REAL predictor (makePredictor over the pinned release and the catalog read on chain):
  - AppID **94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2**
  - measurement **701946112b68fabcf5fc41982eacf17bac91c8f204c0b7178af84fa301ebe550d13444be421cb7b672544d335441f709**
- Lab deployment 0x1ab5feb710ec35a291d5c84f01142e2bfa4611b88a1e3e031eb49ecf80780503 (public; envelope
  {"configCid":"bafkreilabsyntheticconfigdonotuse"}, served synthetic), endpoint https://lab-iso.enclave.test.

PASS = the guest reaches running with exactly that AppID and measurement; `expected-measurement.sh --pin 6d18f7ad`
reproduces it from the derived bundle; tools/list 200 with the released synthetic key and 401 without or wrong; no
synthetic secret value in any host-side file; production m2-gd* units unchanged.
