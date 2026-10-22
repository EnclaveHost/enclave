"""Prepare (do not push) the exact control candidate on the existing public main lineage."""
import pathlib,subprocess,json,os
root=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo');repo=root/'work/source-checkpoint-20261022/main-repo';out=root/'work/resume-after-checkpoint-20261022/production-run'
parent='7752a4239b3bec2cf452491cd1b95164a8c2bdb8';source='3031c20c7d0083f05b36160c851e5872a72725c3';checkpoint='4f84f213cf3d15716af90cc25728282c60330d7d';branch='candidate/decentralized-control-20261022'
index=out/'candidate.index';assert not index.exists()
env={**os.environ,'GIT_INDEX_FILE':str(index),'GIT_AUTHOR_NAME':'SteveDeFacto','GIT_AUTHOR_EMAIL':'5148995+SteveDeFacto@users.noreply.github.com','GIT_COMMITTER_NAME':'SteveDeFacto','GIT_COMMITTER_EMAIL':'5148995+SteveDeFacto@users.noreply.github.com'}
def git(*a,**kw):return subprocess.check_output(['git',*a],cwd=repo,env=env,**kw).decode().strip()
assert subprocess.run(['git','show-ref','--verify','--quiet','refs/heads/'+branch],cwd=repo).returncode==1
git('read-tree',source)
# Keep source-preservation discoveries that were absent from the older reconciled base. These are outside the image inputs.
restored=['.gitleaks.toml','test/helpers/platform-policy-world.mjs','test/platform-policy-world-blocks.test.mjs','isolation/m2/encvol/roots/cacert-2026-09-25.pem']
for p in restored:
 mode,typ,blob,path=git('ls-tree',checkpoint,'--',p).split(None,3);assert typ=='blob' and path==p
 git('update-index','--add','--cacheinfo',mode,blob,p)
tree=git('write-tree')
message='Compose distributed control image with Platform API and MCP\n\nIncludes verified runtime bundles, no provider policy mirrors, explicit attestation compatibility, complete MCP runtime files, and supervisor module closure. Restores pinned CA data and immutable-block fixture from the source checkpoint. This is a release candidate; live activation and provider cutover remain pending.\n'
commit=git('commit-tree',tree,'-p',parent,input=message.encode())
git('update-ref','refs/heads/'+branch,commit,'0'*40)
r={'branch':branch,'commit':commit,'tree':tree,'parent':parent,'workerSourceTree':source,'restoredFromCheckpoint':restored,'checkpoint':checkpoint,'status':'Prepared locally; secret scans and remote publication pending. Runtime image input bytes unchanged from tree-c.'}
(out/'candidate-source.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
