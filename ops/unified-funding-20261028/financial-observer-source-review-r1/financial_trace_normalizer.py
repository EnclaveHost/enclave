"""Offline, payload-free strace normalizer; SOURCE CANDIDATE, no attach/stop API.

This derives syscall facts, not source provenance or financial finality. Even a
matching trace never authorizes a production restart. Unknowns fail closed.
"""
import hashlib
import json
import re

MAX_BYTES = 16 * 1024 * 1024
MAX_LINE = 8192
MAX_EVENTS = 100000
PREFIX = re.compile(r'^(\d+) (\d+\.\d+) (.*)$')
CALL = re.compile(r'^(\w+)\((.*)\)\s+=\s+(.*)$')
ENTER = re.compile(r'^(\w+)\((.*) <unfinished \.\.\.>$')
RESUME = re.compile(r'^<\.\.\. (\w+) resumed>(.*)$')
RETURN = re.compile(r'^(-?0x[0-9a-f]+|-?\d+|\?)(?:\s|$)')
OPEN = re.compile(r'^AT_FDCWD, "([^"\\]+)", O_WRONLY\|O_CREAT\|O_TRUNC\|O_CLOEXEC, 0?(?:600|666)$')
RENAME = re.compile(r'^"([^"\\]+)", "([^"\\]+)"$')
RAW = re.compile(r'^(?:-?0x[0-9a-f]+|-?\d+)(?:, (?:-?0x[0-9a-f]+|-?\d+))*$')
SIGNAL = re.compile(r'^--- (SIG\w+) \{si_signo=(SIG\w+), si_code=SI_USER, si_pid=(\d+), si_uid=(\d+)\} ---$')
EXIT = re.compile(r'^\+\+\+ exited with (\d+) \+\+\+$')
WAIT = {'futex', 'epoll_wait', 'epoll_pwait', 'poll', 'ppoll'}
IMAGE_CHANGE = {'clone', 'clone3', 'fork', 'vfork', 'execve', 'execveat', 'setns', 'unshare'}


def number(s):
    return int(s, 16) if 'x' in s else int(s, 10)


