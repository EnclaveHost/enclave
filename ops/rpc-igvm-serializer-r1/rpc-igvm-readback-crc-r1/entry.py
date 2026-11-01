from pathlib import Path
import importlib.util,hashlib,json,unittest
s=importlib.util.spec_from_file_location('test_rpc_igvm_build','/src/test/rpc-server/test_rpc_igvm_build.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
suite=unittest.TestSuite(m.RpcIgvmBuild(n) for n in ('test_platform_and_truncation_refuse','test_header_corruption_refused_by_crc'));result=unittest.TextTestRunner(verbosity=2).run(suite);assert result.wasSuccessful()
golden=Path('/golden.bin');before=m.build.describe(golden);assert before['sha256']=='c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec'
header=m.build.check_igvm(golden);assert m.build.describe(golden)==before
r={'tests':2,'golden':before,'header':header,'newGeneratorQualified':False,'hardwareQualified':False};Path('/output/READBACK.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
