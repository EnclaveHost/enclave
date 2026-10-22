"""Shared, read-only helpers for make-policy.py and release-gate.py (local only; never contacts a host)."""
import hashlib, json, pathlib, subprocess, urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
W = next(p for p in HERE.parents if p.name == 'work')
# THE verifier minipc runs (live f690c29b == this file, byte-identical; g4-release-train manifest-compare + control keep[])
VERIFIER = W / 'g4-release-integration-20261021/tree/windows/node/release-channel.mjs'
VERIFIER_SHA = 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942'
NODE = 'node'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

# keys that are TEST fixtures in this workspace (windows-native-review/*.json): never a production release authority
TEST_KEY_FILES = [W / 'windows-native-review' / n for n in ('policy.json', 'channel.json', 'expired.json', 'foreign.json')]
def test_key_specs():
    out = set()
    for f in TEST_KEY_FILES:
        if f.exists():
            t = f.read_text(errors='replace')
            import re
            out |= set(re.findall(r'ecdsa-p256:[A-Za-z0-9+/=]{100,}', t))
    return out

# Provider classification of a mirror as WRITTEN (offline: no DNS lookup). Nothing here can make a mirror "independent":
# that needs root-attested operators on distinct infrastructure, and none exists today (docs/network/independent-windows.md).
DO_FRONTS = {'134.199.235.187', '146.190.246.39', '165.245.191.129', '134.209.248.172'}
def classify_mirror(url):
    h = (urllib.parse.urlsplit(url).hostname or '').lower()
    if h in DO_FRONTS or h.endswith('digitaloceanspaces.com') or h.endswith('ondigitalocean.app'): return 'DigitalOcean (single provider)'
    if h == 'enclave.host' or h.endswith('.enclave.host'): return 'enclave.host (resolves to the 4 DigitalOcean fronts today; Enclave-operated)'
    if h in ('github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com') or h.endswith('.github.io'): return 'GitHub (single provider)'
    if h in ('localhost', '127.0.0.1', '[::1]', '::1'): return 'loopback (test only)'
    return 'unclassified (root must attest operator and provider)'

def node_policy(policy_file):
    """the policy exactly as the host reads it (verifier's own check-policy) -> dict, or raise"""
    if sha(VERIFIER) != VERIFIER_SHA: raise SystemExit('verifier is not the live f690c29b')
    p = subprocess.run([NODE, str(VERIFIER), 'check-policy', str(policy_file)], capture_output=True, text=True, timeout=60)
    if p.returncode != 0: raise ValueError(p.stderr.strip() or 'check-policy failed')
    return json.loads(p.stdout)

VERIFY_JS = r'''
import fs from "node:fs";
const m = await import(process.argv[1]);
const policy = m.loadReleasePolicy(process.argv[2]);
const r = m.verifyEnvelope(fs.readFileSync(process.argv[3]), policy);
process.stdout.write(JSON.stringify({ statement: r.statement, statementSha256: r.statementSha256, signers: r.signers, threshold: policy.threshold }) + "\n");
'''
def node_verify(policy_file, envelope):
    """the host's exact acceptance rule: verifyEnvelope(bytes, loadReleasePolicy(policy)) from the live verifier"""
    if sha(VERIFIER) != VERIFIER_SHA: raise SystemExit('verifier is not the live f690c29b')
    p = subprocess.run([NODE, '--input-type=module', '-e', VERIFY_JS, VERIFIER.as_uri(), str(policy_file), str(envelope)],
                       capture_output=True, text=True, timeout=60)
    if p.returncode != 0: raise ValueError((p.stderr.strip().splitlines() or ['verify failed'])[-1])
    return json.loads(p.stdout)
