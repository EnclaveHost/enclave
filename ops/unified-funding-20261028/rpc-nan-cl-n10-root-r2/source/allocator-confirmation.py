"""Bounded, invocation-bound jemalloc initializer evidence; no raw logs retained."""
ALLOCATOR_CONFIGURATION = 'confirm_conf:true,abort_conf:true,narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0,background_thread:false'
ALLOCATOR_OPTIONS = {'confirm_conf': 'true', 'abort_conf': 'true', 'narenas': '1',
                     'dirty_decay_ms': '0', 'muzzy_decay_ms': '0', 'background_thread': 'false'}
ALLOCATOR_EXPECTED_LINES = (
    '<jemalloc>: malloc_conf #1 (string specified via --with-malloc-conf): "background_thread:true,abort_conf:true,narenas:16"',
    '<jemalloc>: -- Set conf value: background_thread:true',
    '<jemalloc>: -- Set conf value: abort_conf:true',
    '<jemalloc>: -- Set conf value: narenas:16',
    '<jemalloc>: malloc_conf #2 (string pointed to by the global variable malloc_conf): ""',
    '<jemalloc>: malloc_conf #3 ("name" of the file referenced by the symbolic link named /etc/malloc.conf): ""',
    '<jemalloc>: malloc_conf #4 (value of the environment variable MALLOC_CONF): "' + ALLOCATOR_CONFIGURATION + '"',
    '<jemalloc>: -- Set conf value: confirm_conf:true',
    '<jemalloc>: -- Set conf value: abort_conf:true',
    '<jemalloc>: -- Set conf value: narenas:1',
    '<jemalloc>: -- Set conf value: dirty_decay_ms:0',
    '<jemalloc>: -- Set conf value: muzzy_decay_ms:0',
    '<jemalloc>: -- Set conf value: background_thread:false',
    '<jemalloc>: malloc_conf #5 (string pointed to by the global variable malloc_conf_2_conf_harder): ""',
)

def parse_allocator_confirmation(raw, identity, boot, unit):
    assert isinstance(raw, str) and len(raw.encode()) <= 32768, 'allocator-journal-byte-limit'
    lines = raw.splitlines()
    assert len(lines) <= 64, 'allocator-journal-row-limit'
    matched = 0; previous = -1
    for line in lines:
        row = json.loads(line)
        assert isinstance(row, dict), 'allocator-journal-record-type'
        message = row.get('MESSAGE')
        if isinstance(message, list):
            assert len(message) <= 8192 and all(type(v) is int and 0 <= v <= 255 for v in message), 'allocator-journal-byte-array'
            message = bytes(message).decode('utf-8', 'strict')
        assert isinstance(message, str) and len(message.encode()) <= 8192, 'allocator-journal-message-type'
        if not message.startswith('<jemalloc>'):
            continue
        assert row.get('_SYSTEMD_INVOCATION_ID') == identity['invocationID'], 'allocator-journal-invocation'
        assert row.get('_BOOT_ID') == boot.replace('-', ''), 'allocator-journal-boot'
        assert row.get('_SYSTEMD_UNIT') == unit, 'allocator-journal-unit'
        assert row.get('_PID') == str(identity['pid']), 'allocator-journal-pid'
        stamp = row.get('__MONOTONIC_TIMESTAMP')
        assert isinstance(stamp, str) and stamp.isascii() and stamp.isdigit(), 'allocator-journal-time'
        stamp = int(stamp)
        assert stamp >= previous, 'allocator-journal-order'
        previous = stamp
        assert matched < len(ALLOCATOR_EXPECTED_LINES), 'allocator-unexpected-extra-setting'
        assert message == ALLOCATOR_EXPECTED_LINES[matched], 'allocator-initializer-mismatch'
        matched += 1
    verified = matched == len(ALLOCATOR_EXPECTED_LINES)
    assert verified or len(lines) < 64, 'allocator-confirmation-outside-bounded-head'
    return {'verified': verified, 'initializerLinesMatched': matched, 'journalRows': len(lines),
            'rawMessagesRetained': False, 'invocationID': identity['invocationID'],
            'pid': identity['pid'], 'startTicks': identity['startTicks'], 'bootId': boot,
            'acceptedOptions': dict(ALLOCATOR_OPTIONS) if verified else {},
            'allFiveSourcesMatched': verified, 'laterOverrideEmpty': verified,
            'memoryFitProven': False}

def allocator_current_identity(info):
    identity = info['diagnosticIdentity']
    assert identity.get('bound') is True, 'allocator-client-unbound'
    current = owned_info(UNITS['cl'], 'cl', M['identities']['cl']['name'],
                         str(PAYLOAD/'chain_service.py'), identity['invocationID'])
    assert current.get('ActiveState') == 'active', 'allocator-client-not-active'
    assert int(current['MainPID']) == identity['pid'], 'allocator-client-pid-changed'
    diagnostic = sample_client_diagnostics({'cl': info})['cl']
    assert diagnostic.get('sameIncarnation') is True, 'allocator-client-incarnation-changed'
    assert diagnostic.get('executable') == 'lighthouse', 'allocator-client-not-lighthouse'
    return identity

def require_allocator_confirmation(info):
    identity = info['diagnosticIdentity']
    assert identity.get('bound') is True, 'allocator-client-unbound'
    invocation = identity['invocationID']
    assert len(invocation) == 32 and all(c in '0123456789abcdef' for c in invocation)
    until = time.monotonic() + 12
    while time.monotonic() < until:
        headroom()
        assert not STOP.exists(), 'allocator-confirmation-stop-requested'
        r = capture(['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--lines=+64',
                     '--output-fields=MESSAGE,__MONOTONIC_TIMESTAMP,_SYSTEMD_INVOCATION_ID,_BOOT_ID,_SYSTEMD_UNIT,_PID',
                     '_SYSTEMD_INVOCATION_ID='+invocation, '_BOOT_ID='+M['bootId'].replace('-', '')],
                    min(2, max(0.01, until-time.monotonic())), limit=32768)
        assert r['rc'] == 0 and not r['reason'] and not r['truncated'], 'allocator-journal-capture-failed'
        proof = parse_allocator_confirmation(r['stdout'], identity, M['bootId'], UNITS['cl'])
        if proof['verified']:
            assert allocator_current_identity(info) == identity
            proof['binarySha256'] = M['payloadFiles']['lighthouse']['sha256']
            out['allocatorConfirmation'] = proof
            return proof
        time.sleep(.2)
    raise AssertionError('allocator-initializer-confirmation-timeout')

def require_allocator_at_startup_rpc(info):
    identity = allocator_current_identity(info)
    proof = out['allocatorConfirmation']
    assert proof['verified'] and proof['invocationID'] == identity['invocationID'], 'allocator-readiness-invocation'
    assert proof['pid'] == identity['pid'] and proof['startTicks'] == identity['startTicks'], 'allocator-readiness-pid'
    assert proof['binarySha256'] == M['payloadFiles']['lighthouse']['sha256'], 'allocator-readiness-binary'
