import unittest,copy
import test_allocator
class RootJournal(unittest.TestCase):
 def setUp(self):
  self.fixture=test_allocator.Confirmation();self.fixture.setUp()
 def test_initializer_byte_arrays_keep_exact_identity_checks(self):
  rows=copy.deepcopy(self.fixture.rows)
  for row in rows:row['MESSAGE']=list(row['MESSAGE'].encode())
  self.assertTrue(self.fixture.parse(rows)['verified'])
 def test_unrelated_ansi_byte_array_does_not_erase_valid_confirmation(self):
  rows=copy.deepcopy(self.fixture.rows)
  rows.append({'MESSAGE':list(b'\x1b[32mLighthouse startup\x1b[0m')})
  self.assertTrue(self.fixture.parse(rows)['verified'])
