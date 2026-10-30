"""Deterministic pure fixtures; no Windows, RPC, filesystem or process adapters."""
import unittest
from dataclasses import replace
from lifecycle import *

H = 'a' * 64
J = 'b' * 64


class LifecycleCases(unittest.TestCase):
    def setUp(self):
        self.identity = Identity('boot-a', 'attempt-a', 'vm-a', H)
        self.policy = GrowthPolicy(64*MIB, MIB, 1000, 2000, 30000, 15000, H)
        self.o = Observation(self.identity, 1000, RPC_TOTAL+PENDING+HOST_FLOOR+VARIATION,
            DISK_FLOOR+BOOT_CAP+ARTIFACT_CAP+64*MIB, 0, 0, 0, True, H, H, H, H, True, J, MIB)
        self.prerequisites = {key:H for key in ('guest_dependencies','boot_and_seed',
            'attachment_and_fencing','readiness_verifier','guardian_adapter','disk_growth_qualification')}
        self.s = initial_state(self.o,self.identity,1000,self.policy,self.prerequisites,H)

    def receipt(self, issuer, data, sequence=0, at=1001, identity=None):
        return Receipt(identity or self.identity, sequence, at, True, issuer, data)

    def transition(self, event, issuer, data, state=None, sequence=0, at=1001):
        return next_state(state or self.s, event, self.receipt(issuer,data,sequence,at),at,self.policy)

    def test_exact_initial_memory_boundary(self):
        self.assertEqual(len(admit(self.o,self.identity,1000,self.policy,self.prerequisites,H)),64)
        with self.assertRaisesRegex(Refusal,'insufficient memory'):
            admit(replace(self.o,physical_free_bytes=self.o.physical_free_bytes-1),self.identity,1000,self.policy,self.prerequisites,H)

    def test_disk_margin_is_in_addition_to_artifacts(self):
        with self.assertRaisesRegex(Refusal,'insufficient disk'):
            admit(replace(self.o,disk_free_bytes=self.o.disk_free_bytes-1),self.identity,1000,self.policy,self.prerequisites,H)
        with self.assertRaises(Refusal):
            replace(self.policy,disk_margin_bytes=0).validate()
        with self.assertRaises(Refusal):
            replace(self.policy,disk_margin_bytes=MIB).validate()

    def test_required_dependencies_no_boolean_bypass(self):
        for key in self.prerequisites:
            missing=dict(self.prerequisites);del missing[key]
            with self.assertRaises(Refusal):admit(self.o,self.identity,1000,self.policy,missing,H)
        bad=dict(self.prerequisites);bad['guardian_adapter']=True
        with self.assertRaises(Refusal):admit(self.o,self.identity,1000,self.policy,bad,H)

    def test_stale_and_unknown_pending_denied(self):
        for o in (replace(self.o,pending_complete=False),replace(self.o,host_authenticated=False),
                  replace(self.o,monotonic_ms=1001),replace(self.o,admitted_boot_sha256=J)):
            with self.assertRaises(Refusal):admit(o,self.identity,1000,self.policy,self.prerequisites,H)
        with self.assertRaises(Refusal):admit(self.o,self.identity,11001,self.policy,self.prerequisites,H)

    def test_start_requires_live_independent_guardian(self):
        with self.assertRaises(Refusal):self.transition('start','host-controller',{'owned_start_worker_bound':True})
        with self.assertRaises(Refusal):self.transition('arm','host-guardian',{'live_instance':True})
        s=self.transition('arm','host-guardian',{'live_instance':True,'independent_deadline_live':True,
            'start_fence_armed':True,'deadline_ms':901000})
        s=self.transition('start','host-controller',{'owned_start_worker_bound':True},s,1,1002)
        self.assertEqual(s.phase,Phase.STARTING)

    def test_exact_deadline_includes_delayed_start(self):
        s=replace(self.s,phase=Phase.ARMED)
        s=self.transition('start','host-controller',{'owned_start_worker_bound':True},s,0,901000)
        self.assertEqual(s.phase,Phase.STOPPING)
        self.assertEqual(s.deadline_ms,901000)

    def test_missing_sample_does_not_reset_clock(self):
        self.assertEqual(watchdog_tick(self.s,2000,self.policy).last_ms,1000)
        self.assertEqual(watchdog_tick(self.s,4001,self.policy).phase,Phase.STOPPING)
        self.assertEqual(watchdog_tick(self.s,999,self.policy).phase,Phase.QUARANTINED)

    def test_wrong_identity_quarantines_without_targeting_replacement(self):
        r=self.receipt('host-guardian',{},identity=replace(self.identity,vm_guid='replacement'))
        s=next_state(self.s,'arm',r,1001,self.policy)
        self.assertEqual(s.phase,Phase.QUARANTINED)
        self.assertEqual(s.identity,self.identity)

    def test_sequence_replay_refused(self):
        s=replace(self.s,last_sequence=5)
        with self.assertRaises(Refusal):next_state(s,'fail',self.receipt('host-controller',{},5),1001,self.policy)

    def test_running_memory_does_not_double_subtract_owned_guest(self):
        s=replace(self.s,phase=Phase.STARTING)
        o=replace(self.o,monotonic_ms=1001,owned_memory_bytes=GUEST,support_charged_bytes=SUPPORT,
                  physical_free_bytes=PENDING+HOST_FLOOR+VARIATION)
        okay=self.transition('observe','host-guardian',{'observation':o},s)
        self.assertEqual(okay.phase,Phase.STARTING)
        bad=self.transition('observe','host-guardian',{'observation':replace(o,physical_free_bytes=o.physical_free_bytes-1)},s)
        self.assertEqual(bad.phase,Phase.STOPPING)

    def test_unexpected_workload_and_boot_changes_stop(self):
        s=replace(self.s,phase=Phase.STARTING)
        for field in ('existing_vm_set_sha256','existing_process_set_sha256','pending_sha256','admitted_boot_sha256'):
            o=replace(self.o,monotonic_ms=1001,**{field:J})
            self.assertEqual(self.transition('observe','host-guardian',{'observation':o},s).phase,Phase.STOPPING)

    def test_boot_or_guest_report_is_not_ready(self):
        s=replace(self.s,phase=Phase.STARTING)
        with self.assertRaises(Refusal):self.transition('ready','guest-stdout',{},s)
        with self.assertRaises(Refusal):self.transition('ready','qualified-readiness-verifier',{'guardian_live':True},s)
        s=self.transition('ready','qualified-readiness-verifier',{'verified_chain_set':('l1-execution','l1-consensus','base-execution','base-rollup'),
            'guardian_live':True,'resource_receipt_current':True,'attachment_fenced':True},s)
        self.assertEqual(s.phase,Phase.READY_TRIAL)
        self.assertEqual(watchdog_tick(s,901000,self.policy).phase,Phase.STOPPING)

    def test_off_without_late_start_fence_keeps_reservation(self):
        s=replace(self.s,phase=Phase.STOPPING)
        with self.assertRaises(Refusal):self.transition('off','host-guardian',{'vm_state':'Off','assigned_memory_bytes':0},s)
        s=self.transition('off','host-guardian',{'vm_state':'Off','assigned_memory_bytes':0,'start_worker_dead':True,'late_start_fenced':True},s)
        self.assertEqual(s.phase,Phase.STOPPED_HELD)
        with self.assertRaises(Refusal):self.transition('release','host-controller',{'guest_write_fence_confirmed':True},s,1,1002)

    def test_cleanup_proven_before_release_and_no_replay(self):
        s=replace(self.s,phase=Phase.STOPPED_HELD)
        s=self.transition('release','host-controller',{'guest_write_fence_confirmed':True,'exporter_teardown_confirmed':True,
            'guardian_tasks_resolved':True,'retained_evidence_bound':True},s)
        self.assertEqual(s.phase,Phase.RELEASED)
        with self.assertRaises(Refusal):self.transition('start','host-controller',{'owned_start_worker_bound':True},s,1,1002)

    def test_origin_and_deadline_are_bound_at_admission_and_resume(self):
        self.assertEqual(self.s.deadline_ms-self.s.origin_ms,STARTUP_MS)
        for s in (replace(self.s,deadline_ms=1801000),replace(self.s,origin_ms=True),
                  replace(self.s,last_ms=-1),replace(self.s,deadline_ms=901000.0)):
            with self.assertRaises(Refusal):watchdog_tick(s,1001,self.policy)
        for clock in (True,-1,float('nan'),1000.0):
            with self.assertRaises(Refusal):initial_state(self.o,self.identity,clock,self.policy,self.prerequisites,H)
        with self.assertRaises(Refusal):initial_state(replace(self.o,pending_complete=False),self.identity,1000,self.policy,self.prerequisites,H)

    def test_quarantine_keeps_original_deadline_and_cleanup_obligation(self):
        running=replace(self.s,phase=Phase.STARTING)
        bad=self.receipt('host-guardian',{},identity=replace(self.identity,vm_guid='replacement'))
        quarantined=next_state(running,'observe',bad,1001,self.policy)
        self.assertTrue(quarantined.cleanup_required)
        stopped=watchdog_tick(quarantined,901000,self.policy)
        self.assertEqual(stopped.phase,Phase.STOPPING)
        self.assertEqual(stopped.identity,self.identity)
        self.assertEqual(stopped.deadline_ms,901000)
        with self.assertRaises(Refusal):self.transition('off','host-guardian',{'vm_state':'Off','assigned_memory_bytes':0,
            'start_worker_dead':True,'late_start_fenced':True},quarantined,0,1002)
        off=self.transition('off','host-guardian',{'vm_state':'Off','assigned_memory_bytes':0,
            'start_worker_dead':True,'late_start_fenced':True,'original_ownership_revalidated':True},quarantined,0,1002)
        self.assertEqual(off.phase,Phase.STOPPED_HELD)
        self.assertTrue(off.cleanup_required)

    def test_clock_rollback_cannot_erase_cleanup(self):
        running=replace(self.s,phase=Phase.STARTING,last_ms=2000)
        quarantined=watchdog_tick(running,1999,self.policy)
        self.assertEqual(quarantined.phase,Phase.QUARANTINED)
        self.assertTrue(quarantined.cleanup_required)
        self.assertEqual(watchdog_tick(quarantined,901000,self.policy).phase,Phase.STOPPING)

    def test_admitted_policy_cannot_be_replaced(self):
        different=replace(self.policy,disk_margin_bytes=65*MIB)
        different.validate()  # Individually valid is not the admitted policy.
        with self.assertRaisesRegex(Refusal,'admitted policy changed'):
            watchdog_tick(self.s,1001,different)
        with self.assertRaisesRegex(Refusal,'admitted policy changed'):
            next_state(self.s,'fail',self.receipt('host-controller',{}),1001,different)

    def test_guest_boot_writes_keep_identity_without_live_content_hash(self):
        running=replace(self.s,phase=Phase.STARTING)
        changed=replace(self.o,monotonic_ms=1001,runtime_boot_allocated_bytes=2*MIB)
        # Mutable contents are deliberately absent from Observation. Same protected
        # file identity and admitted artifact digest survive normal filesystem writes.
        self.assertEqual(self.transition('observe','host-guardian',{'observation':changed},running).phase,Phase.STARTING)
        replaced=replace(changed,runtime_boot_identity_sha256=H)
        self.assertEqual(self.transition('observe','host-guardian',{'observation':replaced},running).phase,Phase.STOPPING)
        oversized=replace(changed,runtime_boot_allocated_bytes=BOOT_CAP+1)
        self.assertEqual(self.transition('observe','host-guardian',{'observation':oversized},running).phase,Phase.STOPPING)


if __name__ == '__main__':
    unittest.main()
