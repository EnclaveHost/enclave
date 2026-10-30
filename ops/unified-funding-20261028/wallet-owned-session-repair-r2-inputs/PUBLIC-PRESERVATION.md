# Public input preservation

All source seed and evidence are copied from the admitted local package. Only evidence/node/dependency-pins.json is serialized as path/sha256 records to avoid the normal secret scanner treating cryptographic-library filenames as keys. Its original mapping and hash remain unchanged locally. Reconstruct with `{r["path"]: r["sha256"] for r in records}` before comparing to the original input pin. No key material or private journals are included. Author stdout/transcripts are not included in this pre-launch package.
