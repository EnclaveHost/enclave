def fresh_nan_policy():
    global last_pending_check
    now = time.time()
    a = M['admission']
    assert a['authorized'] is True and a['nonce'] == M['nonce']
    assert a['scope'] == 'nan-cl-only-4096' and a['observedPendingMiB'] >= 0
    assert a['osReserveMiB'] == 2048 and a['creatorClassification'] == 'two-launches-before-wait-no-repeated-allocator'
    assert a['at'] <= now <= a['expiresAt'] and a['expiresAt'] - a['at'] <= 600, 'stale-Nan-admission'
    assert read('/proc/sys/kernel/random/boot_id') == M['bootId'], 'Nan-boot-changed'
    if now - last_pending_check < 5:
        return
    last_pending_check = now
    creator = P('/proc/1281392')
    assert (creator / 'stat').read_text().rsplit(')', 1)[1].split()[19] == '867080689', 'creator-replaced'
    assert str((creator / 'exe').resolve(strict=True)) == '/usr/bin/bash'
    assert hashlib.sha256((creator / 'cmdline').read_bytes()).hexdigest() == a['creatorCmdlineSha256'], 'creator-command-changed'
    assert str((creator / 'cwd').resolve(strict=True)) == '/root/padspill-20261005', 'creator-directory-changed'
    count = 0
    until = time.monotonic() + 3
    for q in P('/proc').iterdir():
        if not q.name.isdigit():
            continue
        count += 1
        assert count <= 512 and time.monotonic() < until, 'pending-census-bound'
        try:
            exe = str((q / 'exe').resolve(strict=True))
            cg = (q / 'cgroup').read_text()
            if any(('/' + x + '/' in cg or cg.strip().endswith('/' + x) for x in M['ownedSlices'])):
                continue
            if any((cg.strip().endswith('/' + unit) for unit in M['ownedBootstrapUnits'])):
                continue
            if cg.strip() == '0::/system.slice/cron.service':
                continue
            if exe in ('/usr/bin/bash', '/usr/bin/dash'):
                argv = (q / 'cmdline').read_bytes().split(b'\x00')
                if len(argv) == 4 and argv[1] == b'-c' and (argv[2].decode() in M['transportCommands']):
                    continue
            if exe in ('/usr/bin/sudo', '/usr/bin/systemd-run'):
                argv = [x.decode() for x in (q / 'cmdline').read_bytes().split(b'\x00') if x]
                if argv in M['transportArgv']:
                    continue
            fields = (q / 'stat').read_text().rsplit(')', 1)[1].split()
            start = fields[19]
            if exe == '/usr/bin/pgrep' and fields[1] == '1281392':
                continue
            if exe in a['ordinaryOsExecutables']:
                continue
            identity = str(q.name) + ':' + start + ':' + exe
            if identity not in a['existingOtherProcesses']:
                raw=(q/'cmdline').read_bytes();argv=[x.decode() for x in raw.split(b'\0') if x]
                out['rejectedProcess']={'pid':int(q.name),'start':start,'exe':exe,'cgroup':cg,'argv0':argv[0] if argv else '', 'argc':len(argv),'cmdlineSha256':hashlib.sha256(raw).hexdigest(),'exactTransportMatch':argv in M['transportArgv'],'tailTransportMatch':any(argv[1:]==v[1:] for v in M['transportArgv'])}
            assert identity in a['existingOtherProcesses'], 'new-unclassified-workload'
        except FileNotFoundError:
            continue
    jobs = capture(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager'], 3, limit=8192)
    assert jobs['rc'] == 0 and (not jobs['reason']), 'pending-job-read'
    for line in jobs['stdout'].splitlines():
        fields = line.split()
        assert len(fields) >= 4 and fields[1] in M['ownedUnits'], 'unclassified-pending-job'
    timers = capture(['/usr/bin/systemctl', 'list-timers', '--all', '--no-legend', '--no-pager'], 3, limit=16384)
    assert timers['rc'] == 0 and (not timers['reason']) and (not timers['truncated']), 'timer-read'
    timer_rows = sorted(([line.split()[-2:], line.split()[:4] if line.split()[0] != '-' else ['-']] for line in timers['stdout'].splitlines() if line.strip()))
    assert timer_rows == a['timerRows'], 'timer-set-or-due-window-changed'
    queued = capture(['/usr/bin/atq'], 3, limit=4096)
    assert queued['rc'] == 0 and (not queued['reason']) and (not queued['stdout'].strip()), 'pending-at-job'
    for row in a['scheduleDirectories']:
        names = []
        with os.scandir(row['path']) as entries:
            for entry in entries:
                names.append(entry.name)
                assert len(names) <= 128, 'schedule-directory-bound'
        assert sorted(names) == row['entries'], 'scheduled-work-added-or-removed'
    for row in a['scheduleFiles']:
        q = P(row['path'])
        assert q.is_file() and sha(q) == row['sha256'], 'scheduled-work-changed'
