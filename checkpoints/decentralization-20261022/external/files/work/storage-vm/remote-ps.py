import subprocess,base64,sys
from pathlib import Path
s=Path(sys.argv[1]).read_text()
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell -NoProfile -EncodedCommand '+base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True)
sys.stdout.buffer.write(r.stdout);sys.exit(r.returncode)
