"""Pure owned-guest admission and lifecycle rules. No host operations on import.

Observations are supplied by a separately qualified, authenticated host adapter.
This module never treats a guest-provided dictionary as an authenticated receipt.
Native activation requires that adapter; this source alone cannot launch a VM.
"""
from dataclasses import dataclass, replace
from enum import Enum
from hashlib import sha256
from typing import Mapping
import json
import math

GIB = 1 << 30
MIB = 1 << 20
GUEST = 19 * GIB
SUPPORT = GIB
RPC_TOTAL = GUEST + SUPPORT
PENDING = 39388 * MIB
HOST_FLOOR = 18 * GIB
VARIATION = GIB
DISK_FLOOR = 16 * GIB
BOOT_CAP = 4 * GIB
ARTIFACT_CAP = 256 * MIB
STARTUP_MS = 900000


class Refusal(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def uint(value, name):
    require(type(value) is int and value >= 0, 'invalid ' + name)
    return value


def digest(value):
    require(type(value) is str and len(value) == 64
            and all(c in '0123456789abcdef' for c in value), 'invalid digest')
    return value


def canonical_hash(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                             allow_nan=False).encode()).hexdigest()


@dataclass(frozen=True)
class Identity:
    host_boot: str
    attempt: str
    vm_guid: str
    manifest_sha256: str

    def validate(self):
        for value in (self.host_boot, self.attempt, self.vm_guid):
            require(type(value) is str and 1 <= len(value) <= 128
                    and all(c.isalnum() or c in '-_' for c in value), 'invalid identity')
        digest(self.manifest_sha256)


@dataclass(frozen=True)
class GrowthPolicy:
    """Operational margin, not a guarantee against arbitrary administrative writes."""
    disk_margin_bytes: int
    maximum_growth_bytes_per_second: int
    sample_ms: int
    maximum_observation_ms: int
    shutdown_ms: int
    force_stop_ms: int
    qualification_sha256: str

    def validate(self):
        for name in ('disk_margin_bytes', 'maximum_growth_bytes_per_second',
                     'sample_ms', 'maximum_observation_ms', 'shutdown_ms', 'force_stop_ms'):
            require(uint(getattr(self, name), name) > 0, 'growth policy must be positive')
        require(self.sample_ms <= 1000 and self.maximum_observation_ms <= 2000,
                'unbounded observation gap')
        require(self.shutdown_ms <= 30000 and self.force_stop_ms <= 15000,
                'unbounded cleanup grace')
        window = self.sample_ms + self.maximum_observation_ms + self.shutdown_ms + self.force_stop_ms
        needed = math.ceil(self.maximum_growth_bytes_per_second * window / 1000)
        require(self.disk_margin_bytes >= needed, 'disk margin cannot cover qualified stop window')
        digest(self.qualification_sha256)


@dataclass(frozen=True)
class Observation:
    identity: Identity
    monotonic_ms: int
    physical_free_bytes: int
    disk_free_bytes: int
    support_charged_bytes: int
    owned_memory_bytes: int
    artifact_bytes: int
    pending_complete: bool
    existing_vm_set_sha256: str
    existing_process_set_sha256: str
    pending_sha256: str
    boot_file_sha256: str
    host_authenticated: bool

    def validate(self, expected, now_ms, maximum_age_ms):
        self.identity.validate()
        require(self.identity == expected, 'observation identity changed')
        for name in ('monotonic_ms', 'physical_free_bytes', 'disk_free_bytes',
                     'support_charged_bytes', 'owned_memory_bytes', 'artifact_bytes'):
            uint(getattr(self, name), name)
        require(self.host_authenticated is True and self.pending_complete is True,
                'missing authenticated complete host observation')
        require(0 <= now_ms - self.monotonic_ms <= maximum_age_ms, 'stale or future observation')
        for value in (self.existing_vm_set_sha256, self.existing_process_set_sha256,
                      self.pending_sha256, self.boot_file_sha256):
            digest(value)
        require(self.support_charged_bytes <= SUPPORT, 'support budget exceeded')
        require(self.owned_memory_bytes <= GUEST, 'guest memory budget exceeded')
        require(self.artifact_bytes <= ARTIFACT_CAP, 'owned artifact budget exceeded')


