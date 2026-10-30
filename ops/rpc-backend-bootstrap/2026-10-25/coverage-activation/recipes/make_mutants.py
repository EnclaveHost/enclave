#!/usr/bin/python3 -I
"""Regenerate the 12 executed mutants of chain_service.py (sha a60ae322…): make_mutants.py CHAIN_SERVICE OUT_DIR.
Each must be KILLED by test_coverage_activation.py (CHAIN_SERVICE=<mutant> python3 -I test_coverage_activation.py)."""
import os
import sys

M = {
    'm1-boolean-only': ("""        origin = coverage_activation(CONFIG, ROOT / 'manifest.json', (MANIFEST.get('binaries') or {}).get('base'))""",
                        """        assert CONFIG.get('baseBootstrap', {}).get('coverageVerified') is True, 'Base snapshot blob coverage not approved'
        origin = {'l1Block': 19996400, 'blobSlot': 12000000, 'toBlock': 20000100, 'safeL1Origin': {'number': 20000000, 'hash': '0x' + '44' * 32}}"""),
    'm2-no-pin-binding': ("""    assert (r_sha, v_sha, o_sha, s_sha) == (acc['receiptSha256'], acc['verdictSha256'], acc['originSha256'],""",
                          """    assert True or (r_sha, v_sha, o_sha, s_sha) == (acc['receiptSha256'], acc['verdictSha256'], acc['originSha256'],"""),
    'm3-no-canonical': ("""        assert canon and str(canon.get('hash', '')).lower() == so['hash'], 'snapshot safe L1 origin not canonical on this L1'""", """        pass"""),
    'm4-no-config-identity': ("""    assert rc['chainConfigSha256'] == config_identity(cfg), 'coverage receipt reviewed a different chain config'""", """    pass"""),
    'm5-no-verdict-counts': ("""        and counts['blobsVerified'] >= 1 and counts.get('blocks') == to - need + 1, 'coverage verdict incomplete'""",
                             """        or True, 'coverage verdict incomplete'"""),
    'm6-no-file-perms': ("""        assert stat.S_ISREG(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022 and st.st_size <= MAX_EVIDENCE, \\""",
                         """        assert stat.S_ISREG(st.st_mode), \\"""),
    'm7-no-snapshot-binding': ("""    assert rc['snapshotManifestSha256'] == s_sha, 'coverage receipt does not bind this snapshot manifest'""", """    pass"""),
    'm9-no-tip-block-binding': ("""    assert _int(tip.get('number')) and tip['number'] == snapshot['block'], \\""", """    assert True or tip['number'] == snapshot['block'], \\"""),
    'm10-no-archive-path-check': ("""        assert _safe_rel(p) and ('/' not in p or p.split('/', 1)[0] in allowed_top), \\""", """        assert True, \\"""),
    'm11-no-base-location-check': ("""            and (bpath == pinned_dir or pinned_dir.startswith(bpath + '/')), \\""", """            or True, \\"""),
    'm12-no-output-path-check': ("""            assert isinstance(o, dict) and _safe_rel(o.get('path')) and _int(o.get('size')) and o['size'] >= 0 \\""",
                                 """            assert isinstance(o, dict) and _int(o.get('size')) and o['size'] >= 0 \\"""),
}
# m8 removes BOTH bootstrap-substitution layers (removing only the hash-inequality layer is an equivalent mutant).
M8 = (("""    assert s_sha != b_sha, 'snapshot manifest evidence is the bootstrap/install manifest, not the downloaded snapshot manifest'""", "    pass"),
      ("""    assert not ({'format', 'snapshotManifests', 'binaries', 'mounts'} & set(doc)) and doc != bootstrap, \\""", "    assert True, \\"))

src, out = open(sys.argv[1]).read(), sys.argv[2]
os.makedirs(out, exist_ok=True)
for name, (old, new) in M.items():
    assert src.count(old) == 1, name
    open(os.path.join(out, name + '.py'), 'w').write(src.replace(old, new))
m8 = src
for old, new in M8:
    assert m8.count(old) == 1, 'm8'
    m8 = m8.replace(old, new)
open(os.path.join(out, 'm8-bootstrap-as-snapshot.py'), 'w').write(m8)
print(len(M) + 1, 'mutants')
