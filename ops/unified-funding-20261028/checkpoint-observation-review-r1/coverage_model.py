"""SOURCE ONLY: predicate over normalized, synthetic metadata events.

This is NOT a strace parser, collector, attach tool, or production attestation.
Evidence booleans must eventually come from a separately qualified collector.
No real trace can be authorized by this candidate.
"""
WRITE_CALLS = {'write', 'writev', 'pwrite64', 'pwritev', 'pwritev2',
               'sendto', 'sendmsg', 'sendmmsg', 'sendfile', 'splice',
               'vmsplice', 'copy_file_range'}
UNSUPPORTED = {'io_uring_setup', 'io_uring_register', 'io_uring_enter',
               'io_setup', 'io_submit', 'ioctl', 'socketcall', 'execve',
               'execveat', 'clone', 'clone3', 'fork', 'vfork', 'unshare',
               'setns', 'ptrace', 'process_vm_writev'}
SAFE_CALLS = {'close', 'futex', 'epoll_wait', 'epoll_pwait', 'poll',
              'ppoll', 'rt_sigreturn', 'rt_sigprocmask', 'clock_gettime',
              'getpid', 'gettid', 'exit', 'exit_group'}
WAIT_CALLS = {'epoll_wait', 'epoll_pwait', 'poll', 'ppoll'}


def harmless_pending(e):
    if e['syscall'] in WAIT_CALLS:
        return True
    # Collector must derive operation from RAW futex op, including flags.
    # WAKE_OP, REQUEUE, unknown ops, and arbitrary futex calls are NOT waits.
    op = e.get('futex_op')
    return (e['syscall'] == 'futex' and type(op) is int
            and op >= 0 and op & ~0x189 == 0
            and (op & ~0x180) in (0, 9))  # WAIT / WAIT_BITSET + PRIVATE/CLOCK_REALTIME
FACTS = {'all_threads_traced', 'sole_journal_writer', 'pinned_source_ordering',
         'no_preexisting_async_io_or_external_sender', 'raw_buffers_only',
         'trace_complete', 'tracer_success', 'all_writers_dead',
         'poststop_file_and_parent_fsynced', 'private_journal_readback_valid',
         'journal_prefix_and_retention_covered'}
ALLOWED = {
    'capture': {'seq', 'kind', 'tid', 'tmp_identity'},
    'enter': {'seq', 'kind', 'tid', 'call_id', 'syscall', 'fd_identity', 'count'},
    'return': {'seq', 'kind', 'tid', 'call_id', 'result'},
    'rename': {'seq', 'kind', 'tid', 'from_identity', 'to_role', 'result'},
    'exit': {'seq', 'kind', 'tid', 'status'},
}


def evaluate(trace):
    reasons = []
    def refuse(why):
        if why not in reasons:
            reasons.append(why)
    if set(trace) != {'facts', 'threads', 'writer_tid', 'events', 'readback'}:
        refuse('unexpected-trace-schema')
    facts = trace.get('facts', {})
    if set(facts) != FACTS or any(facts.get(k) is not True for k in FACTS):
        refuse('unestablished-coverage-facts')
    threads = trace.get('threads', [])
    if not threads or len(set(threads)) != len(threads) or any(type(t) is not int for t in threads):
        refuse('invalid-thread-roster')
    live = set(threads)
    writer = trace.get('writer_tid')
    if writer not in live:
        refuse('writer-not-traced')
    pending, capture, renamed, written = {}, None, False, 0
    events = trace.get('events', [])
    if not events or len(events) > 10000:
        refuse('invalid-event-bound')
    for seq, e in enumerate(events, 1):
        kind = e.get('kind')
        fields = ALLOWED.get(kind, set())
        if kind == 'enter' and e.get('syscall') == 'futex':
            fields = fields | {'futex_op'}
        if kind not in ALLOWED or set(e) != fields or e.get('seq') != seq:
            refuse('unknown-missing-or-extra-metadata')
            continue
        tid = e['tid']
        if tid not in live:
            refuse('untraced-or-dead-thread-event')
        if kind == 'capture':
            if capture is not None or tid != writer or any(not harmless_pending(x) for x in pending.values()):
                refuse('ambiguous-capture-boundary')
            if not isinstance(e['tmp_identity'], str) or not e['tmp_identity']:
                refuse('missing-temp-file-identity')
            capture = e['tmp_identity']
        elif kind == 'enter':
            key = (tid, e['call_id'])
            if key in pending:
                refuse('duplicate-call-id')
            pending[key] = e
            call = e['syscall']
            if call in UNSUPPORTED or call not in WRITE_CALLS | SAFE_CALLS:
                refuse('unsupported-syscall-or-alternate-send')
            if call == 'futex' and not harmless_pending(e):
                refuse('unreviewed-futex-operation')
            if call in WRITE_CALLS and capture is not None:
                # Fail closed on socket, pipe, eventfd, stdout, unknown or reused
                # descriptors. Only this writer's synchronous temp write fits.
                if not (call == 'write' and tid == writer and not renamed
                        and e['fd_identity'] == capture
                        and type(e['count']) is int and e['count'] > 0):
                    refuse('possible-outbound-or-untracked-write-after-capture')
        elif kind == 'return':
            call = pending.pop((tid, e['call_id']), None)
            if call is None:
                refuse('unpaired-syscall-return')
            elif call['syscall'] == 'write' and capture is not None and call['fd_identity'] == capture:
                if type(e['result']) is not int or e['result'] != call['count']:
                    refuse('failed-or-partial-checkpoint-write')
                else:
                    written += e['result']
        elif kind == 'rename':
            if (capture is None or renamed or tid != writer
                    or any(not harmless_pending(x) for x in pending.values())
                    or e['from_identity'] != capture or e['to_role'] != 'journal'
                    or e['result'] != 0 or written <= 0):
                refuse('unverified-journal-rename')
            renamed = True
        elif kind == 'exit':
            # Allow a thread killed by exit_group while blocked ONLY in a
            # positively classified harmless wait. Nonreturning exit itself
            # also needs no invented syscall return. Writes remain ambiguous.
            for key, call in list(pending.items()):
                if key[0] != tid:
                    continue
                if harmless_pending(call) or call['syscall'] in {'exit', 'exit_group'}:
                    del pending[key]
                else:
                    refuse('thread-exited-with-inflight-syscall')
            if e['status'] != 0:
                refuse('unclean-thread-exit')
            live.discard(tid)
    if pending or live or not renamed:
        refuse('incomplete-trace-or-no-checkpoint')
    rb = trace.get('readback', {})
    if (set(rb) != {'identity', 'size'} or rb.get('identity') != capture
            or rb.get('size') != written or written <= 0):
        refuse('readback-does-not-match-observed-checkpoint')
    return {'candidateCoverage': not reasons, 'reasons': reasons,
            'productionAcceptance': False,
            'limitation': 'synthetic normalized-event predicate; collector and real fixture unqualified'}