def admit(observation, identity, now_ms, policy, prerequisites, expected_boot):
    """Initial free-memory calculation includes the entire future allocation once."""
    policy.validate()
    observation.validate(identity, now_ms, 10000)
    require(observation.owned_memory_bytes == 0, 'initial admission already has owned allocation')
    require(observation.physical_free_bytes >= RPC_TOTAL + PENDING + HOST_FLOOR + VARIATION,
            'insufficient memory after full pending allowance')
    require(observation.disk_free_bytes >= DISK_FLOOR + BOOT_CAP + ARTIFACT_CAP
            + policy.disk_margin_bytes, 'insufficient disk after boot and growth allowance')
    require(observation.boot_file_sha256 == digest(expected_boot), 'boot artifact changed')
    # Digests must be supplied by the reviewed root manifest, not guest discovery.
    needed = {'guest_dependencies', 'boot_and_seed', 'attachment_and_fencing',
              'readiness_verifier', 'guardian_adapter', 'disk_growth_qualification'}
    require(type(prerequisites) is dict and set(prerequisites) == needed,
            'incomplete or unexpected activation closure')
    for value in prerequisites.values():
        digest(value)
    require(prerequisites['disk_growth_qualification'] == policy.qualification_sha256,
            'growth qualification does not match')
    return canonical_hash({'identity': identity.__dict__, 'observation': observation.__dict__ | {
        'identity': identity.__dict__}, 'policy': policy.__dict__, 'prerequisites': prerequisites})


class Phase(Enum):
    CREATED_OFF = 'created-off'
    ARMED = 'armed'
    STARTING = 'starting'
    READY_TRIAL = 'ready-trial'
    STOPPING = 'stopping'
    STOPPED_HELD = 'stopped-held'
    RELEASED = 'released'
    QUARANTINED = 'quarantined'


@dataclass(frozen=True)
class State:
    identity: Identity
    phase: Phase
    baseline_vm_sha256: str
    baseline_process_sha256: str
    baseline_pending_sha256: str
    boot_sha256: str
    deadline_ms: int
    last_ms: int
    last_sequence: int = -1
    reason: str = ''


@dataclass(frozen=True)
class Receipt:
    identity: Identity
    sequence: int
    monotonic_ms: int
    authenticated: bool
    issuer: str
    data: Mapping


