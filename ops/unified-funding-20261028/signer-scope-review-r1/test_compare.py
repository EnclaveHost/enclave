import importlib.util, pathlib, unittest, json
spec=importlib.util.spec_from_file_location("candidate",pathlib.Path(__file__).with_name("compare.py"));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=b"0x"+b"00"*31+b"01";b=b"0x"+b"00"*31+b"02"
def env(x,y):return b"SESSIONS_RELAYER_KEY="+x+b"\0HOST_SPONSOR_BUNDLER_KEY="+y+b"\0"
class Tests(unittest.TestCase):
 def test_absent(self):self.assertIsNone(m.compare(b"")["samePrivateKey"])
 def test_equal(self):self.assertTrue(m.compare(env(a,a))["samePrivateKey"])
 def test_different(self):self.assertFalse(m.compare(env(a,b))["samePrivateKey"])
 def test_encoding(self):self.assertTrue(m.compare(env(b"AB"*32,b"0x"+b"ab"*32))["samePrivateKey"])
 def test_invalid(self):self.assertIsNone(m.compare(env(a,b"not a key"))["samePrivateKey"])
 def test_zero(self):self.assertFalse(m.compare(env(a,b"00"*32))["sponsorValid"])
 def test_range(self):self.assertFalse(m.compare(env(a,b"ff"*32))["sponsorValid"])
 def test_duplicates(self):
  with self.assertRaises(ValueError):m.compare(env(a,b)+b"SESSIONS_RELAYER_KEY="+a)
 def test_no_values(self):
  out=m.compare(env(a,b));self.assertTrue(all(type(x) in [bool,type(None)] for x in out.values()));self.assertNotIn(a.decode(),json.dumps(out))
unittest.main()
