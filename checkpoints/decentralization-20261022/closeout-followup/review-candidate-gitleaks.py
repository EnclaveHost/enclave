"""Verify every scanner finding before using the documented false-positive override."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
repo = root / 'work/source-checkpoint-20261022/main-repo'
tree = base / 'measured-composition/tree-c'
commit = '6f2c7da466dc26e5f7aac88c574a6b807e1a03df'
findings = json.loads((base / 'source-preservation/candidate-gitleaks-retry.json').read_text())
assert len(findings) == 38
generic = {
    ('scripts/network/verify-profile.mjs', 54): 'Public Solidity contract-name mapping',
    ('test/authority-profile.test.mjs', 53): 'Public Solidity contract-name mapping in test fixture',
    ('test/service-index.test.mjs', 90): 'Literal recordKey=0xabc test fixture, not a valid private key',
    ('metal/guest/mcp-server.bundle.mjs', 107599): 'JavaScript object spread and property references; no credential literal',
    ('metal/guest/mcp-server.bundle.mjs', 147566): 'Public TLS domain-separation string',
    ('metal/guest/platform-api.bundle.mjs', 111527): 'ASN.1 JavaScript class declaration',
    ('metal/guest/platform-api.bundle.mjs', 112368): 'ASN.1 JavaScript class export',
    ('metal/guest/platform-api.bundle.mjs', 112763): 'ASN.1 JavaScript class export',
    ('metal/guest/platform-api.bundle.mjs', 114537): 'ASN.1 JavaScript class export',
    ('metal/guest/platform-api.bundle.mjs', 114538): 'ASN.1 JavaScript decorator expression',
    ('metal/guest/platform-api.bundle.mjs', 131564): 'Runtime eligibility predicate containing property references; no credential literal',
    ('metal/guest/platform-api.bundle.mjs', 132239): 'Public TLS domain-separation string',
}
verified = []
cache = {}
for finding in findings:
    path, number = finding['File'], finding['StartLine']
    if path not in cache:
        cache[path] = subprocess.check_output(['git', 'show', commit + ':' + path], cwd=repo).decode().splitlines()
    line = cache[path][number - 1]
    if finding['RuleID'] == 'generic-api-key':
        reason = generic[(path, number)]
    elif path.endswith('.bundle.mjs'):
        digest = re.search(r'0x([0-9a-f]{64})', line).group(1)
        assert 'BOOK_KEY_REGISTRY' in line and bytes.fromhex(digest).rstrip(b'\0') == b'registry'
        reason = 'Public bytes32 address-book registry key'
    else:
        match = re.search(r'"([^"]+)":\s*"([0-9a-f]{64})"', line)
        assert match, (path, number)
        source, digest = match.groups()
        assert hashlib.sha256((tree / source).read_bytes()).hexdigest() == digest
        reason = 'Independently recomputed SHA256 of public source: ' + source
    verified.append({'rule': finding['RuleID'], 'file': path, 'line': number,
                     'lineSha256': hashlib.sha256(line.encode()).hexdigest(), 'classification': reason})
result = {'commit': commit, 'findings': len(verified), 'allVerifiedFalsePositives': True,
          'override': 'Repository-documented --no-verify for confirmed false positives only; no global rule changes',
          'verified': verified}
(base / 'source-preservation/CANDIDATE-GITLEAKS-REVIEW.json').write_text(json.dumps(result, indent=2) + '\n')
print('Verified all', len(verified), 'gitleaks findings')
