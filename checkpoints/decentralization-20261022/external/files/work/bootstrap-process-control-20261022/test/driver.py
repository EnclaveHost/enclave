import importlib.util,pathlib,unittest,tempfile,json
N=pathlib.Path(__file__).resolve().parent.parent/'native'
s=importlib.util.spec_from_file_location('driver', N/'run-native.py'); d=importlib.util.module_from_spec(s); s.loader.exec_module(d)
class Tests(unittest.TestCase):
 def test_pins(self):
  self.assertEqual(d.check_local(),{})
  fx=(N/'native-bootstrap.ps1').read_text()
  for f,h in d.FILES.items():
   if f!='native-bootstrap.ps1':self.assertIn("'%s' = '%s'"%(f.replace('/',chr(92)),h),fx)
 def test_no_global_scan(self):
  fx=(N/'native-bootstrap.ps1').read_text()
  for bad in ['Get-CimInstance','Get-Process','CommandLine LIKE','Find-Own','bounded-query']:
   self.assertNotIn(bad,fx)
  self.assertLess(fx.index('New-Object Enclave.Testing.FixtureJob'),fx.index('$jbuild = Invoke-Step'))
 def test_plan_bounds(self):
  plan=d.plan({}); self.assertEqual(plan['localMismatches'],{})
  self.assertLess(max(plan['encodedSizes'].values()),d.ENCODED_LIMIT)
  self.assertNotRegex(str(plan['texts']),r'(?<!Get)-ExecutionPolicy')
 def test_unknown_does_not_delete(self):
  calls=[]
  class Fake:
   def ps(self,text,secs):
    calls.append(text)
    if 'New-Item' in text:return {'created':text.split("'")[1]}
    return {'status':'UNKNOWN','pass':False,'childExitUnknown':True}
  with tempfile.TemporaryDirectory() as t:
   r,ok=d.execute(Fake(),lambda *args:None,rec=pathlib.Path(t))
   self.assertFalse(ok);self.assertEqual(len(calls),2);self.assertIn('skipped',r['cleanup'])
 def test_one_attempt(self):
  with tempfile.TemporaryDirectory() as t:
   (pathlib.Path(t)/d.ATTEMPT).write_text('{}')
   with self.assertRaises(FileExistsError):d.execute(None,None,rec=pathlib.Path(t))
 def test_unconfirmed_creation_never_deletes(self):
  for response in [RuntimeError('stage exists'), None, {'created':'different-stage'}]:
   with self.subTest(response=response), tempfile.TemporaryDirectory() as t:
    calls=[]
    class Fake:
     def ps(self,text,secs):
      calls.append(text)
      if isinstance(response,Exception):raise response
      return response
    def no_upload(*args):raise AssertionError('must not upload')
    r,ok=d.execute(Fake(),no_upload,rec=pathlib.Path(t))
    self.assertFalse(ok);self.assertEqual(len(calls),1)
    self.assertIn('ownership unknown',r['cleanup']['skipped'])
    self.assertEqual(json.loads((pathlib.Path(t)/d.RESULT).read_text())['cleanup'],r['cleanup'])
 def test_confirmed_stage_upload_failure_can_clean(self):
  calls=[]
  class Fake:
   def ps(self,text,secs):
    calls.append(text)
    if 'New-Item' in text:return {'created':text.split("'")[1]}
    return {'gone':True}
  def bad_upload(*args):raise RuntimeError('upload failed')
  with tempfile.TemporaryDirectory() as t:
   r,ok=d.execute(Fake(),bad_upload,rec=pathlib.Path(t))
   self.assertFalse(ok);self.assertEqual(len(calls),2)
   self.assertIn('Remove-Item',calls[-1]);self.assertTrue(r['cleanup']['gone'])
unittest.main(verbosity=2)
