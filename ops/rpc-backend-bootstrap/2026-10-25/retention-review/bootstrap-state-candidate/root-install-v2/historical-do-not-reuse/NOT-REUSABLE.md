# HISTORICAL installer: do NOT reuse as is

`install-reviewed.py` is published byte-exact as the record of what root ran at 19:24:02Z (`../install.out`). It has a
**permissions defect**. Line 22 (`ct.chmod(0o600); os.replace(ct, cfg)`) atomically replaced
`/etc/enclave-rpc/chain.json` with mode **0600**.

That mode is wrong for the service users. `chain_service.py` reads the config as `rpcl1el`, `rpcl1cl` and `rpcbase`.
The original installer (`stage_node_units.py:88`) installs it with `install -m 0644`. The config holds no secret; the
engine JWT is a separate file with its own mode.

**The repair actually performed**, before any restart and with no outage:
- `../fix-config-mode.py` asserted root:root mode 0600, then restored **0644**.
- `../config-mode-repair.out` (19:24:59Z) records the config sha `81988aee…`.
- The live `coverage-identity` gave the same binding `d01a2dcb…` for `rpcl1el`, `rpcl1cl` and `rpcbase`.

**Rule for any future config installer:** preserve the existing file's mode and owner (read them before writing the
temporary file, and apply them to it before `os.replace`), or use the original 0644 root:root. **Never 0600.** Then
verify that every service user can read the config.
