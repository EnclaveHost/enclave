# Staging the predictor on a relay host

`stage-remote.sh <BASE> <INPUTS>` stages the measurement predictor in ONE new, versioned directory
(`/opt/enclave-predict/<predictor commit>/`) and ends with its known-answer self-test. It changes nothing outside that
directory: no system package, no service, no environment file, no relay file, no restart. It refuses a BASE that exists
and stops (installing nothing) when a prerequisite is missing: git, python3 >= 3.9 with venv, node >= 20, cpio, gzip,
curl, tar.

Inside BASE: the public repository at the predictor commit, with the toolchain commit fetched; Go 1.24.7, checked
against the go.dev-published sha256; a venv holding sev-snp-measure 0.0.13 and its pinned dependencies; the two
known-answer domain releases, each verified against its id with the toolchain commit's own `release-manifest.py`; and the
known answers' components, pre-seeded (raw CIDs, re-verified against their CIDs on every read, so the self-test needs no
gateway). It prints the installed sev-snp-measure's digest, which is the value `SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256`
pins; the digest is per installation, because the entry script names its venv.

`INPUTS` holds `releases.tar` (`release-0181bce3/`, `release-6757d139/`) and `components/`.

`dry-run-container.txt`: a fresh Debian 13 container (python 3.13, node 22.20, GNU cpio 2.15, gzip 1.13) standing in for
the host, predictor 508841b3, toolchain 0181bce3: known-answer test PASS (2 reproduced exactly, 15 s); the second run
refused; 686 MB, all under BASE.

Wiring the relay to it (the SECRETS_RELEASE_PREDICT_* env, the work and components directories owned by the relay's
user) is a separate, reviewed step, and the release stays OFF until its own go.
