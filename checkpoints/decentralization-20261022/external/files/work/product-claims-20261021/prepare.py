import pathlib,subprocess
P=pathlib.Path(__file__).resolve().parent;R=P/'repo';OLD=P.parent/'Cloud Provider-lowercase-cleanup-20261021/rewritten.git'
subprocess.run(['git','clone','--no-hardlinks','--no-checkout','--single-branch','--branch','main',str(OLD),str(R)],check=True)
subprocess.run(['git','-C',str(R),'remote','set-url','origin','https://github.com/EnclaveHost/enclave.git'],check=True)
subprocess.run(['git','-C',str(R),'config','core.sparseCheckout','true'],check=True)
(R/'.git/info/sparse-checkout').write_text('/PRODUCT.md\n/README.md\n')
subprocess.run(['git','-C',str(R),'checkout','main'],check=True)
subprocess.run(['git','-C',str(R),'config','user.name','SteveDeFacto'],check=True)
subprocess.run(['git','-C',str(R),'config','user.email','5148995+SteveDeFacto@users.noreply.github.com'],check=True)
subprocess.run(['git','-C',str(R),'config','pack.threads','1'],check=True)
