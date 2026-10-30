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
 def test_array_override_cannot_hide_after_confirmation(self):
  rows=copy.deepcopy(self.fixture.rows)
  rows.append(dict(rows[-1],MESSAGE=list(b'<jemalloc>: -- Set conf value: narenas:16')))
  with self.assertRaises(AssertionError):self.fixture.parse(rows)
 def test_bad_arrays_fail_closed(self):
  for message in [[True],[256],[-1],[1.0],[[65]],[255],[65]*8193]:
   rows=copy.deepcopy(self.fixture.rows);rows.append({'MESSAGE':message})
   with self.subTest(message=str(message[:2])),self.assertRaises((AssertionError,UnicodeDecodeError)):self.fixture.parse(rows)
 def test_array_initializer_retains_identity_refusal(self):
  rows=copy.deepcopy(self.fixture.rows)
  for row in rows:row['MESSAGE']=list(row['MESSAGE'].encode())
  rows[-1]['_PID']='999'
  with self.assertRaisesRegex(AssertionError,'pid'):self.fixture.parse(rows)
