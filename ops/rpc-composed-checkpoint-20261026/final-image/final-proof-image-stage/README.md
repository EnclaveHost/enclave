# final-proof-image-stage (PREPARED; nothing built, run, booted or changed by Claude)
One verifier-only DIRECT image of final candidate 10cdf913b9b8bb168156e42da2a9a2a26c2526ad (tree 3b0f8114) over the verified production
base, reusing the existing pinned native inputs, then an independent verification + measurement. Originals in attested-image-stage/
are untouched; this stage holds copies: stub/ (ssh/scp/sftp refusal stubs, fresh invocations.log), tools/verify-image-direct.py
(ONLY the helios NATIVE pin changed cc962e2b -> 8250f08a), jobs/final-image.sh (env.sh + c0-clone + b1-direct + v1-direct adapted).
SNP boot, attestation, canary acceptance, trust-list binding and production proof serving are NOT DONE.
