"""SOURCE ONLY: these tests have NOT been executed or queue-admitted."""
import unittest
from coverage_model import evaluate, FACTS


def clean():
    return {'facts': dict.fromkeys(FACTS, True), 'threads': [11, 12], 'writer_tid': 11,
            'events': [
                {'seq': 1, 'kind': 'capture', 'tid': 11, 'tmp_identity': 'dev1:ino9:g2'},
                {'seq': 2, 'kind': 'enter', 'tid': 11, 'call_id': 1, 'syscall': 'write',
                 'fd_identity': 'dev1:ino9:g2', 'count': 40},
                {'seq': 3, 'kind': 'return', 'tid': 11, 'call_id': 1, 'result': 40},
                {'seq': 4, 'kind': 'rename', 'tid': 11, 'from_identity': 'dev1:ino9:g2',
                 'to_role': 'journal', 'result': 0},
                {'seq': 5, 'kind': 'exit', 'tid': 12, 'status': 0},
                {'seq': 6, 'kind': 'exit', 'tid': 11, 'status': 0}],
            'readback': {'identity': 'dev1:ino9:g2', 'size': 40}}


def renumber(t):
    for i, e in enumerate(t['events'], 1):
        e['seq'] = i
    return t


class CoverageTests(unittest.TestCase):
    def test_model_positive_is_never_production_permission(self):
        r = evaluate(clean())
        self.assertTrue(r['candidateCoverage'])
        self.assertFalse(r['productionAcceptance'])

    def test_each_missing_fact_refuses(self):
        for fact in FACTS:
            t = clean(); t['facts'][fact] = False
            with self.subTest(fact=fact): self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_failed_rename_and_swallowed_error_refuse(self):
        t = clean(); t['events'][3]['result'] = -1
        self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_failed_or_partial_write_refuses(self):
        for result in (-1, 0, 39):
            t = clean(); t['events'][2]['result'] = result
            self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_network_or_ipc_after_capture_refuses(self):
        for call in ('write', 'writev', 'sendto', 'sendmsg', 'sendmmsg', 'splice'):
            for where in (3, 4):
                t = clean()
                t['events'][where:where] = [
                    {'kind': 'enter', 'tid': 12, 'call_id': 8, 'syscall': call,
                     'fd_identity': 'socket-or-unknown', 'count': 16},
                    {'kind': 'return', 'tid': 12, 'call_id': 8, 'result': 16}]
                self.assertFalse(evaluate(renumber(t))['candidateCoverage'])

    def test_failed_network_attempt_still_refuses(self):
        t = clean(); t['events'][1]['fd_identity'] = 'socket'; t['events'][2]['result'] = -1
        self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_fd_reuse_and_wrong_writer_refuse(self):
        for field, value in [('fd_identity', 'dev1:ino9:g3'), ('tid', 12)]:
            t = clean(); t['events'][1][field] = value
            self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_async_offload_clone_unknown_and_exec_refuse(self):
        for call in ('io_uring_enter', 'io_submit', 'clone3', 'execve', 'ioctl', 'unknown'):
            t = clean(); t['events'][1]['syscall'] = call
            self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_missing_thread_exit_and_sigkill_refuse(self):
        t = clean(); del t['events'][4]
        self.assertFalse(evaluate(renumber(t))['candidateCoverage'])
        t = clean(); t['events'][-1]['status'] = 'SIGKILL'
        self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_inflight_at_capture_refuses(self):
        t = clean(); t['events'].insert(0, {'kind':'enter', 'tid':12, 'call_id':9,
                         'syscall':'write', 'fd_identity':'socket', 'count':20})
        self.assertFalse(evaluate(renumber(t))['candidateCoverage'])

    def test_harmless_wait_spans_capture_and_exit_group(self):
        for syscall, extra in [('futex', {'futex_op':128}),
                               ('futex', {'futex_op':393}),
                               ('epoll_wait', {}), ('ppoll', {})]:
            t=clean()
            t['events'].insert(0, {'kind':'enter','tid':12,'call_id':9,
                'syscall':syscall,'fd_identity':None,'count':None,**extra})
            t['events'].insert(-1, {'kind':'enter','tid':11,'call_id':10,
                'syscall':'exit_group','fd_identity':None,'count':None})
            self.assertTrue(evaluate(renumber(t))['candidateCoverage'])

    def test_futex_wake_op_unknown_and_missing_op_refuse(self):
        for op in (5, 133, 3, 1, 1024, None):
            t=clean()
            t['events'].insert(0, {'kind':'enter','tid':12,'call_id':9,
                'syscall':'futex','fd_identity':None,'count':None,'futex_op':op})
            self.assertFalse(evaluate(renumber(t))['candidateCoverage'])
        t=clean()
        t['events'].insert(0, {'kind':'enter','tid':12,'call_id':9,
            'syscall':'futex','fd_identity':None,'count':None})
        self.assertFalse(evaluate(renumber(t))['candidateCoverage'])

    def test_wait_return_and_unfinished_write_are_distinct(self):
        t=clean()
        t['events'].insert(0, {'kind':'enter','tid':12,'call_id':9,
            'syscall':'epoll_pwait','fd_identity':None,'count':None})
        t['events'].insert(4, {'kind':'return','tid':12,'call_id':9,'result':0})
        self.assertTrue(evaluate(renumber(t))['candidateCoverage'])
        t=clean()
        t['events'].insert(4, {'kind':'enter','tid':12,'call_id':9,
            'syscall':'sendmsg','fd_identity':'socket','count':None})
        self.assertFalse(evaluate(renumber(t))['candidateCoverage'])

    def test_loss_malformed_payload_field_and_truncation_refuse(self):
        for bad in ({'kind': 'lost', 'tid':11}, {'kind':'detach', 'tid':11}):
            t=clean(); t['events'].insert(4,bad)
            self.assertFalse(evaluate(renumber(t))['candidateCoverage'])
        t=clean(); t['events'][1]['payload']='SYNTHETIC_CANARY'
        self.assertFalse(evaluate(t)['candidateCoverage'])
        t=clean(); t['events']=t['events'][:4]
        self.assertFalse(evaluate(t)['candidateCoverage'])

    def test_stale_readback_refuses(self):
        t=clean(); t['readback']['identity']='old-inode'
        self.assertFalse(evaluate(t)['candidateCoverage'])


if __name__ == '__main__':
    unittest.main()
