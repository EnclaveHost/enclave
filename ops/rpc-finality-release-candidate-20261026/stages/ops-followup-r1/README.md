# base-finality-proof-stage/r10-ops-followup: deployment follow-ups to frozen r10 (PREPARED; UNRUN; r10 NOT edited)

Report: `../../logs/claude-r10-ops-followup.md`. Each file is r10's + `patches/<path>.patch` (the job checks it):
`src/reproof.py` (bounded failed-attempt retention with receipts), `install/install_verified.py` (configs never replaced; `runtime-dirs`),
`install/MANIFEST.json` (only the reproof.py sha), and their tests. Job: `jobs/root-r10-ops-followup-tests.sh` (ops-installer 18, reproof 13).