def normalize(trace, context):
    """Context is collector evidence, never inferred from trace timestamps.

    Exact one post-SIGTERM journal attempt is deliberately required. A timer
    flush followed by failed signal flush is rejected, including same bytes.
    Signal attribution still requires the separately reviewed source profile:
    only the synchronous store handler can produce runtime exit(0), no custom
    serializers, one journal instance, no async mutation/signer/exit callback.
    """
    reasons, events, pending, exits = [], [], {}, {}
    def reject(reason):
        if reason not in reasons:
            reasons.append(reason)
    writer = context['writerTid']
    roster = set(context['threadIds'])
    tmp, target = context['tmpPath'], context['journalPath']
    other_stores = context.get('otherStores', {})
    known_paths = {tmp, target}
    for role, paths in other_stores.items():
        if (not re.fullmatch('[a-z][a-z0-9_-]{0,63}', role)
                or set(paths) != {'tmp', 'journal'}
                or not all(isinstance(v, str) and v.startswith('/') for v in paths.values())
                or paths['tmp'] != paths['journal'] + '.tmp'
                or any(v in known_paths for v in paths.values())):
            reject('invalid-known-store-role-map')
        known_paths.update(paths.values())
    signal_line = None
    attempts = []
    active = None
    checkpoint = None
    tid_seen = set()
    raw = trace if isinstance(trace, bytes) else trace.encode()
    if len(raw) > MAX_BYTES:
        return {'syscallCheckpoint': False, 'reasons': ['trace-byte-bound'], 'productionAcceptance': False}
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeDecodeError:
        return {'syscallCheckpoint': False, 'reasons': ['non-ascii-trace'], 'productionAcceptance': False}
    if len(lines) > MAX_EVENTS or not raw.endswith(b'\n'):
        reject('trace-bound-or-truncation')
    if writer not in roster or len(roster) != len(context['threadIds']):
        reject('invalid-roster')

    def complete(tid, name, args, ret, line, start):
        nonlocal active, checkpoint
        m = RETURN.match(ret)
        if not m:
            reject('unparsed-return'); return
        result = None if m[1] == '?' else number(m[1])
        event = {'line': line, 'startLine': start, 'tid': tid, 'syscall': name, 'result': result}
        events.append(event)
        if name in IMAGE_CHANGE:
            reject('source-process-profile-changed')
        if name in {'open', 'openat', 'rename', 'renameat', 'renameat2', 'creat'} and '"' not in args:
            reject('missing-required-path-decoding'); return
        # All argument text is discarded. Only exact known journal paths may
        # be decoded; a future live filter must apply this BEFORE persistence.
        if '"' in args:
            if name == 'openat':
                o = OPEN.fullmatch(args)
                role = next((k for k,v in other_stores.items() if o and o[1] == v['tmp']), None)
                if role:
                    if tid != writer or active is not None:
                        reject('other-store-overlaps-journal-checkpoint')
                    event['journalRole'] = 'other-store:' + role
                    return
                if not o or o[1] != tmp:
                    reject('unexpected-decoded-path'); return
            elif name == 'rename':
                r = RENAME.fullmatch(args)
                role = next((k for k,v in other_stores.items() if r and (r[1],r[2]) == (v['tmp'],v['journal'])), None)
                if role:
                    if tid != writer or active is not None:
                        reject('other-store-overlaps-journal-checkpoint')
                    event['journalRole'] = 'other-store:' + role
                    return
                if not r or (r[1], r[2]) != (tmp, target):
                    reject('unexpected-decoded-path'); return
            else:
                reject('unexpected-decoded-data'); return
        elif args and not RAW.fullmatch(args):
            reject('nonraw-syscall-arguments'); return
        if name == 'openat' and '"' in args:
            if signal_line is None or start < signal_line:
                event['journalRole'] = 'pre-signal-attempt'
                return
            attempt = {'openLine': start, 'fd': result, 'bytes': 0, 'closed': False}
            attempts.append(attempt)
            if tid != writer or active is not None or result is None or result < 0:
                reject('failed-or-ambiguous-journal-open')
            else:
                active = attempt
        elif name == 'write':
            a = [number(x) for x in args.split(', ')]
            if len(a) != 3:
                reject('malformed-raw-write'); return
            if active is not None and a[0] == active['fd'] and not active['closed']:
                if tid != writer or result != a[2] or result <= 0:
                    reject('failed-partial-or-other-thread-journal-write')
                else:
                    active['bytes'] += result
                    event['journalBytes'] = result
            # Other writes/queued io_uring are NOT a new financial intent under
            # the independently established record-before-delegation profile.
        elif name == 'close':
            a = [number(x) for x in args.split(', ')]
            if active is not None and a and a[0] == active['fd'] and not active['closed']:
                if tid != writer or result != 0:
                    reject('failed-or-other-thread-journal-close')
                active['closed'] = True
        elif name == 'rename' and '"' in args:
            if signal_line is None or start < signal_line:
                event['journalRole'] = 'pre-signal-rename'; return
            if tid != writer or result != 0 or active is None or not active['closed'] or active['bytes'] <= 0:
                reject('failed-or-unpaired-journal-rename')
            else:
                checkpoint = {**active, 'renameLine': line}
            active = None
        elif name in {'dup', 'dup2', 'dup3', 'fcntl', 'close_range', 'renameat', 'renameat2', 'open', 'creat'} and active is not None:
            reject('unsupported-descriptor-or-path-operation-during-checkpoint')
        elif name in {'pwrite64', 'pwritev', 'pwritev2', 'writev', 'ftruncate', 'truncate', 'mmap'} and active is not None:
            reject('unsupported-write-during-checkpoint')
        if name == 'exit_group' and (tid != writer or args != '0'):
            reject('unclean-or-other-thread-group-exit')

    for line, text in enumerate(lines, 1):
        if len(text) > MAX_LINE:
            reject('line-bound'); continue
        m = PREFIX.fullmatch(text)
        if not m:
            reject('unparsed-line'); continue
        tid, body = int(m[1]), m[3]
        tid_seen.add(tid)
        if tid not in roster or tid in exits:
            reject('untraced-or-exited-thread')
        if body == '--- stopped by SIGSTOP ---':
            continue
        s = SIGNAL.fullmatch(body)
        if s:
            if s[1] != s[2] or int(s[3]) != context['signalSenderPid']:
                reject('unexpected-signal-source')
            if s[1] == 'SIGTERM':
                if tid != writer or signal_line is not None:
                    reject('ambiguous-main-thread-sigterm')
                signal_line = line
            elif s[1] != 'SIGCONT':
                reject('unexpected-signal')
            continue
        e = EXIT.fullmatch(body)
        if e:
            exits[tid] = int(e[1])
            if int(e[1]) != 0:
                reject('nonzero-thread-exit')
            old = pending.pop(tid, None)
            if old and old[0] not in WAIT | {'exit', 'exit_group'}:
                reject('unfinished-syscall-at-exit')
            continue
        resumed = RESUME.fullmatch(body)
        if resumed:
            old = pending.pop(tid, None)
            if old is None or old[0] != resumed[1]:
                reject('unpaired-resumed-syscall'); continue
            body = old[0] + '(' + old[1] + resumed[2]
            start = old[2]
        else:
            start = line
        entered = ENTER.fullmatch(body)
        if entered:
            if tid in pending:
                reject('overlapping-thread-syscalls')
            pending[tid] = (entered[1], entered[2], line)
            continue
        call = CALL.fullmatch(body)
        if not call:
            reject('unparsed-call'); continue
        complete(tid, call[1], call[2], call[3], line, start)
    if pending or set(exits) != roster or tid_seen != roster:
        reject('incomplete-thread-lifetime')
    if signal_line is None:
        reject('missing-main-thread-sigterm')
    if len(attempts) != 1 or active is not None or checkpoint is None:
        reject('not-one-complete-final-journal-attempt')
    if not any(e['syscall'] == 'exit_group' and e['tid'] == writer for e in events):
        reject('missing-main-thread-exit-group')
    return {'traceSha256': hashlib.sha256(raw).hexdigest(), 'traceBytes': len(raw),
            'traceLines': len(lines), 'signalLine': signal_line, 'checkpoint': checkpoint,
            'threadExits': exits, 'syscallCheckpoint': not reasons, 'reasons': reasons,
            'events': events, 'productionAcceptance': False}


