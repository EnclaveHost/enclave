# Source notice: launcher changes an activation would need (PROPOSED ONLY: not applied, not tested)

**Reviewed read-only:** `source/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py` (`713b0ddf…`) and
`stage_backend.py` (`285e9e5a…`). Neither file was edited.

## Launch sites of the Base binary

1. **`chain_service.py:511`**, `a = [binary('base'), '--chain', 'mainnet', 'rpc', …]`, then `os.execve(a[0], a, env)`
   (`:527`). The unit runs it as `rpcbase` (`stage_node_units.py:44`). `binary()` (`:38-42`) hashes
   `/opt/enclave-rpc/bin/base` against `MANIFEST['binaries']['base']`.
2. **`stage_backend.py:65`**, the snapshot unit: `ExecStart=/opt/enclave-rpc/bin/base snapshot download …`.
   - It runs only while `snapshot-complete` is absent, so only on a re-bootstrap. It is the HTTPS user.
   - It would also need the loader prefix and the OpenSSL/CA environment if the system libraries are insufficient.

## Root review: changing the Base binary requires new bindings and acceptance
There is currently no accepted coverage receipt. Replacing upstream Base with the M7-patched binary must update the
binary pin and every relevant origin/readiness binding consistently, followed by a newly generated coverage receipt.
Invalidating an older receipt is intentional; preserving an obsolete binary pin is not an activation strategy.

The separate runtime-pin file below is a proposal only. For attested authority its exact bytes and library closure must
also be bound by the measured image or its authenticated configuration. A root-owned file outside those bindings is
not sufficient against host modification. The sketch has not been approved for activation and does not implement that
binding. No binary, manifest or runtime pin has been changed by this preparation.

## Proposed `base_command()` (sketch for review; exec the loader directly from Python, no shell wrapper)

```python
RUNTIME_PIN = pathlib.Path('/etc/enclave-rpc/base-runtime.json')
LOADER = 'ld-linux-x86-64.so.2'

def base_command():
    """The pinned Base binary, through its pinned private runtime bundle when one is pinned (runtime-abi)."""
    if not RUNTIME_PIN.exists():
        return [binary('base')]                      # unchanged path; existing tests keep patching binary()
    pin = json.loads(RUNTIME_PIN.read_text())
    assert pin['binarySha256'] == MANIFEST['binaries']['base'], 'runtime pin names a different base binary'
    binary('base')                                   # keep the existing installed-binary pin check
    d = ROOT / 'runtime' / ('base-' + pin['binarySha256'][:12])
    raw = (d / 'MANIFEST.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == pin['bundleManifestSha256'], 'runtime bundle manifest pin mismatch'
    m = json.loads(raw)
    assert m['format'] == 'enclave-pinned-runtime-bundle/v1' and m['binarySha256'] == pin['binarySha256']
    files = {'bin/base': m['binarySha256'], m['loader']['file']: m['loader']['sha256'],
             **{'lib/' + n: l['sha256'] for n, l in m['libraries'].items()}}
    assert sorted(os.listdir(d / 'lib')) == sorted(f[4:] for f in files if f.startswith('lib/')), 'unpinned runtime file'
    for rel, want in files.items():
        with (d / rel).open('rb') as f:
            assert hashlib.file_digest(f, 'sha256').hexdigest() == want, f'runtime file {rel} pin mismatch'
    return [str(d / 'lib' / LOADER), '--inhibit-cache', '--library-path', str(d / 'lib'), str(d / 'bin' / 'base')]
```

**Base side:**
- `a = [*base_command(), '--chain', 'mainnet', 'rpc', …]`.
- When the bundle is used, also set `env['OPENSSL_CONF'] = str(d / 'openssl.cnf')`, and `SSL_CERT_FILE`/`SSL_CERT_DIR`
  to the Ubuntu paths. Do this only if the closure contains libcrypto.
- The existing env is already minimal and has no `LD_*`. It must stay so.

**Why there is no per-start `--list` guard here:**
- Which libraries resolve inside `lib/` is a deterministic function of the pinned binary and bundle bytes plus the
  loader's fixed default dirs.
- The exact-file-set and hash checks above fix those bytes. The resolution itself is shown once by `smoke.sh` on the
  target.
- Root may still add the `--list` check if preferred.

**Not addressed by the sketch:**
- **TOCTOU** between the hash check and exec: the existing `binary()` has the same pattern. `l1_authority.py:285`
  shows the stronger fd-based exec, which would apply to the loader only.
- **Process identity:** `/proc/PID/exe` becomes the loader.
- **Tests:** new unit tests are needed: pin absent leaves the argv unchanged; a pin mismatch, an extra file, a wrong
  library hash, and the argv prefix. **None are written or run here.**
