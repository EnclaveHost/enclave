import errno
import importlib.util
import multiprocessing
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pads", Path(__file__).with_name("pad-bank.py"))
pads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pads)
MIB = 1024 ** 2


def state(unit, pid=None, active="active", sub="running", control="0"):
    return {unit: dict(Id=unit, ActiveState=active, SubState=sub,
                      MainPID=str(os.getpid() if pid is None else pid), ControlPID=control)}


def contender(directory, tag, ready, go, results):
    unit = f"m2-{tag}-1.service"
    def current():
        return {**state("m2-one-1.service", os.getpid() if tag == "one" else 99999),
                **state("m2-two-1.service", os.getpid() if tag == "two" else 99999)}
    ready.put(True)
    go.wait(10)
    with patch.object(pads, "unit_states", current):
        try:
            pads.Bank(directory).allocate(tag, unit, 2*MIB, 2*MIB, MIB)
            results.put("ok")
        except RuntimeError as e:
            results.put(str(e))


class PadBank(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bank = pads.Bank(self.tmp.name)
        self.unit = "m2-test-1.service"
        self.states = state(self.unit)
        self.mock = patch.object(pads, "unit_states", lambda: self.states)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def allocate(self, size=MIB, cap=8*MIB, floor=MIB):
        return self.bank.allocate("test", self.unit, size, cap, floor)

    def reap(self, states=None, stopping=None):
        with self.bank.locked():
            self.bank.reap_locked(self.states if states is None else states, stopping)

    def test_reserves_full_size_and_cleans_immediately_when_dead(self):
        p = self.allocate()
        self.assertEqual(p.stat().st_size, MIB)
        self.assertGreaterEqual(p.stat().st_blocks * 512, MIB)
        self.reap({})
        self.assertFalse(p.exists())
        self.assertFalse(self.bank.metadata("test").exists())

    def test_active_and_activating_pads_survive_reaper(self):
        p = self.allocate()
        self.reap()
        self.reap(state(self.unit, active="activating", sub="start"))
        self.assertTrue(p.exists())

    def test_stop_post_only_reaps_exact_exited_unit(self):
        p = self.allocate()
        stopping = state(self.unit, pid=0, active="deactivating", sub="stop-post", control="123")
        self.reap(stopping)
        self.assertTrue(p.exists())
        self.reap(stopping, "m2-someother-1.service")
        self.assertTrue(p.exists())
        self.reap(stopping, self.unit)
        self.assertFalse(p.exists())

    def test_stop_post_never_reaps_live_main_process(self):
        p = self.allocate()
        self.reap(state(self.unit, active="deactivating", sub="stop-post"), self.unit)
        self.assertTrue(p.exists())

    def test_existing_pad_is_never_replaced(self):
        p = self.allocate()
        inode = p.stat().st_ino
        with self.assertRaises(FileExistsError):
            self.allocate()
        self.assertEqual(p.stat().st_ino, inode)

    def test_sparse_legacy_pad_counts_full_size_against_cap(self):
        p = self.bank.file("legacy")
        with p.open("wb") as f:
            f.truncate(8*MIB)
        with self.assertRaisesRegex(RuntimeError, "cap exceeded"):
            self.allocate()
        self.assertTrue(p.exists())  # No ownership record: don't delete legacy data.

    def test_sparse_existing_growth_included_in_headroom(self):
        with self.bank.file("legacy").open("wb") as f:
            f.truncate(3*MIB)
        usage = self.bank.usage()
        usage["available_bytes"] = pads.SLACK + 4*MIB
        with patch.object(self.bank, "usage", return_value=usage):
            with self.assertRaisesRegex(RuntimeError, "admission denied"):
                self.allocate()
        self.assertFalse(self.bank.file("test").exists())

    def test_low_disk_rejects_before_creating_any_pad(self):
        usage = self.bank.usage()
        usage["available_bytes"] = pads.SLACK + MIB
        with patch.object(self.bank, "usage", return_value=usage):
            with self.assertRaisesRegex(RuntimeError, "admission denied"):
                self.allocate()
        self.assertFalse(self.bank.file("test").exists())
        self.assertFalse(self.bank.metadata("test").exists())

    def test_headroom_lost_during_allocation_rolls_back(self):
        before = self.bank.usage()
        after = dict(before, available_bytes=0)
        with patch.object(self.bank, "usage", side_effect=[before, after]):
            with self.assertRaisesRegex(RuntimeError, "changed during"):
                self.allocate()
        self.assertFalse(self.bank.file("test").exists())
        self.assertFalse(self.bank.metadata("test").exists())

    def test_no_sparse_fallback_when_reservation_fails(self):
        with patch.object(pads, "reserve_blocks", side_effect=OSError(errno.ENOSPC, "full")):
            with self.assertRaises(OSError):
                self.allocate()
        self.assertFalse(self.bank.file("test").exists())
        self.assertFalse(self.bank.metadata("test").exists())

    def test_systemd_failure_does_not_delete_or_allocate(self):
        p = self.allocate()
        with patch.object(pads, "unit_states", side_effect=subprocess.CalledProcessError(1, "systemctl")):
            with self.assertRaises(subprocess.CalledProcessError):
                self.allocate()
        self.assertTrue(p.exists())

    def test_cannot_allocate_outside_the_vm_service(self):
        self.states = state(self.unit, pid=99999)
        with self.assertRaisesRegex(RuntimeError, "main process"):
            self.allocate()

    def test_symlink_and_hardlink_are_rejected_without_touching_target(self):
        target = Path(self.tmp.name) / "keep"
        target.write_text("keep")
        p = self.bank.file("legacy")
        p.symlink_to(target)
        with self.assertRaises(ValueError):
            self.allocate()
        p.unlink()
        os.link(target, p)
        with self.assertRaises(ValueError):
            self.allocate()
        self.assertEqual(target.read_text(), "keep")

    def test_inode_replacement_is_not_deleted(self):
        p = self.allocate()
        p.rename(p.with_suffix(".keep"))
        p.write_text("replacement")
        with self.assertRaisesRegex(ValueError, "inode changed"):
            self.reap({})
        self.assertEqual(p.read_text(), "replacement")

    def test_crashed_creation_intent_is_reclaimed(self):
        self.bank.write_record("test", dict(version=1, tag="test", unit=self.unit,
                                            size=MIB, inode=None))
        self.bank.file("test").write_bytes(b"")
        self.reap({})
        self.assertFalse(self.bank.file("test").exists())

    def test_live_hardlinked_pad_is_not_unlinked_and_evades_no_quota(self):
        p = self.allocate()
        os.link(p, Path(self.tmp.name) / "archive")
        with self.assertRaises(ValueError):
            self.reap({})
        self.assertTrue(p.exists())
        with self.assertRaises(ValueError):
            self.bank.usage()

    def test_concurrent_admissions_cannot_overcommit(self):
        ctx = multiprocessing.get_context("fork")
        ready, results, go = ctx.Queue(), ctx.Queue(), ctx.Event()
        workers = [ctx.Process(target=contender, args=(self.tmp.name, t, ready, go, results))
                   for t in ("one", "two")]
        for w in workers:
            w.start()
        for _ in workers:
            ready.get(timeout=10)
        go.set()
        answers = [results.get(timeout=15) for _ in workers]
        for w in workers:
            w.join(10)
            self.assertEqual(w.exitcode, 0)
        self.assertEqual(answers.count("ok"), 1)
        self.assertEqual(sum("cap exceeded" in a for a in answers), 1)
        self.assertEqual(self.bank.usage()["logical_bytes"], 2*MIB)

    def test_systemd_command_escaping(self):
        self.assertEqual(pads.systemd_quote('a%"b\\c$d'), '"a%%\\"b\\\\c$d"')

    def test_adoption_preserves_data_and_reserves_holes(self):
        p = self.bank.file("test")
        with p.open("w+b") as f:
            f.write(b"encrypted-canary")
            f.truncate(MIB)
            f.flush()
            self.bank.adopt("test", self.unit, 8*MIB, MIB)
            self.assertGreaterEqual(p.stat().st_blocks*512, MIB)
            f.seek(0)
            self.assertEqual(f.read(16), b"encrypted-canary")
        self.reap({})
        self.assertFalse(p.exists())

    def test_adoption_rejects_file_not_held_by_unit(self):
        p = self.bank.file("test")
        p.write_text("keep")
        with self.assertRaisesRegex(RuntimeError, "does not hold"):
            self.bank.adopt("test", self.unit, 8*MIB, MIB)
        self.assertEqual(p.read_text(), "keep")

    def test_adoption_failure_never_deletes_live_data(self):
        p = self.bank.file("test")
        with p.open("w+b") as f:
            f.write(b"keep")
            f.flush()
            with patch.object(pads, "reserve_blocks", side_effect=OSError(errno.ENOSPC, "full")):
                with self.assertRaises(OSError):
                    self.bank.adopt("test", self.unit, 8*MIB, MIB)
            self.assertEqual(p.read_bytes(), b"keep")
            self.assertTrue(self.bank.metadata("test").exists())


if __name__ == "__main__":
    unittest.main()
