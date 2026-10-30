import ast, json, unittest
from pathlib import Path
from unittest.mock import patch
import test_chain_service as original
c=original.c
PROFILE=json.loads(Path('PROFILE.json').read_text())
class MemoryTests(unittest.TestCase):
 def test_exact_options_supported_and_bound(self):
  for name in ('base','reth','lighthouse'):
   with self.subTest(name=name):
    with patch.object(c,'MANIFEST',{'binaries':PROFILE['exactPayloadBinaryHashes']}):
     self.assertEqual(c.low_memory_args(name,[]),PROFILE[name]['cli'])
    with patch.object(c,'MANIFEST',{'binaries':{name:'0'*64}}):
     with self.assertRaisesRegex(AssertionError,'not reviewed'):c.low_memory_args(name,[])
 def test_existing_options_cannot_be_silently_overridden(self):
  with patch.object(c,'MANIFEST',{'binaries':PROFILE['exactPayloadBinaryHashes']}):
   for name in ('base','reth','lighthouse'):
    for flag in PROFILE[name]['cli'][::2]:
     with self.subTest(name=name,flag=flag),self.assertRaisesRegex(AssertionError,'duplicate'):c.low_memory_args(name,[flag,'999'])
 def test_all_original_functions_preserved(self):
  before=ast.parse(Path('baseline-chain_service.py').read_text());after=ast.parse(Path('chain_service.py').read_text())
  old={x.name:x for x in before.body if isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef))}
  new={x.name:x for x in after.body if isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef))}
  self.assertEqual(set(new)-set(old),{'low_memory_args'})
  for name,fn in old.items():
   target=new[name]
   if name=='run':
    added=[x for x in target.body if isinstance(x,ast.AugAssign) and isinstance(x.value,ast.Call) and isinstance(x.value.func,ast.Name) and x.value.func.id=='low_memory_args']
    self.assertEqual(len(added),1);target.body.remove(added[0])
   self.assertEqual(ast.dump(fn),ast.dump(target),name)
 def test_reth_exec_preserves_environment_and_proofs(self):
  with patch.object(c,'mount',return_value='/srv/enclave-l1-pair'),patch.object(c,'binary',return_value='/pinned/reth'),patch.object(Path,'is_file',return_value=True),patch.object(Path,'read_text',return_value=original.SNAPSHOT_PROFILE),patch.object(c.os,'execve',side_effect=original.Executed) as exe:
   with self.assertRaises(original.Executed):c.run('el')
   argv=exe.call_args.args[1];env=exe.call_args.args[2]
   self.assertEqual(argv[-len(PROFILE['reth']['cli']):],PROFILE['reth']['cli'])
   self.assertEqual(argv[argv.index('--rpc.eth-proof-window')+1],'256')
   self.assertEqual(argv[argv.index('--rpc.proof-permits')+1],'2')
   self.assertIn('--prune.receipts.distance',argv)
   self.assertEqual(set(env),{'PATH','LANG','HOME','TMPDIR'})
