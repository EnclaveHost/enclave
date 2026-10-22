import pathlib,importlib.util,json,shutil,sys
P=pathlib.Path(__file__).resolve().parent
PKG=P.parents[1]
s=importlib.util.spec_from_file_location('h',PKG/'tools/cutover-mock-test.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.T=P
m.SCRIPT=P.parent/'975f097470eef7f386fd60379fafd216e449da93117188549e2760b7b0b367dd-node-hold-cutover.ps1'
r=m.world()
try:
 lines,c=m.run(r,m.params(r,'root-restore-cas-conflict'),scenario='net-ignores-wallet')
 cfg=json.loads((r/'network/privacy-config.json').read_text())
 out={'returncode':c.returncode,'final':m.final(lines),'steps':lines,
      'localFlagStillSet':b'ENCLAVE_NETWORK_WALLET_HOLD=1' in (r/'node-config.local.cmd').read_bytes(),
      'networkStillEnforces':bool(cfg['enclaveNetwork'].get('walletAdmission')),
      'nodeStarts':(r/'node-starts.txt').read_text().count('start') if (r/'node-starts.txt').exists() else 0,
      'stderr':c.stderr[-1000:]}
 out['unsafeMismatchReproduced']=out['localFlagStillSet'] and not out['networkStillEnforces'] and out['nodeStarts']>0
 (P/'evidence.json').write_text(json.dumps(out,indent=2)+'\n')
 print(json.dumps({k:v for k,v in out.items() if k not in ['steps','stderr']},indent=2))
 sys.exit(0 if out['unsafeMismatchReproduced'] else 1)
finally:
 shutil.rmtree(r)
