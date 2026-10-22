import importlib.util, pathlib, shutil, stat, sys, unittest
p=pathlib.Path(__file__).with_name('cutover-mock-test.py')
spec=importlib.util.spec_from_file_location('cutover_fixture',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Preparation(unittest.TestCase):
 def setUp(self): self.r=m.world()
 def tearDown(self): shutil.rmtree(self.r,ignore_errors=True)
 def editor(self, change=False):
  f=self.r/'checked-editor.py'
  f.write_text('#!'+sys.executable+'\n'+'''import pathlib,json,subprocess,sys
r=pathlib.Path(__file__).parent
p=r/'procs-state.json'
if not p.exists():p=r/'procs.json'
rows=json.loads(p.read_text())
assert any('node\\\\agent.mjs' in x['cmd'] for x in rows), 'original node must still be running while rendering'
(r/'editor-saw-running.txt').write_text('yes')
rc=subprocess.run(['''+repr(shutil.which('node'))+''']+sys.argv[1:]).returncode
'''+('''cfg=pathlib.Path(sys.argv[3]);d=json.loads(cfg.read_text());d['operatorEdit']='preserve';cfg.write_text(json.dumps(d))
''' if change else '')+'''sys.exit(rc)
''')
  f.chmod(f.stat().st_mode|stat.S_IEXEC);return f
 def test_renderer_runs_before_the_node_is_stopped(self):
  lines,c=m.run(self.r,m.params(self.r,'prepare-live',testNode=str(self.editor())))
  self.assertTrue(m.final(lines).startswith('DONE:'),(m.final(lines),c.stderr[-500:]))
  self.assertTrue((self.r/'editor-saw-running.txt').exists())
 def test_operator_edit_during_preparation_refuses_before_stop(self):
  lines,c=m.run(self.r,m.params(self.r,'prepare-drift',testNode=str(self.editor(True))))
  self.assertTrue(m.final(lines).startswith('REFUSED: a config changed'),(m.final(lines),c.stderr[-500:]))
  self.assertTrue(m.node_running(self.r));self.assertEqual(m.starts(self.r),0)
  self.assertIn('operatorEdit',(self.r/'network/privacy-config.json').read_text())
  self.assertFalse(m.flag(self.r));self.assertFalse(m.block(self.r));self.assertEqual(m.temps(self.r),[])
if __name__=='__main__':unittest.main()