REQUIRED_EVIDENCE = {
    'exactSourceClosureAndRuntime', 'runtimeExitZeroOnlyViaStoreSignalHandler',
    'plainJournalSerialization', 'soleJournalWriter', 'sameSignerScopeExcluded',
    'recordBeforeEveryFinancialDelegation', 'noFinancialWorkerOrExitCallback',
    'fullAttachBeforeSignal', 'identityUnchangedThroughDeath', 'cgroupEmpty',
    'collectorCompleteAndPrivate', 'postStopJournalAndDirectoryFsynced',
    'privateReadbackMatchesObservedInodeAndSize', 'prefixAndPrunedTailCovered',
}


def evaluate(normalized, evidence):
    """Evidence references must come from a reviewed collector/reviewer, not UI.
    This adapter remains deliberately unable to authorize production actions.
    """
    def has_reference(k):
        value = evidence.get(k)
        return (isinstance(value, dict) and value.get('status') == 'verified'
                and isinstance(value.get('artifactSha256'), str)
                and re.fullmatch('[0-9a-f]{64}', value['artifactSha256']) is not None)
    missing = sorted(k for k in REQUIRED_EVIDENCE if not has_reference(k))
    reasons = list(normalized['reasons'])
    if missing:
        reasons.append('missing-independent-evidence')
    return {'financialCoverageCandidate': not reasons, 'missingEvidence': missing,
            'reasons': reasons, 'financialOutcome': 'UNKNOWN',
            'writeResumptionAllowed': False, 'productionAcceptance': False}


def normalize_stream(stream, context):
    """Bounded metadata sink, no raw trace persistence and no attach command.

    The collector must independently require raw syscall buffers; this sink
    rejects unexpected decoding and does not echo it. Only its normalized
    output may be persisted. A violated cap refuses the entire observation.
    """
    content = bytearray()
    while True:
        line = stream.readline(MAX_LINE + 2)
        if not line:
            break
        if len(line) > MAX_LINE + 1 or len(content) + len(line) > MAX_BYTES:
            return {'syscallCheckpoint': False, 'reasons': ['stream-bound'],
                    'productionAcceptance': False}
        content.extend(line)
    return normalize(bytes(content), context)