def next_state(state, event, receipt, now_ms, policy):
    """Reducer cannot perform a VM operation. Adapter must enforce returned state.

    No event extends a deadline, releases a failed cleanup, or authorizes persistent
    production handover. A ready trial still stops at its original boundary.
    """
    policy.validate()
    uint(now_ms, 'clock')
    if now_ms < state.last_ms:
        return replace(state, phase=Phase.QUARANTINED, reason='monotonic clock rollback')
    if receipt.identity != state.identity or receipt.authenticated is not True:
        return replace(state, phase=Phase.QUARANTINED, reason='receipt authority mismatch', last_ms=now_ms)
    require(type(receipt.sequence) is int and receipt.sequence > state.last_sequence,
            'replayed or out-of-order receipt')
    require(0 <= now_ms - receipt.monotonic_ms <= policy.maximum_observation_ms,
            'receipt stale or from future')
    s = replace(state, last_ms=now_ms, last_sequence=receipt.sequence)
    require(state.phase not in (Phase.RELEASED, Phase.QUARANTINED), 'terminal state')
    if now_ms >= state.deadline_ms and state.phase not in (Phase.STOPPING, Phase.STOPPED_HELD):
        return replace(s, phase=Phase.STOPPING, reason='startup deadline')
    if event == 'arm':
        require(state.phase == Phase.CREATED_OFF and receipt.issuer == 'host-guardian', 'unexpected arm')
        require(receipt.data.get('live_instance') is True and receipt.data.get('independent_deadline_live') is True
                and receipt.data.get('start_fence_armed') is True
                and receipt.data.get('deadline_ms') == state.deadline_ms, 'guardian not independently armed')
        return replace(s, phase=Phase.ARMED)
    if event == 'start':
        require(state.phase == Phase.ARMED and receipt.issuer == 'host-controller', 'start without guardian')
        require(receipt.data.get('owned_start_worker_bound') is True, 'unfenced start worker')
        return replace(s, phase=Phase.STARTING)
    if event == 'observe':
        require(state.phase in (Phase.ARMED, Phase.STARTING, Phase.READY_TRIAL)
                and receipt.issuer == 'host-guardian', 'unexpected resource observation')
        o = receipt.data.get('observation')
        require(isinstance(o, Observation), 'typed resource observation required')
        try:
            o.validate(state.identity, now_ms, policy.maximum_observation_ms)
            require(o.existing_vm_set_sha256 == state.baseline_vm_sha256
                    and o.existing_process_set_sha256 == state.baseline_process_sha256
                    and o.pending_sha256 == state.baseline_pending_sha256,
                    'unreviewed workload change')
            require(o.boot_file_sha256 == state.boot_sha256, 'boot artifact changed')
            # OS free already reflects resident RPC memory. Reserve only remaining
            # guest/support capacity; keep the full conservative prospective allowance.
            remaining = GUEST - o.owned_memory_bytes + SUPPORT - o.support_charged_bytes
            require(o.physical_free_bytes >= remaining + PENDING + HOST_FLOOR + VARIATION,
                    'running host headroom insufficient')
            require(o.disk_free_bytes >= DISK_FLOOR + policy.disk_margin_bytes,
                    'disk growth guard')
        except Refusal as error:
            return replace(s, phase=Phase.STOPPING, reason=str(error))
        return s
    if event == 'ready':
        require(state.phase == Phase.STARTING and receipt.issuer == 'qualified-readiness-verifier',
                'unexpected readiness authority')
        require(receipt.data.get('verified_chain_set') == ('l1-execution', 'l1-consensus', 'base-execution', 'base-rollup')
                and receipt.data.get('guardian_live') is True and receipt.data.get('resource_receipt_current') is True
                and receipt.data.get('attachment_fenced') is True, 'incomplete whole-stack readiness')
        return replace(s, phase=Phase.READY_TRIAL)
    if event == 'fail':
        require(receipt.issuer in ('host-controller', 'host-guardian', 'independent-deadline'), 'wrong failure issuer')
        return replace(s, phase=Phase.STOPPING, reason='bounded trial failure')
    if event == 'off':
        require(state.phase == Phase.STOPPING and receipt.issuer == 'host-guardian', 'unexpected off receipt')
        require(receipt.data.get('vm_state') == 'Off' and receipt.data.get('assigned_memory_bytes') == 0
                and receipt.data.get('start_worker_dead') is True and receipt.data.get('late_start_fenced') is True,
                'owned VM stop not proven')
        return replace(s, phase=Phase.STOPPED_HELD)
    if event == 'release':
        require(state.phase == Phase.STOPPED_HELD and receipt.issuer == 'host-controller', 'unexpected release')
        require(receipt.data.get('guest_write_fence_confirmed') is True
                and receipt.data.get('exporter_teardown_confirmed') is True
                and receipt.data.get('guardian_tasks_resolved') is True
                and receipt.data.get('retained_evidence_bound') is True, 'cleanup remains unresolved')
        return replace(s, phase=Phase.RELEASED)
    raise Refusal('unsupported lifecycle event')


def watchdog_tick(state, now_ms, policy):
    """Independent host timer path: it requires no response from the controller."""
    policy.validate()
    uint(now_ms, 'clock')
    if now_ms < state.last_ms:
        return replace(state, phase=Phase.QUARANTINED, reason='monotonic clock rollback')
    if state.phase in (Phase.RELEASED, Phase.QUARANTINED, Phase.STOPPED_HELD, Phase.STOPPING):
        return state
    if now_ms >= state.deadline_ms:
        return replace(state, phase=Phase.STOPPING, reason='startup deadline')
    if now_ms - state.last_ms > policy.sample_ms + policy.maximum_observation_ms:
        return replace(state, phase=Phase.STOPPING, reason='guardian observation missing')
    # Do not update last_ms: polling must not refresh an absent observation.
    return state
